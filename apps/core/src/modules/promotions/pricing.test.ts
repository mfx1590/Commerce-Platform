// Price lists (task 2.4, #137) on a seeded throwaway database: Admin routes with spec-driven permissions and
// bodies, currency-enabled check, unique constraints, bulk upsert, and the resolution order the cart consumes
// (sale > group/override > default, priority within a rank, expired ignored, group list needs the group,
// tiered min_quantity, integer minor units).
import express from 'express';
import request from 'supertest';
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier, loadSpec } from '../../http';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import { pricingRouter, resolvePrices, type PriceList } from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;

let db: TestDatabase;
let app: express.Express;
let a: ReturnType<typeof createTenantClient>;
let variant1: string;
let variant2: string;
let variantB: string;
let groupId: string;
let defaultListId: string;
let defaultAmount1: number;

const as = (subject: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  put: (path: string, body?: unknown) =>
    request(app).put(path).set('Authorization', `Bearer dev:${subject}`).send(body),
});
const admin = as('seed-store-admin');
const staff = as('seed-store-staff');
const analyst = as('seed-analyst');
const base = `/admin/stores/${A}/price-lists`;
const spec = loadSpec('admin-api.yaml');

const past = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const future = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

async function createList(body: Record<string, unknown>): Promise<PriceList> {
  const res = await admin.post(base, body);
  expect(res.status).toBe(201);
  expect(spec.schema('PriceList')(res.body), JSON.stringify(res.body)).toBe(true);
  return res.body as PriceList;
}

async function putPrices(listId: string, prices: unknown[], expected = 200) {
  const res = await admin.put(`${base}/${listId}/prices`, { prices });
  expect(res.status).toBe(expected);
  return res.body;
}

