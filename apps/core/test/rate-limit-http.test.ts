// #742: the rate limiter in the REAL middleware chain (mountCoreMiddleware with `rateLimit`): after the tenant (a
// request without a usable key is a 401 that never reaches the limiter) and before the routes (an over-limit
// request with an invalid body is a 429, not a 400: the limit is decided before the body is read).
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, DevTokenVerifier, loadSpec, type RateLimitStore } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { mountCoreMiddleware } from '../src/server';

const KEY_A = SEED_IDS.publishableKeys.brandA;

let db: TestDatabase;
let app: express.Express;
const taken: string[] = [];
const used = new Map<string, number>();
const store: RateLimitStore = {
  async take(key, rule) {
    taken.push(key);
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    return n <= rule.burst ? { allowed: true } : { allowed: false, retryAfterMs: 2_500 };
  },
};

beforeAll(async () => {
  db = await createTestDatabase('core_rate_limit_http');
  await seed(db.owner, { productsPerStore: 1, log: () => {} });
  process.env.CORE_ORGANIZATION_ID = SEED_IDS.organization;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    rateLimit: {
      store,
      config: { limits: { ...DEFAULT_LIMITS, cart: { burst: 2, perMinute: 60 } }, clientIpHops: 1 },
    },
  });
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('Store API rate limits in the middleware chain (#742)', () => {
  it('a request without a usable key is a 401 and never reaches the limiter', async () => {
    await request(app).post('/store/carts').send({}).expect(401);
    await request(app)
      .post('/store/carts')
      .set('X-Publishable-Key', 'pk_nope')
      .send({})
      .expect(401);
    expect(taken).toHaveLength(0);
  });

  it('the limit is decided before the body: over the burst, an invalid body is a 429, not a 400', async () => {
    const post = () =>
      request(app).post('/store/carts').set('X-Publishable-Key', KEY_A).send({ currency: 'nope' });
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(400);
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.body).toEqual({
      code: 'rate_limited',
      message: 'Too many requests',
      details: { retry_after_seconds: 3 },
    });
    // the contract's own response for this operation (store-api 0.5.10, #744)
    const op = loadSpec('store-api.yaml').doc.paths['/store/carts']!.post as unknown as {
      responses: Record<string, { $ref?: string }>;
    };
    expect(op.responses['429']?.$ref).toBe('#/components/responses/TooManyRequests');
    expect(taken.every((k) => k.startsWith(`core:rl:cart:${SEED_IDS.stores.brandA}:`))).toBe(true);
  });

  it('a mixed-case path is the same operation and the same bucket in the real chain (#754 review)', async () => {
    // the cart bucket is empty after the test above; Express routes /STORE/Carts to createCart, so must the limiter
    const res = await request(app)
      .post('/STORE/Carts')
      .set('X-Publishable-Key', KEY_A)
      .send({ currency: 'nope' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('reads are never limited', async () => {
    const before = taken.length;
    for (let i = 0; i < 5; i++)
      await request(app).get('/store/products').set('X-Publishable-Key', KEY_A).expect(200);
    expect(taken.length).toBe(before);
  });
});
