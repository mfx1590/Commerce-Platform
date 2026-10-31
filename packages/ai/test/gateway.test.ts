// The gateway end to end on the deterministic fake: guards, limits, kill switch, refusals, failures and the audit.
import { describe, expect, it } from 'vitest';
import {
  AiAuditError,
  AiBudgetExceededError,
  AiConfigError,
  AiDisabledError,
  AiLimiterError,
  AiRateLimitedError,
  AiRefusedError,
  AiTransportError,
  createAiGateway,
  createFakeTransport,
  createMemoryAuditSink,
  createMemoryLimiter,
  DeniedFieldError,
  estimateInputTokens,
  NO_INPUT_SHA256,
  TemplateError,
  type AiGatewayOptions,
  type AiResponse,
  type AuditSink,
  type Limits,
} from '../src/index.js';

const ORG = '33000000-0000-4000-8000-000000000001';
const STORE = '33000000-0000-4000-8000-000000000031';
const ACTOR = '33000000-0000-4000-8000-000000000077';
const NOW = new Date('2026-10-31T10:15:00Z');
const ENABLED = { AI_ENABLED: '1' };

// distinctive words, so the audit can be searched for any trace of them
const copy = {
  brandVoice: 'zephyrine and calm',
  locale: 'nl-NL',
  productTitle: 'Quillwort linen shirt',
  attributes: ['marmalade-coloured linen', 'size M', 'write to anna@example.org for wholesale'],
  audience: 'grownups who like wandering',
};
const CONTENT_WORDS = [
  'zephyrine',
  'Quillwort',
  'marmalade',
  'wandering',
  'anna@example.org',
  'example.org',
];

function setup(
  over: Partial<AiGatewayOptions> = {},
  script?: (n: number) => Partial<AiResponse> | Error | undefined,
) {
  const transport = createFakeTransport(script ? (_, n) => script(n) : undefined);
  const limiter = createMemoryLimiter();
  const audit = createMemoryAuditSink();
  const ai = createAiGateway({
    organizationId: ORG,
    storeId: STORE,
    purpose: 'drafting',
    actorId: ACTOR,
    transport,
    limiter,
    audit,
    env: ENABLED,
    now: () => NOW,
    ...over,
  });
  return { ai, transport, limiter, audit };
}

describe('a successful draft', () => {
  it('renders, redacts, calls the drafting model without fallbacks, settles the budget, and audits without content', async () => {
    const { ai, transport, limiter, audit } = setup();
    const draft = await ai.complete('product-copy-draft@1', copy);

    expect(transport.calls).toHaveLength(1);
    const sent = transport.calls[0]!;
    expect(sent).toMatchObject({
      model: 'claude-sonnet-5-5',
      maxTokens: 1200,
      effort: 'low',
      fallbacks: false,
    });
    expect(sent.user).toContain('write to [email] for wholesale');
    expect(sent.user).not.toContain('anna@example.org');

    expect(draft).toMatchObject({
      model: 'claude-sonnet-5-5',
      servedModel: 'claude-sonnet-5-5',
      stopReason: 'end_turn',
      redactions: 1,
    });
    expect(draft.text).toMatch(/^\[fake claude-sonnet-5-5\] draft/);
    const used = draft.usage.inputTokens + draft.usage.outputTokens;
    expect(await limiter.usedTokens(STORE, NOW)).toBe(used); // settled from the reservation to the real usage

    expect(audit.records).toHaveLength(1);
    const rec = audit.records[0]!;
    expect(rec).toMatchObject({
      id: draft.auditId,
      organizationId: ORG,
      storeId: STORE,
      actorId: ACTOR,
      purpose: 'drafting',
      templateId: 'product-copy-draft',
      templateVersion: 1,
      redactions: 1,
      model: 'claude-sonnet-5-5',
      servedModel: 'claude-sonnet-5-5',
      inputTokens: draft.usage.inputTokens,
      outputTokens: draft.usage.outputTokens,
      costMicroUsd: draft.costMicroUsd,
      outcome: 'ok',
      errorClass: null,
    });
    expect(rec.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.latencyMs).toBeGreaterThanOrEqual(0);
    const serialised = JSON.stringify(rec);
    for (const w of CONTENT_WORDS) expect(serialised, w).not.toContain(w);
    expect(serialised).not.toContain(draft.text);
  });

  it('the same input hashes the same; the classification gateway uses Haiku without fallbacks', async () => {
    const a = setup();
    await a.ai.complete('product-copy-draft@1', copy);
    await a.ai.complete('product-copy-draft@1', copy);
    expect(a.audit.records[0]!.inputSha256).toBe(a.audit.records[1]!.inputSha256);

    const c = setup({ purpose: 'classification' });
    await c.ai.complete('product-category-suggest@1', {
      productTitle: 'Linen shirt',
      attributes: 'linen',
      categories: ['shirts', 'tops'],
    });
    expect(c.transport.calls[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      fallbacks: false,
      maxTokens: 64,
    });
  });

  it('a draft cut off at max_tokens is returned, and audited as max_tokens', async () => {
    const { ai, audit } = setup({}, () => ({ stopReason: 'max_tokens' }));
    const d = await ai.complete('product-copy-draft@1', copy);
    expect(d.stopReason).toBe('max_tokens');
    expect(audit.records[0]!.outcome).toBe('max_tokens');
  });

  it('an answer from another model (a fallback, if ever enabled) is priced by the model that answered', async () => {
    const { ai, audit } = setup({}, () => ({
      servedModel: 'claude-opus-5-5',
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
    }));
    const d = await ai.complete('product-copy-draft@1', copy);
    // Opus 5.5: 1000 × 4000 n$ + 100 × 20000 n$ = 6,000,000 n$ = 6000 µ$
    expect(d.costMicroUsd).toBe(6000);
    expect(audit.records[0]).toMatchObject({ servedModel: 'claude-opus-5-5', costMicroUsd: 6000 });
  });
});