beforeAll(async () => {
  db = await createTestDatabase('core_pricing');
  await seed(db.owner, { productsPerStore: 6, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier());
  app.use(pricingRouter());
  app.use(coreErrorHandler);

  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  const variants = await a.query<{ id: string }>(
    `SELECT id FROM product_variant WHERE store_id = $1 ORDER BY sku LIMIT 2`,
    [A],
  );
  variant1 = variants.rows[0]!.id;
  variant2 = variants.rows[1]!.id;
  variantB = (
    await b.query<{ id: string }>(`SELECT id FROM product_variant WHERE store_id = $1 LIMIT 1`, [B])
  ).rows[0]!.id;
  const g = await a.query<{ id: string }>(
    `INSERT INTO customer_group (organization_id, store_id, code, name) VALUES ($1, $2, 'vip', 'VIP') RETURNING id`,
    [ORG, A],
  );
  groupId = g.rows[0]!.id;
  const d = await a.query<{ id: string }>(
    `SELECT id FROM price_list WHERE store_id = $1 AND type = 'default' AND currency = 'EUR'`,
    [A],
  );
  defaultListId = d.rows[0]!.id;
  const p = await a.query<{ amount_minor: string }>(
    `SELECT amount_minor::text FROM price WHERE price_list_id = $1 AND variant_id = $2 AND min_quantity = 1`,
    [defaultListId, variant1],
  );
  defaultAmount1 = Number(p.rows[0]!.amount_minor);
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('price-list routes (spec-driven permissions and bodies)', () => {
  it('viewer lists (seeded default list, contract shape); store_staff cannot create; body validated by the spec', async () => {
    const res = await analyst.get(base);
    expect(res.status).toBe(200);
    const items = res.body.items as PriceList[];
    expect(items.some((l) => l.id === defaultListId && l.type === 'default')).toBe(true);
    for (const l of items) expect(spec.schema('PriceList')(l)).toBe(true);

    expect(
      (await staff.post(base, { code: 'x', name: 'x', type: 'sale', currency: 'EUR' })).status,
    ).toBe(403);
    const badType = await admin.post(base, {
      code: 'x',
      name: 'x',
      type: 'flash',
      currency: 'EUR',
    });
    expect(badType.status).toBe(400);
    const missing = await admin.post(base, { code: 'x' });
    expect(missing.status).toBe(400);
  });

  it('currency must be enabled on the store (400); duplicate code and second default → 409; foreign group → 400', async () => {
    const usd = await admin.post(base, {
      code: 'usd-sale',
      name: 'x',
      type: 'sale',
      currency: 'USD',
    });
    expect(usd.status).toBe(400);
    expect(usd.body.details).toEqual({ currency: 'USD' });

    const dupCode = await admin.post(base, {
      code: 'default-eur',
      name: 'x',
      type: 'sale',
      currency: 'EUR',
    });
    expect(dupCode.status).toBe(409);
    const secondDefault = await admin.post(base, {
      code: 'default-eur-2',
      name: 'x',
      type: 'default',
      currency: 'EUR',
    });
    expect(secondDefault.status).toBe(409);

    const badGroup = await admin.post(base, {
      code: 'g',
      name: 'x',
      type: 'override',
      currency: 'EUR',
      customer_group_id: '00000000-0000-4000-8000-0000000000aa',
    });
    expect(badGroup.status).toBe(400);
    const badWindow = await admin.post(base, {
      code: 'w',
      name: 'x',
      type: 'sale',
      currency: 'EUR',
      starts_at: future(2),
      ends_at: future(1),
    });
    expect(badWindow.status).toBe(400);
  });

  it('upsert validates variants and duplicates, forces the list currency, is idempotent', async () => {
    const list = await createList({
      code: 'upsert-test',
      name: 'U',
      type: 'sale',
      currency: 'EUR',
    });
    const foreign = await admin.put(`${base}/${list.id}/prices`, {
      prices: [{ variant_id: variantB, amount_minor: 100 }],
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.details).toEqual({ variant_ids: [variantB] });
    await putPrices(
      list.id,
      [
        { variant_id: variant1, amount_minor: 100 },
        { variant_id: variant1, amount_minor: 90, min_quantity: 1 },
      ],
      400,
    );
    expect(
      (
        await admin.put(`${base}/${list.id}/prices`, {
          prices: [{ variant_id: variant1, amount_minor: 10.5 }],
        })
      ).status,
    ).toBe(400); // spec: integer
    expect((await admin.put(`${base}/nope/prices`, { prices: [] })).status).toBe(400); // uuid param
    expect(
      (await admin.put(`${base}/00000000-0000-4000-8000-0000000000bb/prices`, { prices: [] }))
        .status,
    ).toBe(404);

    const body = await putPrices(list.id, [
      { variant_id: variant1, amount_minor: 500, compare_at_minor: 700 },
      { variant_id: variant1, amount_minor: 450, min_quantity: 10 },
    ]);
    expect(body).toEqual({ upserted: 2 });
    await putPrices(list.id, [{ variant_id: variant1, amount_minor: 480, compare_at_minor: null }]);
    const rows = await a.query<{ amount_minor: string; currency: string; min_quantity: number }>(
      `SELECT amount_minor::text, currency, min_quantity FROM price WHERE price_list_id = $1 ORDER BY min_quantity`,
      [list.id],
    );
    expect(rows.rows).toEqual([
      { amount_minor: '480', currency: 'EUR', min_quantity: 1 },
      { amount_minor: '450', currency: 'EUR', min_quantity: 10 },
    ]);
  });
});

describe('resolution (sale > group > default, priority, windows, groups, tiers)', () => {
  it('walks the whole matrix', async () => {
    // the upsert-test list from the previous describe is an active sale list too — retire it first
    await a.query(
      `UPDATE price_list SET status = 'draft' WHERE store_id = $1 AND code = 'upsert-test'`,
      [A],
    );
    // arrange: sale (prio 0), sale (prio 10), expired sale, group override, tiered rows
    const sale = await createList({
      code: 'r-sale',
      name: 'S',
      type: 'sale',
      currency: 'EUR',
      starts_at: past(1),
      ends_at: future(30),
    });
    const saleHigh = await createList({
      code: 'r-sale-high',
      name: 'SH',
      type: 'sale',
      currency: 'EUR',
      priority: 10,
    });
    const expired = await createList({
      code: 'r-expired',
      name: 'E',
      type: 'sale',
      currency: 'EUR',
      starts_at: past(30),
      ends_at: past(1),
      priority: 99,
    });
    const draft = await createList({
      code: 'r-draft',
      name: 'D',
      type: 'sale',
      currency: 'EUR',
      status: 'draft',
      priority: 99,
    });
    const group = await createList({
      code: 'r-vip',
      name: 'V',
      type: 'override',
      currency: 'EUR',
      customer_group_id: groupId,
    });
    await putPrices(sale.id, [
      { variant_id: variant1, amount_minor: 800 },
      { variant_id: variant1, amount_minor: 600, min_quantity: 5 },
    ]);
    await putPrices(saleHigh.id, [{ variant_id: variant1, amount_minor: 850 }]);
    await putPrices(expired.id, [{ variant_id: variant1, amount_minor: 1 }]);
    await putPrices(draft.id, [{ variant_id: variant1, amount_minor: 2 }]);
    await putPrices(group.id, [
      { variant_id: variant1, amount_minor: 300 },
      { variant_id: variant2, amount_minor: 999 },
    ]);

    const resolve = (q: Partial<Parameters<typeof resolvePrices>[2]> = {}) =>
      resolvePrices(a, A, { variantIds: [variant1, variant2], currency: 'EUR', ...q });

    // sale beats default and group; higher priority beats lower even when more expensive
    const anon = await resolve();
    expect(anon.get(variant1)).toMatchObject({
      amount_minor: 850,
      price_list_id: saleHigh.id,
      list_type: 'sale',
    });
    // variant2 has no sale price → default list price (group list needs the group)
    expect(anon.get(variant2)).toMatchObject({ list_type: 'default' });

    // expired and draft lists are ignored despite priority 99
    expect(anon.get(variant1)!.amount_minor).not.toBe(1);
    expect(anon.get(variant1)!.amount_minor).not.toBe(2);

    // the group list applies only with the customer's group; sale still outranks it for variant1
    const vip = await resolve({ customerGroupIds: [groupId] });
    expect(vip.get(variant1)!.list_type).toBe('sale');
    expect(vip.get(variant2)).toMatchObject({
      amount_minor: 999,
      price_list_id: group.id,
      list_type: 'override',
    });

    // tiers: quantity 5 hits the min_quantity 5 row of the winning-rank... saleHigh has only qty-1;
    // equal rank + priority? no — saleHigh (prio 10) still wins with its qty-1 row at quantity 5
    const qty5 = await resolve({ quantity: 5 });
    expect(qty5.get(variant1)!.amount_minor).toBe(850);
    // remove the high-priority list from the window → the tiered sale row wins at qty 5
    await a.query(`UPDATE price_list SET status = 'draft' WHERE id = $1`, [saleHigh.id]);
    const tier = await resolve({ quantity: 5 });
    expect(tier.get(variant1)).toMatchObject({ amount_minor: 600, price_list_id: sale.id });
    expect((await resolve({ quantity: 4 })).get(variant1)!.amount_minor).toBe(800);

    // date window edge: at exactly ends_at the list no longer applies
    const atEnd = await resolvePrices(a, A, {
      variantIds: [variant1],
      currency: 'EUR',
      at: new Date(expired.ends_at!),
    });
    expect(atEnd.get(variant1)!.price_list_id).not.toBe(expired.id);

    // unknown currency → variant absent (not sellable), never a crash
    const chf = await resolvePrices(a, A, { variantIds: [variant1], currency: 'CHF' });
    expect(chf.size).toBe(0);

    // sanity: without any custom lists variant1 would fall back to the seeded default amount
    await a.query(`UPDATE price_list SET status = 'draft' WHERE id = ANY($1)`, [
      [sale.id, group.id],
    ]);
    const fallback = await resolve();
    expect(fallback.get(variant1)).toMatchObject({
      amount_minor: defaultAmount1,
      price_list_id: defaultListId,
      list_type: 'default',
    });
  });

  it('brand-b sees none of brand-a lists through its client (RLS)', async () => {
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
    const r = await b.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM price_list WHERE store_id = $1`,
      [A],
    );
    expect(r.rows[0]!.n).toBe('0');
    const resolved = await resolvePrices(b, A, { variantIds: [variant1], currency: 'EUR' });
    expect(resolved.size).toBe(0);
  });
});
