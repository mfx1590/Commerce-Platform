// Merchandising rules (task 2.2, #135) against a seeded throwaway database that also carries the PROPOSED
// migration (proposed/0130_merchandising_rule.sql, contract change #162): Postgres repository under RLS, service
// validation (no cross-store ids), the router with dev-token principals (store_admin write / store_staff read),
// publish → Algolia rules on the fake client, and the Store API relevance path with rules applied.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../http';
import { closePool, initDb, tenantClient } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import {
  FakeIndexClient,
  fullReindex,
  indexNameFor,
  MemoryRulesRepository,
  merchandisingRouter,
  PgRulesRepository,
  ruleObjectId,
  searchRelevance,
  toAlgoliaRule,
  type MerchandisingRule,
  type StoreIndexTarget,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;

let db: TestDatabase;
let app: express.Express;
let fake: FakeIndexClient;
let storeA: StoreIndexTarget;
let productsA: string[];
let productB: string;
let categoryA: string;
let categoryB: string;
let titleA: string;

const as = (subject: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer dev:${subject}`),
});
const storeAdmin = as('seed-store-admin');
const storeStaff = as('seed-store-staff');
const base = `/admin/stores/${A}/merchandising`;

beforeAll(async () => {
  db = await createTestDatabase('core_merch');
  await seed(db.owner, { productsPerStore: 12, log: () => {} });
  // the proposed migration, verbatim (proven here until it lands in packages/db)
  await db.owner.query(
    readFileSync(join(__dirname, 'proposed', '0130_merchandising_rule.sql'), 'utf8'),
  );

  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  fake = new FakeIndexClient();
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier());
  app.use(merchandisingRouter({ repository: new PgRulesRepository(), indexFor: () => fake }));
  app.use(coreErrorHandler);

  const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  storeA = (
    await a.query<StoreIndexTarget>(
      'SELECT id, code, default_currency, search_index FROM store WHERE id = $1',
      [A],
    )
  ).rows[0]!;
  const pa = await a.query<{ id: string; title: string }>(
    `SELECT id, title FROM product WHERE store_id = $1 AND status = 'published' ORDER BY handle LIMIT 5`,
    [A],
  );
  productsA = pa.rows.map((r) => r.id);
  titleA = pa.rows[0]!.title;
  productB = (
    await b.query<{ id: string }>(`SELECT id FROM product WHERE store_id = $1 LIMIT 1`, [B])
  ).rows[0]!.id;
  categoryA = (
    await a.query<{ id: string }>(
      `SELECT id FROM product_category WHERE store_id = $1 ORDER BY handle LIMIT 1`,
      [A],
    )
  ).rows[0]!.id;
  categoryB = (
    await b.query<{ id: string }>(`SELECT id FROM product_category WHERE store_id = $1 LIMIT 1`, [
      B,
    ])
  ).rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('rules API (store_admin write / store_staff read)', () => {
  let ruleId: string;

  it('store_staff reads (empty list) but cannot write', async () => {
    const list = await storeStaff.get(`${base}/rules`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ items: [] });
    const denied = await storeStaff.post(`${base}/rules`, {
      scope: { type: 'category', category_id: categoryA },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('forbidden');
  });

  it('validates the body, the scope and every product id against the store', async () => {
    const bad = await storeAdmin.post(`${base}/rules`, {
      scope: { type: 'category', category_id: categoryA },
      boosts: [{ product_id: productsA[0], weight: 500 }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation_error');

    const noCategory = await storeAdmin.post(`${base}/rules`, { scope: { type: 'category' } });
    expect(noCategory.status).toBe(400);

    const foreignCategory = await storeAdmin.post(`${base}/rules`, {
      scope: { type: 'category', category_id: categoryB },
    });
    expect(foreignCategory.status).toBe(400);
    expect(foreignCategory.body.details).toEqual({ category_id: categoryB });

    const foreignProduct = await storeAdmin.post(`${base}/rules`, {
      scope: { type: 'category', category_id: categoryA },
      pins: [productsA[0], productB],
    });
    expect(foreignProduct.status).toBe(400);
    expect(foreignProduct.body.details).toEqual({ product_ids: [productB] });

    const pinnedAndBuried = await storeAdmin.post(`${base}/rules`, {
      scope: { type: 'category', category_id: categoryA },
      pins: [productsA[0]],
      buries: [productsA[0]],
    });
    expect(pinnedAndBuried.status).toBe(400);
    expect(pinnedAndBuried.body.details['/buries']).toMatch(/pinned/);
  });

  it('creates one rule per scope (409 on a duplicate), gets, patches and deletes it', async () => {
    const created = await storeAdmin.post(`${base}/rules`, {
      scope: { type: 'category', category_id: categoryA },
      pins: [productsA[1], productsA[0]],
      boosts: [{ product_id: productsA[2], weight: 40 }],
      buries: [productsA[3]],
    });
    expect(created.status).toBe(201);
    const rule = created.body as MerchandisingRule;
    expect(rule).toMatchObject({
      scope: { type: 'category', category_id: categoryA },
      pins: [productsA[1], productsA[0]],
      boosts: [{ product_id: productsA[2], weight: 40 }],
      buries: [productsA[3]],
      enabled: true,
      starts_at: null,
      ends_at: null,
      published_at: null,
    });
    expect(rule).not.toHaveProperty('store_id');
    ruleId = rule.id;

    const dup = await storeAdmin.post(`${base}/rules`, {
      scope: { type: 'category', category_id: categoryA },
    });
    expect(dup.status).toBe(409);

    const got = await storeStaff.get(`${base}/rules/${ruleId}`);
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(ruleId);

    const patched = await storeAdmin.patch(`${base}/rules/${ruleId}`, {
      pins: [productsA[4]],
      enabled: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.pins).toEqual([productsA[4]]);
    expect(patched.body.enabled).toBe(false);
    expect(patched.body.buries).toEqual([productsA[3]]); // untouched

    // patch that would bury the currently pinned product → 400 (merged rule is checked)
    const conflictPatch = await storeAdmin.patch(`${base}/rules/${ruleId}`, {
      buries: [productsA[4]],
    });
    expect(conflictPatch.status).toBe(400);

    // brand-b never sees brand-a's rule (RLS through the tenant client)
    const viaB = await storeAdmin.get(`/admin/stores/${B}/merchandising/rules/${ruleId}`);
    expect(viaB.status).toBe(404);
    const listB = await storeAdmin.get(`/admin/stores/${B}/merchandising/rules`);
    expect(listB.body).toEqual({ items: [] });

    const deleted = await storeAdmin.delete(`${base}/rules/${ruleId}`);
    expect(deleted.status).toBe(204);
    expect((await storeAdmin.get(`${base}/rules/${ruleId}`)).status).toBe(404);
    expect((await storeAdmin.delete(`${base}/rules/${ruleId}`)).status).toBe(404);
  });
});

describe('publish → Algolia rules, relevance search with rules applied', () => {
  it('pushes active rules as the complete rule set, skips disabled ones, stamps published_at', async () => {
    const name = indexNameFor(storeA);
    const a = tenantClient({ organizationId: ORG, storeIds: [A], actorId: null });
    await fullReindex(a, storeA, fake);

    const query = await storeAdmin.post(`${base}/rules`, {
      scope: { type: 'query', query: `  ${titleA.toUpperCase()}  ` },
      pins: [productsA[3]],
      buries: [productsA[0]],
    });
    expect(query.status).toBe(201);
    expect(query.body.scope).toEqual({ type: 'query', query: titleA.toLowerCase() });
    const disabled = await storeAdmin.post(`${base}/rules`, {
      scope: { type: 'category', category_id: categoryA },
      pins: [productsA[2]],
      enabled: false,
    });
    expect(disabled.status).toBe(201);

    const published = await storeAdmin.post(`${base}/publish`);
    expect(published.status).toBe(200);
    expect(published.body).toEqual({ index: name, published: 1, skipped: 1 });

    const rules = fake.rules(name);
    expect(rules.map((r) => r.objectID)).toEqual([ruleObjectId(query.body.id)]);
    expect(rules[0]!.conditions).toEqual([{ pattern: titleA.toLowerCase(), anchoring: 'is' }]);
    expect(rules[0]!.consequence.promote).toEqual([{ objectID: productsA[3], position: 0 }]);
    expect(rules[0]!.consequence.hide).toEqual([{ objectID: productsA[0] }]);

    const after = await storeAdmin.get(`${base}/rules`);
    const byId = new Map((after.body.items as MerchandisingRule[]).map((r) => [r.id, r]));
    expect(byId.get(query.body.id)!.published_at).not.toBeNull();
    expect(byId.get(disabled.body.id)!.published_at).toBeNull();

    // Store API relevance path: the pinned product comes first, the buried one is gone
    const hits = await searchRelevance(storeA, fake, { q: titleA, limit: 10 });
    expect(hits.ids[0]).toBe(productsA[3]);
    expect(hits.ids).not.toContain(productsA[0]);
    expect(hits.total).toBeGreaterThanOrEqual(1);

    // a different query does not trigger the rule
    const other = await searchRelevance(storeA, fake, { q: 'zzz-no-such-product' });
    expect(other.ids).toEqual([]);

    // enabling the category rule and republishing replaces the set (2 rules now)
    await storeAdmin.patch(`${base}/rules/${disabled.body.id}`, { enabled: true });
    const again = await storeAdmin.post(`${base}/publish`);
    expect(again.body).toEqual({ index: name, published: 2, skipped: 0 });
    // deterministic (#166 review): the fake promotes a pinned record even into an otherwise empty
    // category listing, so the result is never empty and the pin is always first
    const cat = await searchRelevance(storeA, fake, { category_id: categoryA, limit: 5 });
    expect(cat.ids.length).toBeGreaterThan(0);
    expect(cat.ids[0]).toBe(productsA[2]);
  });

  it('publish answers 409 when the store has no index backend', async () => {
    const noIndex = express();
    mountCoreMiddleware(noIndex, new DevTokenVerifier());
    noIndex.use(
      merchandisingRouter({ repository: new MemoryRulesRepository(), indexFor: () => null }),
    );
    noIndex.use(coreErrorHandler);
    const res = await request(noIndex)
      .post(`${base}/publish`)
      .set('Authorization', 'Bearer dev:seed-store-admin');
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ store_code: storeA.code });
  });
});

describe('toAlgoliaRule (pure) and the in-memory repository', () => {
  const rule: MerchandisingRule = {
    id: 'r1',
    store_id: A,
    scope: { type: 'category', category_id: 'c1' },
    pins: ['p1', 'p2'],
    boosts: [{ product_id: 'p3', weight: 70 }],
    buries: ['p4'],
    enabled: true,
    starts_at: '2026-01-01T00:00:00Z',
    ends_at: null,
    published_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  it('maps scope, pins, boosts, buries and validity', () => {
    const out = toAlgoliaRule(rule);
    expect(out).toEqual({
      objectID: 'merch_r1',
      description: 'merchandising: category c1',
      enabled: true,
      conditions: [{ filters: 'category_id:c1' }],
      consequence: {
        promote: [
          { objectID: 'p1', position: 0 },
          { objectID: 'p2', position: 1 },
        ],
        hide: [{ objectID: 'p4' }],
        params: { optionalFilters: ['objectID:p3<score=70>'] },
      },
      validity: [
        {
          from: Math.floor(Date.UTC(2026, 0, 1) / 1000),
          until: Math.floor(Date.UTC(2100, 0, 1) / 1000),
        },
      ],
    });
    const q = toAlgoliaRule({
      ...rule,
      scope: { type: 'query', query: 'blue tee' },
      starts_at: null,
    });
    expect(q.conditions).toEqual([{ pattern: 'blue tee', anchoring: 'is' }]);
    expect(q.validity).toBeUndefined();
  });

  it('memory repository: one rule per scope, store-scoped reads', async () => {
    const repo = new MemoryRulesRepository();
    const tx = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
    const base = {
      organizationId: ORG,
      storeId: A,
      pins: [],
      boosts: [],
      buries: [],
      enabled: true,
      starts_at: null,
      ends_at: null,
    };
    const r = await repo.create(tx, { ...base, scope: { type: 'query', query: 'tee' } });
    await expect(
      repo.create(tx, { ...base, scope: { type: 'query', query: 'tee' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await repo.create(tx, { ...base, storeId: B, scope: { type: 'query', query: 'tee' } }); // other store ok
    expect((await repo.list(tx, A)).map((x) => x.id)).toEqual([r.id]);
    expect(await repo.get(tx, B, r.id)).toBeNull();
    expect(await repo.update(tx, A, r.id, { enabled: false })).toMatchObject({ enabled: false });
    await repo.markPublished(tx, A, [r.id], new Date());
    expect((await repo.get(tx, A, r.id))!.published_at).not.toBeNull();
    expect(await repo.delete(tx, B, r.id)).toBe(false);
    expect(await repo.delete(tx, A, r.id)).toBe(true);
  });
});
