// Store API routes (issue #6): the exact chain src/server.ts mounts (middleware + Store API routes) on a bare
// Express app over a fully seeded throwaway database. Responses are validated against the frozen OpenAPI
// components, and the Store API requests of packages/contracts/test/contract.test.ts are replayed.
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const KEY_A = SEED_IDS.publishableKeys.brandA;
const KEY_B = SEED_IDS.publishableKeys.brandB;
const spec = specValidator('store-api.yaml');

let db: TestDatabase;
let app: express.Express;

const asA = (path: string) => request(app).get(path).set('X-Publishable-Key', KEY_A);

beforeAll(async () => {
  db = await createTestDatabase('core_store_api');
  await seed(db.owner, { log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = SEED_IDS.organization;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier()); // includes the Store API routes
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('contract replay (packages/contracts/test/contract.test.ts, Store API part)', () => {
  it('refuses requests without the publishable key', async () => {
    const res = await request(app).get('/store');
    expect(res.status).toBe(401);
    spec.assertSchema('Error', res.body);
    expect(res.body.code).toBe('unauthorized');
  });

  it('GET /store returns the seeded brand-a store', async () => {
    const res = await asA('/store');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('brand-a');
    expect(res.body.id).toBe(SEED_IDS.stores.brandA);
    spec.assertSchema('Store', res.body);
    expect(res.body).toMatchObject({
      default_currency: 'EUR',
      currencies: ['EUR'],
      locales: ['en-GB', 'de-DE'],
      sales_channel: { code: 'web', type: 'web' },
    });
  });

  it('GET /store/products and /store/products/{handle} conform to their schemas', async () => {
    const list = await asA('/store/products?limit=24');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    spec.assertPage('ProductSummary', list.body);
    expect(list.body).toMatchObject({ page: 1, limit: 24, total: 200 });
    expect(list.body.items).toHaveLength(24);

    // The mock's example handle (classic-tee) is not in the seed; replay with a real one.
    const handle = list.body.items[0].handle as string;
    const one = await asA(`/store/products/${handle}`);
    expect(one.status).toBe(200);
    expect(one.body.handle).toBe(handle);
    spec.assertSchema('Product', one.body);
    const variants = one.body.variants as Array<{
      price: { amount_minor: number; currency: string };
    }>;
    expect(variants[0]?.price).toEqual({
      amount_minor: list.body.items[0].price.amount_minor,
      currency: 'EUR',
    });
  });
});

describe('Store API routes', () => {
  it('GET /store/categories lists active categories as a flat tree', async () => {
    const res = await asA('/store/categories');
    expect(res.status).toBe(200);
    spec.assertItems('Category', res.body);
    const handles = res.body.items.map((c: { handle: string }) => c.handle);
    expect(handles).toEqual(expect.arrayContaining(['tops', 't-shirts', 'bags']));
  });

  it('list query params: category includes children, tag, sort, pagination', async () => {
    const tops = await asA('/store/products?category=tops&limit=1');
    const tees = await asA('/store/products?category=t-shirts&limit=1');
    const hoodies = await asA('/store/products?category=hoodies&limit=1');
    expect(tops.body.total).toBe(tees.body.total + hoodies.body.total);

    const asc = await asA('/store/products?sort=price_asc&limit=3');
    const prices = asc.body.items.map(
      (i: { price: { amount_minor: number } }) => i.price.amount_minor,
    );
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);

    const page2 = await asA('/store/products?page=2&limit=10');
    expect(page2.body).toMatchObject({ page: 2, limit: 10, total: 200 });
    expect(page2.body.items).toHaveLength(10);

    const tagged = await asA('/store/products?tag=jeans&limit=2');
    expect(tagged.body.total).toBeGreaterThan(0);
    spec.assertPage('ProductSummary', tagged.body);
  });

  it('invalid query params → 400 validation_error with details', async () => {
    const res = await asA('/store/products?limit=0&sort=cheapest&page=x');
    expect(res.status).toBe(400);
    spec.assertSchema('Error', res.body);
    expect(res.body).toMatchObject({
      code: 'validation_error',
      details: {
        limit: 'integer between 1 and 100',
        page: 'integer >= 1',
        sort: 'one of relevance, price_asc, price_desc, newest',
      },
    });
  });

  it("404 for a handle from another store (brand-b's product with brand-a's key)", async () => {
    const b = await request(app).get('/store/products?limit=1').set('X-Publishable-Key', KEY_B);
    expect(b.status).toBe(200);
    const bHandle = b.body.items[0].handle as string;
    const asAOnB = await asA(`/store/products/${bHandle}`);
    // The same handle may legitimately exist in brand-a (deterministic seed); only assert when it does not.
    if (asAOnB.status === 200) {
      expect(asAOnB.body.id).not.toBe(b.body.items[0].id);
    } else {
      expect(asAOnB.status).toBe(404);
      spec.assertSchema('Error', asAOnB.body);
      expect(asAOnB.body.code).toBe('not_found');
    }
    const missing = await asA('/store/products/definitely-not-a-handle');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      code: 'not_found',
      message: 'product definitely-not-a-handle not found',
    });
  });

  it('prices are in the store default currency: brand-b answers in GBP', async () => {
    const res = await request(app).get('/store/products?limit=2').set('X-Publishable-Key', KEY_B);
    expect(res.status).toBe(200);
    for (const item of res.body.items) expect(item.price.currency).toBe('GBP');
    const store = await request(app).get('/store').set('X-Publishable-Key', KEY_B);
    expect(store.body).toMatchObject({ code: 'brand-b', default_currency: 'GBP' });
  });
});
