// The token budget and rate limit: the in-memory limiter always; the Redis limiter against the local Redis when it
// answers (skipped with a printed reason otherwise). Keys use a random prefix and are deleted afterwards.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiConfigError,
  createMemoryLimiter,
  createRedisLimiter,
  DEFAULT_LIMITS,
  limitsFromEnv,
  orgLimitsFromEnv,
  scopeKey,
  type LimitScope,
  type UsageLimiter,
} from '../src/index.js';

const STORE = 'store-alpha';
const NOW = new Date('2026-10-31T10:15:20Z');
const NEXT_MINUTE = new Date('2026-10-31T10:16:01Z');
const NEXT_MONTH = new Date('2026-11-01T00:00:01Z');

describe('limits from env', () => {
  it('defaults, overrides, and a bad value is a configuration error', () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
    expect(
      limitsFromEnv({ AI_MONTHLY_TOKEN_BUDGET: '5000', AI_RATE_LIMIT_PER_MINUTE: '3' }),
    ).toEqual({
      monthlyTokens: 5000,
      perMinute: 3,
    });
    expect(() => limitsFromEnv({ AI_MONTHLY_TOKEN_BUDGET: '-1' })).toThrow(AiConfigError);
    expect(() => limitsFromEnv({ AI_RATE_LIMIT_PER_MINUTE: '1.5' })).toThrow(AiConfigError);
  });

  it('the organization budget: AI_ORG_MONTHLY_TOKEN_BUDGET, else the store budget; the same per-minute number (#669)', () => {
    expect(orgLimitsFromEnv({})).toEqual(DEFAULT_LIMITS);
    expect(orgLimitsFromEnv({ AI_MONTHLY_TOKEN_BUDGET: '5000' })).toEqual({
      monthlyTokens: 5000,
      perMinute: DEFAULT_LIMITS.perMinute,
    });
    expect(
      orgLimitsFromEnv({
        AI_MONTHLY_TOKEN_BUDGET: '5000',
        AI_ORG_MONTHLY_TOKEN_BUDGET: '90000',
        AI_RATE_LIMIT_PER_MINUTE: '4',
      }),
    ).toEqual({ monthlyTokens: 90000, perMinute: 4 });
    expect(() => orgLimitsFromEnv({ AI_ORG_MONTHLY_TOKEN_BUDGET: '0' })).toThrow(AiConfigError);
  });

  it('scope keys: a store keeps its pre-#669 key (its id); an organization is org:<id>', () => {
    expect(scopeKey({ kind: 'store', id: 'abc' })).toBe('abc');
    expect(scopeKey({ kind: 'organization', id: 'abc' })).toBe('org:abc');
  });
});

const storeScope = (): LimitScope => ({
  kind: 'store',
  id: `${STORE}-${Math.random().toString(36).slice(2, 8)}`,
});

