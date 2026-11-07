// #742: the Store API rate limits without Redis — the class table against the contract, the configuration, the
// client address, the middleware (429 rate_limited + Retry-After in the contract shape) and the fail-open store.
// The Lua bucket on real Redis is rate-limit.redis.test.ts.
import type { Request } from 'express';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreContext } from './tenant';
import { coreErrorHandler } from './errors';
import { loadSpec } from './openapi';
import {
  bucketAddress,
  clientAddress,
  DEFAULT_LIMITS,
  LIMITED_OPERATIONS,
  rateLimitConfigFromEnv,
  rateLimitMiddleware,
  redisRateLimitStore,
  type BucketRule,
  type RateLimitStore,
} from './rate-limit';

const STORE_A = '00000000-0000-4000-8000-0000000000a1';
const STORE_B = '00000000-0000-4000-8000-0000000000b1';

afterEach(() => vi.restoreAllMocks());

/** An exact in-memory bucket: `burst` tokens, no refill within a test. Records the keys it saw. */
function memoryStore(): RateLimitStore & { keys: string[] } {
  const used = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async take(key: string, rule: BucketRule) {
      keys.push(key);
      const n = (used.get(key) ?? 0) + 1;
      used.set(key, n);
      return n <= rule.burst
        ? { allowed: true as const }
        : { allowed: false as const, retryAfterMs: Math.ceil(60_000 / rule.perMinute) };
    },
  };
}

const fakeReq = (headers: Record<string, string>, remoteAddress = '203.0.113.9') =>
  ({ headers, socket: { remoteAddress } }) as unknown as Request;

describe('the limited operations', () => {
  it('are exactly the Store API operations whose contract has a 429 (store-api 0.5.10, CONTRACT CHANGE #744)', () => {
    const spec = loadSpec('store-api.yaml').doc;
    const with429: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const responses = (op as { responses?: Record<string, unknown> }).responses;
        if (responses?.['429']) with429.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(with429.sort()).toEqual(Object.keys(LIMITED_OPERATIONS).sort());
    expect(new Set(Object.values(LIMITED_OPERATIONS))).toEqual(
      new Set(['auth', 'cart', 'checkout']),
    );
  });
});

