// The provider behind the gateway: the official Anthropic SDK, or a deterministic fake for every test (D8, #605).
// Since #669 a request may carry tools and the turns of a tool-use run; the answer carries the tool calls the model
// asked for and its content blocks, opaque, to be sent back unchanged in the next turn.
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { AiConfigError, AiTransportError } from './errors.js';
import type { TokenUsage } from './models.js';

/** A JSON Schema for a tool's input; the API requires an object schema. */
export interface JsonSchemaObject {
  type: 'object';
  [keyword: string]: unknown;
}

export interface AiTool {
  /** `^[a-z][a-z0-9_]{0,63}$` (checked by the gateway). */
  name: string;
  description: string;
  /** Sent as the tool's `input_schema`. */
  inputSchema: JsonSchemaObject;
}

/** A tool call the model asked for. `input` is the model's output: the caller validates it before acting on it. */
export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** One tool result sent back to the model (after the gateway's denylist check and redaction). */
export interface AiToolResultBlock {
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * The exact content blocks of one assistant answer, owned by the transport that produced them. The gateway never
 * reads, logs or audits them; it sends them back unchanged in the next turn of a tool-use run (thinking blocks and
 * their signatures must return verbatim, and the request may only grow by appending).
 */
export interface AiAssistantContent {
  readonly transport: 'anthropic' | 'fake';
  readonly blocks: readonly unknown[];
}

/** A turn after the first user message of a tool-use run. */
export type AiTurn =
  | { role: 'assistant'; content: AiAssistantContent }
  | { role: 'user'; toolResults: readonly AiToolResultBlock[] };

export interface AiRequest {
  model: string;
  system: string;
  /** The rendered first user message. */
  user: string;
  /** The turns after `user` (tool-use runs only, #669). */
  turns?: readonly AiTurn[];
  /** The tools the model may call (tool-use runs only, #669). */
  tools?: readonly AiTool[];
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  /** Ask for the API's server-side refusal fallback (`fallbacks: "default"`). */
  fallbacks: boolean;
}

export interface AiResponse {
  /** The text blocks of the answer, joined. */
  text: string;
  /** The tool calls the model asked for, in order (empty for a plain answer). */
  toolUse: AiToolCall[];
  /** The answer's content blocks, opaque; the next turn of a tool-use run sends them back unchanged. */
  assistantContent: AiAssistantContent;
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
/** The only API host the transport talks to; never read from the environment. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

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

/** The Messages API `messages` for a request: the first user message, then the tool-use turns. */
function toMessages(req: AiRequest): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.user }];
  for (const turn of req.turns ?? []) {
    if (turn.role === 'assistant') {
      if (turn.content.transport !== 'anthropic') {
        throw new AiConfigError('an assistant turn from another transport cannot be sent back');
      }
      messages.push({
        role: 'assistant',
        content: turn.content.blocks as Anthropic.ContentBlockParam[],
      });
    } else {
      messages.push({
        role: 'user',
        content: turn.toolResults.map((r): Anthropic.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: r.toolUseId,
          content: r.content,
          is_error: r.isError,
        })),
      });
    }
  }
  return messages;
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
    // explicit, because the SDK would otherwise take ANTHROPIC_BASE_URL from the process environment
    baseURL: ANTHROPIC_API_URL,
    timeout: opts.timeoutMs ?? 60_000,
    maxRetries: opts.maxRetries ?? 2,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return {
    kind: 'anthropic',
    async complete(req) {
      try {
        const base = {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: toMessages(req),
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t): Anthropic.Tool => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
          // thinking stays adaptive (the default on the 5.5 models); effort is the depth/cost control
          output_config: { effort: req.effort },
        };
        const msg = req.fallbacks
          ? await client.beta.messages.create({
              ...(base as Anthropic.Beta.MessageCreateParamsNonStreaming),
              betas: [FALLBACK_BETA],
              fallbacks: 'default',
            })
          : await client.messages.create(base);
        let text = '';
        const toolUse: AiToolCall[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') text += block.text;
          else if (block.type === 'tool_use')
            toolUse.push({ id: block.id, name: block.name, input: block.input });
        }
        const details = (msg as { stop_details?: { category?: string | null } | null })
          .stop_details;
        return {
          text,
          toolUse,
          assistantContent: { transport: 'anthropic', blocks: msg.content },
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
        if (err instanceof AiConfigError) throw err;
        throw new AiTransportError(errorClassOf(err), { cause: err });
      }
    },
  };
}

