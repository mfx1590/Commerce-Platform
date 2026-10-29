// The Store API recommendation route (task P5.8, #607) through the mountable router, over a tenant stub that
// supplies the store-scoped client the publishable-key middleware would resolve in the real chain. Covers the
// contract's query rules: exactly one anchor for `bought_together`, the enums, the caps, and the 404.
import express from 'express';
import request from 'supertest';
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler } from '../../http';
import {
  DEFAULT_THRESHOLDS,
  FixtureBasketSource,
  loadSearchRecords,
  rebuildStoreRecommendations,
  recommendationsRouter,
  RECOMMENDATIONS_PATH,
  type FixtureLine,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const NOW = new Date('2026-10-27T12:00:00Z');

let db: TestDatabase;
let app: express.Express;
let productsA: string[];
let productB: string;
let currencyA: string;

const get = (query: string) => request(app).get(`${RECOMMENDATIONS_PATH}${query}`);

beforeAll(async () => {
  db = await createTestDatabase('core_recommendations_http');
  await seed(db.owner, { productsPerStore: 6, log: () => {} });
  const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });

  const recA = await loadSearchRecords(a, A);
  const recB = await loadSearchRecords(b, B);
  productsA = recA.map((r) => r.objectID);
  productB = recB[0]?.objectID as string;
  currencyA = recA[0]?.currencies[0] as string;

  const [p0, p1] = productsA as [string, string];
  const lines: FixtureLine[] = [];
  for (const o of ['o1', 'o2']) {
    for (const product_id of [p0, p1]) {
      lines.push({
        store_id: A,
        order_id: o,
        product_id,
        quantity: 1,
        placed_at: new Date(NOW.getTime() - 86_400_000).toISOString(),
        order_status: 'placed',
      });
    }
  }
  await rebuildStoreRecommendations(
    a,
    A,
    new FixtureBasketSource(lines, () => NOW),
    { ...DEFAULT_THRESHOLDS, minSupportBaskets: 2, minLift: 1.0 },
    NOW,
  );

  app = express();
  // What storeContextMiddleware would have put there after resolving the publishable key.
  app.use((req, _res, next) => {
    (req as unknown as { tenant: unknown }).tenant = {
      organizationId: ORG,
      storeId: A,
      storeCode: 'brand-a',
      defaultCurrency: currencyA,
      salesChannelId: null,
      apiKeyId: 'stub',
      apiKeyType: 'publishable',
      client: a,
      actor: { kind: 'anonymous' },
      requestId: 'test',
    };
    next();
  });
  app.use(recommendationsRouter());
  app.use(coreErrorHandler);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe('query validation', () => {
  it('400s when kind=bought_together has no anchor', async () => {
    const res = await get('');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
    expect(res.body.details.product_id).toMatch(/required/);
  });

  it('400s when both anchors are given', async () => {
    const [p0] = productsA as [string];
    const res = await get(`?product_id=${p0}&variant_ids=${p0}`);
    expect(res.status).toBe(400);
    expect(res.body.details.product_id).toMatch(/not both/);
  });

  it('400s on a product_id that is not a uuid', async () => {
    const res = await get('?product_id=not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.details.product_id).toBe('uuid');
  });

  it('400s on a variant_ids list that is not all uuids', async () => {
    const [p0] = productsA as [string];
    const res = await get(`?variant_ids=${p0},nope`);
    expect(res.status).toBe(400);
    expect(res.body.details.variant_ids).toMatch(/uuids/);
  });

  it('400s on a window that is not 7 or 30', async () => {
    const res = await get('?kind=popular&window_days=14');
    expect(res.status).toBe(400);
    expect(res.body.details.window_days).toMatch(/7, 30/);
  });

  it('400s on limit above the contract maximum of 24', async () => {
    const res = await get('?kind=popular&limit=25');
    expect(res.status).toBe(400);
    expect(res.body.details.limit).toMatch(/between 1 and 24/);
  });

  it('400s on an unknown kind', async () => {
    const res = await get('?kind=magic');
    expect(res.status).toBe(400);
    expect(res.body.details.kind).toMatch(/one of/);
  });
});

describe('answers', () => {
  it('serves the pair list for an anchor', async () => {
    const [p0, p1] = productsA as [string, string];
    const res = await get(`?product_id=${p0}`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('bought_together');
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([p1]);
  });

  it('serves the store-wide popular list with no anchor at all', async () => {
    const res = await get('?kind=popular&window_days=30');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('popular');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('accepts a cart of variant ids', async () => {
    const [p0] = productsA as [string];
    const r = await db.owner.query<{ id: string }>(
      `SELECT id FROM product_variant WHERE product_id = $1 ORDER BY id LIMIT 2`,
      [p0],
    );
    const res = await get(`?variant_ids=${r.rows.map((x) => x.id).join(',')}`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('bought_together');
  });

  it('404s for an anchor of another store', async () => {
    const res = await get(`?product_id=${productB}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('caps the list at the asked limit', async () => {
    const res = await get('?kind=popular&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(1);
  });
});