function contract(
  name: string,
  make: () => UsageLimiter | Promise<UsageLimiter>,
  skip: () => string | null,
) {
  describe(name, () => {
    let l: UsageLimiter;
    let store: LimitScope;
    beforeAll(async () => {
      if (!skip()) l = await make();
    });

    it('reserves within the budget, refuses beyond it, and settles to the real usage', async (ctx) => {
      const why = skip();
      if (why) return ctx.skip(why);
      store = storeScope();
      const limits = { monthlyTokens: 1000, perMinute: 100 };
      expect(await l.reserve(store, 600, limits, NOW)).toEqual({
        ok: true,
        reservationTokens: 600,
        usedTokens: 600,
      });
      expect(await l.reserve(store, 500, limits, NOW)).toEqual({
        ok: false,
        reason: 'over_budget',
        usedTokens: 600,
        limitTokens: 1000,
      });
      await l.settle(store, -400, NOW); // the call used 200 of its 600
      expect(await l.usedTokens(store, NOW)).toBe(200);
      expect((await l.reserve(store, 800, limits, NOW)).ok).toBe(true);
      // a new month starts at zero
      expect(await l.usedTokens(store, NEXT_MONTH)).toBe(0);
      // never below zero
      await l.settle(store, -5000, NOW);
      expect(await l.usedTokens(store, NOW)).toBe(0);
    });

    it('rate-limits per store per minute; a refused call does not count; the next minute is fresh', async (ctx) => {
      const why = skip();
      if (why) return ctx.skip(why);
      store = storeScope();
      const limits = { monthlyTokens: 1_000_000, perMinute: 2 };
      expect((await l.reserve(store, 1, limits, NOW)).ok).toBe(true);
      expect((await l.reserve(store, 1, limits, NOW)).ok).toBe(true);
      expect(await l.reserve(store, 1, limits, NOW)).toEqual({
        ok: false,
        reason: 'rate_limited',
        limitPerMinute: 2,
      });
      expect(await l.reserve(store, 1, limits, NOW)).toEqual({
        ok: false,
        reason: 'rate_limited',
        limitPerMinute: 2,
      });
      expect((await l.reserve(store, 1, limits, NEXT_MINUTE)).ok).toBe(true);
      // another store has its own minute
      expect((await l.reserve({ kind: 'store', id: `${store.id}-other` }, 1, limits, NOW)).ok).toBe(
        true,
      );
    });

    it('an over-budget refusal does not use up the minute', async (ctx) => {
      const why = skip();
      if (why) return ctx.skip(why);
      store = storeScope();
      const limits = { monthlyTokens: 10, perMinute: 1 };
      expect((await l.reserve(store, 50, limits, NOW)).ok).toBe(false); // over budget
      expect((await l.reserve(store, 5, limits, NOW)).ok).toBe(true); // the minute is still free
    });

    it('an organization has its own month and minute, separate from a store with the same id (#669)', async (ctx) => {
      const why = skip();
      if (why) return ctx.skip(why);
      store = storeScope();
      const org: LimitScope = { kind: 'organization', id: store.id };
      const limits = { monthlyTokens: 100, perMinute: 1 };
      expect((await l.reserve(store, 90, limits, NOW)).ok).toBe(true);
      expect((await l.reserve(org, 90, limits, NOW)).ok).toBe(true); // not the store's month or minute
      expect(await l.usedTokens(org, NOW)).toBe(90);
      expect(await l.usedTokens(store, NOW)).toBe(90);
      await l.settle(org, -40, NOW);
      expect(await l.usedTokens(org, NOW)).toBe(50);
      expect(await l.usedTokens(store, NOW)).toBe(90);
      expect(await l.reserve(org, 1, limits, NOW)).toEqual({
        ok: false,
        reason: 'rate_limited',
        limitPerMinute: 1,
      });
    });
  });
}

contract(
  'memory limiter',
  () => createMemoryLimiter(),
  () => null,
);

// ---- Redis ----
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6381';
const prefix = `t-${Math.random().toString(36).slice(2, 8)}:ai:`;
let redisDown: string | null = 'not probed';
let probe: Redis | undefined;

beforeAll(async () => {
  probe = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    redisDown = null;
  } catch (err) {
    redisDown = `${url}: ${(err as Error).message}`;
    console.warn(`limiter.test: Redis ${redisDown} — Redis block skipped (pnpm compose:up)`);
  }
});

afterAll(async () => {
  if (!probe) return;
  if (!redisDown) {
    const keys = await probe.keys(`${prefix}*`);
    if (keys.length) await probe.del(...keys);
    console.info(`limiter.test: deleted ${keys.length} Redis key(s) with prefix ${prefix}`);
    expect(await probe.keys(`${prefix}*`)).toEqual([]);
  }
  probe.disconnect();
});

let redisLimiter: ReturnType<typeof createRedisLimiter> | undefined;
afterAll(async () => {
  await redisLimiter?.close();
});

contract(
  'Redis limiter (local Redis, prefixed keys, self-cleaning)',
  () => (redisLimiter = createRedisLimiter({ url, prefix })),
  () => redisDown,
);

describe('Redis key layout (#669)', () => {
  it('store keys are byte-identical to before #669 (live counters keep counting); organization keys are org:<id>', async (ctx) => {
    if (redisDown) return ctx.skip(redisDown);
    const l = createRedisLimiter({ url, prefix });
    try {
      const id = `k-${Math.random().toString(36).slice(2, 8)}`;
      const limits = { monthlyTokens: 1000, perMinute: 10 };
      await l.reserve({ kind: 'store', id }, 7, limits, NOW);
      await l.reserve({ kind: 'organization', id }, 9, limits, NOW);
      expect(await probe!.get(`${prefix}budget:${id}:202610`)).toBe('7');
      expect(await probe!.get(`${prefix}budget:org:${id}:202610`)).toBe('9');
      const minute = String(Math.floor(NOW.getTime() / 60_000));
      expect(await probe!.get(`${prefix}rate:${id}:${minute}`)).toBe('1');
      expect(await probe!.get(`${prefix}rate:org:${id}:${minute}`)).toBe('1');
    } finally {
      await l.close();
    }
  });
});