describe('configuration', () => {
  it('defaults, overrides, an invalid value (default + a warning), and off', () => {
    expect(rateLimitConfigFromEnv({})).toEqual({ limits: DEFAULT_LIMITS, clientIpHops: 1 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = rateLimitConfigFromEnv({
      CORE_RATE_LIMIT_CART: '5/30',
      CORE_RATE_LIMIT_AUTH: 'lots',
      CORE_CLIENT_IP_HEADER: 'X-Forwarded-For',
      CORE_CLIENT_IP_HOPS: '2',
    })!;
    expect(c.limits.cart).toEqual({ burst: 5, perMinute: 30 });
    expect(c.limits.auth).toEqual(DEFAULT_LIMITS.auth);
    expect(c.limits.checkout).toEqual(DEFAULT_LIMITS.checkout);
    expect(c.clientIpHeader).toBe('x-forwarded-for');
    expect(c.clientIpHops).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(rateLimitConfigFromEnv({ CORE_RATE_LIMIT: 'off' })).toBeNull();
  });
});

describe('the client a bucket belongs to', () => {
  const cfg = { clientIpHops: 1 };
  const xff = { clientIpHeader: 'x-forwarded-for', clientIpHops: 1 };

  it('is the peer address unless a trusted header is configured: a forged X-Forwarded-For is ignored', () => {
    expect(clientAddress(fakeReq({ 'x-forwarded-for': '198.51.100.1' }), cfg)).toBe('203.0.113.9');
  });

  it("with the header configured: the entry HOPS from the right (our proxy's), never the caller's left-most", () => {
    const req = fakeReq({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' });
    expect(clientAddress(req, xff)).toBe('198.51.100.7');
    expect(clientAddress(req, { ...xff, clientIpHops: 2 })).toBe('6.6.6.6');
    expect(clientAddress(req, { ...xff, clientIpHops: 3 })).toBe('203.0.113.9'); // not that many hops
    expect(clientAddress(fakeReq({ 'x-forwarded-for': 'not-an-ip' }), xff)).toBe('203.0.113.9');
    expect(clientAddress(fakeReq({}), xff)).toBe('203.0.113.9');
  });

  it('IPv6 is bucketed by its /64; an IPv4-mapped address is the IPv4 address', () => {
    expect(bucketAddress('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(bucketAddress('2001:db8:aa:bb:ffff::1')).toBe('2001:db8:aa:bb::/64');
    expect(bucketAddress('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(bucketAddress('::ffff:192.0.2.5')).toBe('192.0.2.5');
    expect(bucketAddress('192.0.2.5')).toBe('192.0.2.5');
  });
});

describe('the middleware', () => {
  function app(store: RateLimitStore, limits = DEFAULT_LIMITS) {
    const a = express();
    a.use('/store', (req, _res, next) => {
      const storeId = req.headers['x-test-store'] === 'b' ? STORE_B : STORE_A;
      req.tenant = { storeId } as StoreContext;
      next();
    });
    a.use('/store', rateLimitMiddleware({ store, config: { limits, clientIpHops: 1 } }));
    a.post('/store/carts/:id/complete', (_req, res) => res.status(201).json({ ok: true }));
    a.post('/store/carts', (_req, res) => res.status(201).json({ ok: true }));
    a.get('/store/carts/:id', (_req, res) => res.json({ ok: true }));
    a.post('/store/customers/me/addresses', (_req, res) => res.status(201).json({ ok: true }));
    a.use(coreErrorHandler);
    return a;
  }

  it('over the burst: 429 rate_limited in the contract Error shape, with Retry-After', async () => {
    const a = app(memoryStore());
    for (let i = 0; i < DEFAULT_LIMITS.checkout.burst; i++) {
      await request(a).post('/store/carts/c1/complete').expect(201);
    }
    const res = await request(a).post('/store/carts/c1/complete').expect(429);
    expect(res.body).toEqual({
      code: 'rate_limited',
      message: 'Too many requests',
      details: { retry_after_seconds: 1 },
    });
    expect(res.headers['retry-after']).toBe('1');
    const validate = loadSpec('store-api.yaml').schema('Error');
    expect(validate(res.body), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keys by class, store and hashed client: another store or class has its own bucket; GETs and /me writes are never limited', async () => {
    const store = memoryStore();
    const a = app(store, { ...DEFAULT_LIMITS, checkout: { burst: 1, perMinute: 60 } });
    await request(a).post('/store/carts/c1/complete').expect(201);
    await request(a).post('/store/carts/c1/complete').expect(429);
    await request(a).post('/store/carts/c1/complete').set('x-test-store', 'b').expect(201);
    await request(a).post('/store/carts').expect(201); // the cart class, not the checkout one
    for (let i = 0; i < 20; i++) await request(a).get('/store/carts/c1').expect(200);
    await request(a).post('/store/customers/me/addresses').expect(201);
    expect(store.keys).toHaveLength(4);
    expect(store.keys[0]).toMatch(new RegExp(`^core:rl:checkout:${STORE_A}:[0-9a-f]{16}$`));
    expect(store.keys[2]).toMatch(new RegExp(`^core:rl:checkout:${STORE_B}:`));
    expect(store.keys[3]).toMatch(/^core:rl:cart:/);
    expect(store.keys.join()).not.toMatch(/127\.0\.0\.1|::1|ffff/); // no address in a key
  });
});

describe('fail-open', () => {
  it('Redis unreachable: every request is allowed, with ONE warning for the outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = redisRateLimitStore({ url: 'redis://127.0.0.1:9', commandTimeoutMs: 100 });
    try {
      for (let i = 0; i < 5; i++) {
        expect(await store.take('core:rl:test:x', { burst: 1, perMinute: 1 })).toEqual({
          allowed: true,
        });
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(
        /rate limit: Redis is not answering .*requests are allowed/,
      );
    } finally {
      await store.close?.();
    }
  });
});
