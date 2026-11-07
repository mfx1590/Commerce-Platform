// #742: the Lua token bucket on REAL Redis — burst, refusal with the wait until the next token, refill, the key's
// expiry and isolation between keys. Runs where Redis answers: CORE_TEST_REDIS_URL (CI `unit` once #745 lands),
// else REDIS_URL (the compose stack on 6381 locally, the live job). Otherwise it is skipped with the reason
// printed. Every key carries a per-run prefix and is deleted afterwards.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisRateLimitStore, type RateLimitStore } from './rate-limit';

const url = process.env.CORE_TEST_REDIS_URL ?? process.env.REDIS_URL;
const prefix = `core:rl:test-${randomUUID().slice(0, 8)}:`;
let redis: Redis | undefined;
let reachable = false;

beforeAll(async () => {
  if (!url) return;
  const probe = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    reachable = (await probe.ping()) === 'PONG';
    redis = probe;
  } catch {
    probe.disconnect();
  }
  if (!reachable)
    console.info(
      `[rate-limit.redis.test] skipped: no Redis answers at ${url ? 'CORE_TEST_REDIS_URL/REDIS_URL' : '(unset)'}`,
    );
});

afterAll(async () => {
  if (redis && reachable) {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
  }
  redis?.disconnect();
});

if (!url) console.info('[rate-limit.redis.test] skipped: CORE_TEST_REDIS_URL / REDIS_URL unset');

describe.skipIf(!url)('the Redis token bucket (#742)', () => {
  let store: RateLimitStore;
  beforeAll(() => {
    store = redisRateLimitStore({ client: redis!, commandTimeoutMs: 1_000 });
  });

  it('allows the burst, then refuses with the wait until the next token', async (ctx) => {
    if (!reachable) return ctx.skip();
    const key = `${prefix}burst`;
    const rule = { burst: 3, perMinute: 6 }; // one token every 10 s
    for (let i = 0; i < 3; i++) expect(await store.take(key, rule)).toEqual({ allowed: true });
    const refused = await store.take(key, rule);
    expect(refused.allowed).toBe(false);
    const wait = (refused as { retryAfterMs: number }).retryAfterMs;
    expect(wait).toBeGreaterThan(9_000);
    expect(wait).toBeLessThanOrEqual(10_000);
    // the bucket expires once it would be full again (3 tokens at 10 s each) plus a second
    const ttl = await redis!.pttl(key);
    expect(ttl).toBeGreaterThan(25_000);
    expect(ttl).toBeLessThanOrEqual(31_000);
  });

  it('refills at the configured rate', async (ctx) => {
    if (!reachable) return ctx.skip();
    const key = `${prefix}refill`;
    const rule = { burst: 1, perMinute: 600 }; // one token every 100 ms
    expect(await store.take(key, rule)).toEqual({ allowed: true });
    expect((await store.take(key, rule)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(await store.take(key, rule)).toEqual({ allowed: true });
  });

  it('keys are independent; refused requests do not dig the bucket deeper', async (ctx) => {
    if (!reachable) return ctx.skip();
    const rule = { burst: 1, perMinute: 60 };
    expect(await store.take(`${prefix}a`, rule)).toEqual({ allowed: true });
    expect(await store.take(`${prefix}b`, rule)).toEqual({ allowed: true });
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await store.take(`${prefix}a`, rule);
      expect(r.allowed).toBe(false);
      waits.push((r as { retryAfterMs: number }).retryAfterMs);
    }
    // a client hammering while refused still gets its token back after about a second, not later
    expect(Math.max(...waits)).toBeLessThanOrEqual(1_000);
  });
});