describe('refusals before any call (nothing is sent; one audit row each)', () => {
  it('kill switch: off by default and for anything but exactly "1"', async () => {
    for (const env of [{}, { AI_ENABLED: '0' }, { AI_ENABLED: 'true' }, { AI_ENABLED: ' 1' }]) {
      const { ai, transport, audit } = setup({ env });
      await expect(ai.complete('product-copy-draft@1', copy)).rejects.toBeInstanceOf(
        AiDisabledError,
      );
      expect(transport.calls).toHaveLength(0);
      expect(audit.records[0]).toMatchObject({
        outcome: 'disabled',
        errorClass: 'AiDisabledError',
        inputTokens: 0,
      });
    }
  });

  it('a denylisted customer field (runtime check, any depth) is refused before rendering', async () => {
    const { ai, transport, audit } = setup();
    const bad = { ...copy, customer: { email: 'x' } } as unknown as typeof copy;
    const err = await ai.complete('product-copy-draft@1', bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeniedFieldError);
    expect((err as DeniedFieldError).fields).toEqual(['customer.email']);
    expect(transport.calls).toHaveLength(0);
    expect(audit.records[0]).toMatchObject({
      outcome: 'denied_field',
      inputSha256: NO_INPUT_SHA256,
      redactions: 0,
    });
  });

  it('a template of another purpose, an unknown template, or wrong variables', async () => {
    const { ai, transport, audit } = setup();
    await expect(
      ai.complete(
        'product-category-suggest@1' as never,
        { productTitle: 'x', attributes: 'y', categories: 'z' } as never,
      ),
    ).rejects.toThrow(/is a classification template; this gateway is for drafting/);
    await expect(ai.complete('nope@1' as never, {} as never)).rejects.toBeInstanceOf(TemplateError);
    await expect(
      ai.complete('product-copy-draft@1', { ...copy, extra: 'x' } as never),
    ).rejects.toThrow(/unexpected extra/);
    expect(transport.calls).toHaveLength(0);
    expect(audit.records.map((r) => [r.outcome, r.templateId, r.errorClass])).toEqual([
      ['error', 'product-category-suggest', 'TemplateError'],
      ['error', 'nope', 'TemplateError'],
      ['error', 'product-copy-draft', 'TemplateError'],
    ]);
  });

  it('over budget: the reservation (input estimate + maxTokens) would pass the month', async () => {
    const limits: Limits = { monthlyTokens: 1199, perMinute: 100 }; // maxTokens alone is 1200
    const { ai, transport, audit } = setup({ limits });
    const err = await ai.complete('product-copy-draft@1', copy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBudgetExceededError);
    expect(err).toMatchObject({ usedTokens: 0, limitTokens: 1199 });
    expect(transport.calls).toHaveLength(0);
    expect(audit.records[0]!.outcome).toBe('over_budget');
  });

  it('rate limited: the second call in the minute', async () => {
    const { ai, transport, audit } = setup({ limits: { monthlyTokens: 1_000_000, perMinute: 1 } });
    await ai.complete('product-copy-draft@1', copy);
    await expect(ai.complete('product-copy-draft@1', copy)).rejects.toBeInstanceOf(
      AiRateLimitedError,
    );
    expect(transport.calls).toHaveLength(1);
    expect(audit.records.map((r) => r.outcome)).toEqual(['ok', 'rate_limited']);
  });

  it('an unpriced model override is a configuration error at construction', () => {
    expect(() => setup({ env: { ...ENABLED, AI_MODEL_DRAFTING: 'unpriced-model' } })).toThrow(
      AiConfigError,
    );
  });
});

