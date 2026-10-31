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
});

function contract(
  name: string,
  make: () => UsageLimiter | Promise<UsageLimiter>,
  skip: () => string | null,
) {
  describe(name, () => {
    let l: UsageLimiter;
    let store: string;
    beforeAll(async () => {
      if (!skip()) l = await make();
    });

    it('reserves within the budget, refuses beyond it, and settles to the real usage', async (ctx) => {
      const why = skip();
      if (why) return ctx.skip(why);
      store = `${STORE}-${Math.random().toString(36).slice(2, 8)}`;
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
      store = `${STORE}-${Math.random().toString(36).slice(2, 8)}`;
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
      expect((await l.reserve(`${store}-other`, 1, limits, NOW)).ok).toBe(true);
    });

    it('an over-budget refusal does not use up the minute', async (ctx) => {
      const why = skip();
      if (why) return ctx.skip(why);
      store = `${STORE}-${Math.random().toString(36).slice(2, 8)}`;
      const limits = { monthlyTokens: 10, perMinute: 1 };
      expect((await l.reserve(store, 50, limits, NOW)).ok).toBe(false); // over budget
      expect((await l.reserve(store, 5, limits, NOW)).ok).toBe(true); // the minute is still free
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