/** One scripted answer of the fake. `toolUse` ids default to `toolu_fake_<call>_<index>`. */
export interface FakeStep extends Partial<
  Omit<AiResponse, 'toolUse' | 'assistantContent' | 'usage'>
> {
  toolUse?: ReadonlyArray<{ name: string; input: unknown; id?: string }>;
  usage?: Partial<TokenUsage>;
}

/** A step of the script: an answer, a function of the request (to react to a tool result), or an Error to throw. */
export type FakeScriptStep =
  FakeStep | Error | ((req: AiRequest, n: number) => FakeStep | Error | undefined);

export interface FakeTransportOptions {
  /** Answers in call order; a call past the end gets the default answer. */
  script: readonly FakeScriptStep[];
}

export interface FakeTransport extends AiTransport {
  /** Every request, in order (system, user, turns, tools), for assertions. */
  readonly calls: AiRequest[];
}

/**
 * Deterministic fake: the same request always gives the same answer and usage, and nothing leaves the process.
 * - `createFakeTransport(fn)`: `fn(req, n)` may return a partial answer (a refusal, a truncation, tool calls) or an
 *   Error to throw, for call n (0-based).
 * - `createFakeTransport({ script })`: recorded steps replayed in order (#669), e.g.
 *   `[{ toolUse: [{ name: 'query_metrics', input }] }, { text: 'Refunds were … [q1]' }]`.
 */
export function createFakeTransport(
  script?: ((req: AiRequest, n: number) => FakeStep | Error | undefined) | FakeTransportOptions,
): FakeTransport {
  const calls: AiRequest[] = [];
  const stepFor = (req: AiRequest, n: number): FakeStep | Error | undefined => {
    if (typeof script === 'function') return script(req, n);
    const s = script?.script[n];
    return typeof s === 'function' ? s(req, n) : s;
  };
  return {
    kind: 'fake',
    calls,
    async complete(req) {
      const n = calls.length;
      calls.push(req);
      const step = stepFor(req, n);
      if (step instanceof Error) throw new AiTransportError(step.name, { cause: step });
      const turns = req.turns?.length ? `\n${JSON.stringify(req.turns)}` : '';
      const digest = createHash('sha256')
        .update(`${req.model}\n${req.system}\n${req.user}${turns}`)
        .digest('hex');
      const toolUse = (step?.toolUse ?? []).map((t, i) => ({
        id: t.id ?? `toolu_fake_${n}_${i}`,
        name: t.name,
        input: t.input,
      }));
      const text =
        step?.text ?? (toolUse.length ? '' : `[fake ${req.model}] draft ${digest.slice(0, 12)}`);
      const { toolUse: _t, usage, ...rest } = step ?? {};
      return {
        text,
        toolUse,
        assistantContent: {
          transport: 'fake',
          blocks: [
            ...(text ? [{ type: 'text', text }] : []),
            ...toolUse.map((t) => ({ type: 'tool_use', ...t })),
          ],
        },
        servedModel: req.model,
        stopReason: toolUse.length ? 'tool_use' : 'end_turn',
        refusalCategory: null,
        ...rest,
        usage: {
          inputTokens: Math.ceil((req.system.length + req.user.length + turns.length) / 4),
          outputTokens: Math.min(req.maxTokens, 24),
          cacheReadTokens: 0,
          ...usage,
        },
      };
    },
  };
}