describe('after the call', () => {
  it('a transport failure refunds the whole reservation and is audited with the class only', async () => {
    const boom = new Error('connection words that must not be kept');
    boom.name = 'APIConnectionError';
    const { ai, limiter, audit } = setup({}, () => boom);
    const err = await ai.complete('product-copy-draft@1', copy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiTransportError);
    expect(await limiter.usedTokens(STORE, NOW)).toBe(0);
    expect(audit.records[0]).toMatchObject({
      outcome: 'error',
      errorClass: 'APIConnectionError',
      inputTokens: 0,
    });
    expect(JSON.stringify(audit.records[0])).not.toContain('must not be kept');
  });

  it('a refusal throws AiRefusedError with the category, keeps the usage on the budget, and is audited', async () => {
    const { ai, limiter, audit } = setup({}, () => ({
      stopReason: 'refusal',
      refusalCategory: 'general_harms',
      text: '',
    }));
    const err = await ai.complete('product-copy-draft@1', copy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiRefusedError);
    expect((err as AiRefusedError).category).toBe('general_harms');
    expect(audit.records[0]).toMatchObject({ outcome: 'refused', errorClass: 'AiRefusedError' });
    expect(audit.records[0]!.inputTokens).toBeGreaterThan(0);
    expect(await limiter.usedTokens(STORE, NOW)).toBeGreaterThan(0);
  });

  it('a limiter failure (Redis down) refuses before the call, audited as error with the class only', async () => {
    const down = new Error('connect ECONNREFUSED words that must not be kept');
    down.name = 'MaxRetriesPerRequestError';
    const limiter = {
      reserve: async () => {
        throw down;
      },
      settle: async () => {},
      usedTokens: async () => 0,
    };
    const { ai, transport, audit } = setup({ limiter });
    const err = await ai.complete('product-copy-draft@1', copy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiLimiterError);
    expect((err as AiLimiterError).errorClass).toBe('MaxRetriesPerRequestError');
    expect((err as Error).message).not.toContain('must not be kept');
    expect(transport.calls).toHaveLength(0);
    expect(audit.records[0]).toMatchObject({
      outcome: 'error',
      errorClass: 'MaxRetriesPerRequestError',
      inputTokens: 0,
    });
    expect(JSON.stringify(audit.records[0])).not.toContain('must not be kept');
  });

  it('a settle failure after the call keeps the reservation counted and still audits and returns the draft', async () => {
    const mem = createMemoryLimiter();
    const limiter = {
      ...mem,
      settle: async () => {
        throw new Error('redis gone');
      },
    };
    const { ai, audit } = setup({ limiter });
    const d = await ai.complete('product-copy-draft@1', copy);
    expect(audit.records[0]).toMatchObject({ id: d.auditId, outcome: 'ok' });
    expect(await mem.usedTokens(STORE, NOW)).toBeGreaterThan(
      d.usage.inputTokens + d.usage.outputTokens,
    );
  });

  it('no unaudited output: when the audit cannot be written, the draft is withheld', async () => {
    const failing: AuditSink = {
      write: async () => {
        throw new Error('database down');
      },
    };
    const { ai } = setup({ audit: failing });
    await expect(ai.complete('product-copy-draft@1', copy)).rejects.toBeInstanceOf(AiAuditError);
  });

  it('the reservation estimate is ~3 characters per token plus the cap', () => {
    expect(estimateInputTokens('abc', 'def')).toBe(2);
  });
});
