// The real Anthropic transport, exercised through the SDK with an injected fetch: the request shape and the
// credentials are checked, and nothing leaves the process. Test keys are words, never secret-shaped.
import { describe, expect, it } from 'vitest';
import {
  AiConfigError,
  AiTransportError,
  createAnthropicTransport,
  createFakeTransport,
  FALLBACK_BETA,
  type AiRequest,
} from '../src/index.js';

const KEY = 'test-key-alpha';
const req: AiRequest = {
  model: 'claude-sonnet-5-5',
  system: 'You write product copy.',
  user: 'Product: Linen shirt',
  maxTokens: 300,
  effort: 'low',
  fallbacks: false,
};

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function stubFetch(reply: { status?: number; json: unknown }, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_alpha',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'text', text: 'A soft linen shirt.' },
    { type: 'text', text: ' Breathes well.' },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 21,
    output_tokens: 9,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 0,
  },
  ...over,
});

describe('createAnthropicTransport', () => {
  it('uses AI_ANTHROPIC_API_KEY only; refuses without it even when ANTHROPIC_API_KEY is set', () => {
    expect(() => createAnthropicTransport({ env: {} })).toThrow(AiConfigError);
    expect(() =>
      createAnthropicTransport({ env: { ANTHROPIC_API_KEY: 'ambient-ambient-ambient' } }),
    ).toThrow(/AI_ANTHROPIC_API_KEY is not set/);
    expect(() => createAnthropicTransport({ env: { AI_ANTHROPIC_API_KEY: '   ' } })).toThrow(
      AiConfigError,
    );
  });

  it('sends the key it was given (never an ambient one), the model, the cap, effort, the prompt — and no temperature', async () => {
    const seen: Seen[] = [];
    const t = createAnthropicTransport({
      env: {
        AI_ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_API_KEY: 'ambient-ambient-ambient',
        ANTHROPIC_AUTH_TOKEN: 'other-words',
      },
      fetch: stubFetch({ json: message() }, seen),
      maxRetries: 0,
    });
    const r = await t.complete(req);
    expect(r).toEqual({
      text: 'A soft linen shirt. Breathes well.',
      servedModel: 'claude-sonnet-5-5',
      stopReason: 'end_turn',
      refusalCategory: null,
      usage: { inputTokens: 21, outputTokens: 9, cacheReadTokens: 4 },
    });
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.url).toMatch(/\/v1\/messages(\?|$)/);
    // SDK 1.x sends an explicit API key as a bearer token; it must be OUR key, not ANTHROPIC_API_KEY or the auth token
    expect(s.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(s.headers.get('x-api-key')).toBeNull();
    expect(s.headers.get('anthropic-beta')).toBeNull();
    expect(s.body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 300,
      system: 'You write product copy.',
      messages: [{ role: 'user', content: 'Product: Linen shirt' }],
      output_config: { effort: 'low' },
    });
    expect('temperature' in s.body).toBe(false);
    expect('thinking' in s.body).toBe(false);
  });

  it('with fallbacks: the beta endpoint, the beta header and fallbacks "default"; the served model is reported', async () => {
    const seen: Seen[] = [];
    const t = createAnthropicTransport({
      env: { AI_ANTHROPIC_API_KEY: KEY },
      fetch: stubFetch({ json: message({ model: 'claude-opus-5-5' }) }, seen),
      maxRetries: 0,
    });
    const r = await t.complete({ ...req, fallbacks: true });
    expect(r.servedModel).toBe('claude-opus-5-5');
    expect(seen[0]!.headers.get('anthropic-beta')).toContain(FALLBACK_BETA);
    expect(seen[0]!.body).toMatchObject({ fallbacks: 'default', model: 'claude-sonnet-5-5' });
    expect('betas' in seen[0]!.body).toBe(false); // a header, not a body field
  });

  it('a refusal reports the category only', async () => {
    const seen: Seen[] = [];
    const t = createAnthropicTransport({
      env: { AI_ANTHROPIC_API_KEY: KEY },
      fetch: stubFetch(
        {
          json: message({
            content: [],
            stop_reason: 'refusal',
            stop_details: {
              type: 'refusal',
              category: 'general_harms',
              explanation: 'words that are never kept',
            },
          }),
        },
        seen,
      ),
      maxRetries: 0,
    });
    const r = await t.complete(req);
    expect(r).toMatchObject({ stopReason: 'refusal', refusalCategory: 'general_harms', text: '' });
    expect(JSON.stringify(r)).not.toContain('never kept');
  });

  it('an API error becomes AiTransportError with the SDK class name only', async () => {
    const seen: Seen[] = [];
    const t = createAnthropicTransport({
      env: { AI_ANTHROPIC_API_KEY: KEY },
      fetch: stubFetch(
        {
          status: 429,
          json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down words' } },
        },
        seen,
      ),
      maxRetries: 0,
    });
    const err = await t.complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiTransportError);
    expect((err as AiTransportError).errorClass).toBe('RateLimitError');
    expect((err as Error).message).not.toContain('slow down');
  });
});

describe('createFakeTransport', () => {
  it('is deterministic, records the requests, and can be scripted', async () => {
    const f = createFakeTransport((_, n) =>
      n === 1 ? { stopReason: 'max_tokens' } : n === 2 ? new Error('boom') : undefined,
    );
    const a = await f.complete(req);
    const b = await f.complete(req);
    expect(a.text).toBe(b.text);
    expect(a.text).toMatch(/^\[fake claude-sonnet-5-5\] draft [0-9a-f]{12}$/);
    expect(a.stopReason).toBe('end_turn');
    expect(b.stopReason).toBe('max_tokens');
    await expect(f.complete(req)).rejects.toBeInstanceOf(AiTransportError);
    expect(f.calls).toHaveLength(3);
    expect(a.usage).toEqual({
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: 24,
      cacheReadTokens: 0,
    });
  });
});
