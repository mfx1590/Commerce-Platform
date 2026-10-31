// The provider behind the gateway: the official Anthropic SDK, or a deterministic fake for every test (D8, #605).
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { AiConfigError, AiTransportError } from './errors.js';
import type { TokenUsage } from './models.js';

export interface AiRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  /** Ask for the API's server-side refusal fallback (`fallbacks: "default"`). */
  fallbacks: boolean;
}

export interface AiResponse {
  text: string;
  /** The model that produced the answer (differs from the request after a server-side fallback). */
  servedModel: string;
  stopReason: string | null;
  /** Set only when stopReason is `refusal`: the category, never the explanation. */
  refusalCategory: string | null;
  usage: TokenUsage;
}

export interface AiTransport {
  readonly kind: 'anthropic' | 'fake';
  complete(req: AiRequest): Promise<AiResponse>;
}

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The SDK's error class name (e.g. `RateLimitError`), for the audit row; never the message. */
export function errorClassOf(err: unknown): string {
  if (err instanceof Anthropic.APIError || err instanceof Anthropic.AnthropicError)
    return err.constructor.name;
  if (err instanceof Error) return err.name || 'Error';
  return 'Error';
}

export interface AnthropicTransportOptions {
  /** Default: process.env. Only `AI_ANTHROPIC_API_KEY` is read — never `ANTHROPIC_API_KEY`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the SDK's fetch (the gateway's tests never touch the network). */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 60 s. */
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * The real transport. The key is read from `AI_ANTHROPIC_API_KEY` ONLY and passed to the SDK explicitly: with an
 * explicit `apiKey` the SDK reads no ambient credential (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, a CLI
 * profile), so a developer's Claude Code key can never be billed by the platform, and a missing key is a
 * configuration error instead of a silent fallback to someone else's credentials.
 */
export function createAnthropicTransport(opts: AnthropicTransportOptions = {}): AiTransport {
  const env = opts.env ?? process.env;
  const apiKey = env.AI_ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new AiConfigError(
      'AI_ANTHROPIC_API_KEY is not set (the gateway never uses ANTHROPIC_API_KEY)',
    );
  }
  const client = new Anthropic({
    apiKey,
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    kind: 'anthropic',
    async complete(req) {
      const base = {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user' as const, content: req.user }],
        // thinking stays adaptive (the default on the 5.5 models); effort is the depth/cost control
        output_config: { effort: req.effort },
      };
      try {
        const msg = req.fallbacks
          ? await client.beta.messages.create({
              ...base,
              betas: [FALLBACK_BETA],
              fallbacks: 'default',
            })
          : await client.messages.create(base);
        let text = '';
        for (const block of msg.content) if (block.type === 'text') text += block.text;
        const details = (msg as { stop_details?: { category?: string | null } | null })
          .stop_details;
        return {
          text,
          servedModel: msg.model,
          stopReason: msg.stop_reason,
          refusalCategory: msg.stop_reason === 'refusal' ? (details?.category ?? null) : null,
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
          },
        };
      } catch (err) {
        throw new AiTransportError(errorClassOf(err), { cause: err });
      }
    },
  };
}

export interface FakeTransport extends AiTransport {
  readonly calls: AiRequest[];
}

/**
 * Deterministic fake: the same request always gives the same answer and usage, and nothing leaves the process.
 * `script(req, n)` may return a partial response (a refusal, a truncation) or an Error to throw, for call n (0-based).
 */
export function createFakeTransport(
  script?: (req: AiRequest, n: number) => Partial<AiResponse> | Error | undefined,
): FakeTransport {
  const calls: AiRequest[] = [];
  return {
    kind: 'fake',
    calls,
    async complete(req) {
      const n = calls.length;
      calls.push(req);
      const scripted = script?.(req, n);
      if (scripted instanceof Error) throw new AiTransportError(scripted.name, { cause: scripted });
      const digest = createHash('sha256')
        .update(`${req.model}\n${req.system}\n${req.user}`)
        .digest('hex');
      return {
        text: `[fake ${req.model}] draft ${digest.slice(0, 12)}`,
        servedModel: req.model,
        stopReason: 'end_turn',
        refusalCategory: null,
        usage: {
          inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
          outputTokens: Math.min(req.maxTokens, 24),
          cacheReadTokens: 0,
        },
        ...scripted,
      };
    },
  };
}
