// Promotion storage + routes + usage + report (task 2.5, #138) on a seeded throwaway database with dev-token
// principals: spec permission on list/create, local ones on get/patch, validation against the store's catalog,
// jsonb round trip of stackable/exclusive/buy-X-get-Y, atomic usage counting to the limit (contract error),
// and the report provider over the "order" read model.
import express from 'express';
import request from 'supertest';
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../http';
import { closePool, initDb, tenantClient } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import {
  evaluatePromotions,
  loadCandidatePromotions,
  promotionReportData,
  promotionsRouter,
  recordPromotionUse,
  type Promotion,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;

let db: TestDatabase;
let app: express.Express;
let a: ReturnType<typeof createTenantClient>;
let productA: string;
let categoryB: string;

const as = (subject: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
});
const admin = as('seed-store-admin');
const staff = as('seed-store-staff');
const analyst = as('seed-analyst');
const base = `/admin/stores/${A}/promotions`;

beforeAll(async () => {
  db = await createTestDatabase('core_promo');
  await seed(db.owner, { productsPerStore: 6, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier());
  app.use(promotionsRouter());
  app.use(coreErrorHandler);

  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  productA = (
    await a.query<{ id: string }>(`SELECT id FROM product WHERE store_id = $1 LIMIT 1`, [A])
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

describe('promotion CRUD', () => {
  let couponId: string;

  it('creates with normalised code and jsonb-stored stacking fields; store_staff cannot write', async () => {
    expect((await staff.post(base, { name: 'x', type: 'percentage', value: 1 })).status).toBe(403);

    const res = await admin.post(base, {
      code: ' search10 ',
      name: 'Welcome 10%',
      type: 'percentage',
      value: 1000,
      rules: { product_ids: [productA], first_order_only: true },
      usage_limit: 3,
      status: 'active',
      stackable: true,
    });
    expect(res.status).toBe(201);
    const p = res.body as Promotion;
    expect(p.code).toBe('SEARCH10');
    expect(p.stackable).toBe(true);
    expect(p.exclusive).toBe(false);
    expect(p.usage_count).toBe(0);
    expect(p.rules).toEqual({ product_ids: [productA], first_order_only: true });
    couponId = p.id;
    // jsonb round trip: stackable lives inside the rules column, not a table column
    const raw = await a.query<{ rules: Record<string, unknown> }>(
      `SELECT rules FROM promotion WHERE id = $1`,
      [couponId],
    );
    expect(raw.rows[0]!.rules.stackable).toBe(true);

    expect(
      (await admin.post(base, { code: 'SEARCH10', name: 'dup', type: 'percentage', value: 1 }))
        .status,
    ).toBe(409);
  });

  it('validates types, rules and store ownership of rule ids', async () => {
    expect((await admin.post(base, { name: 'x', type: 'percentage', value: 20000 })).status).toBe(
      400,
    );
    expect((await admin.post(base, { name: 'x', type: 'fixed_amount', value: 100 })).status).toBe(
      400,
    ); // no currency
    expect(
      (await admin.post(base, { name: 'x', type: 'fixed_amount', value: 100, currency: 'USD' }))
        .status,
    ).toBe(400); // not enabled
    expect((await admin.post(base, { name: 'x', type: 'buy_x_get_y' })).status).toBe(400); // buy/get missing
    expect(
      (
        await admin.post(base, {
          name: 'x',
          type: 'percentage',
          value: 1,
          rules: { buy_quantity: 2 },
        })
      ).status,
    ).toBe(400); // buy rules on a non-bxgy type
    expect(
      (
        await admin.post(base, {
          name: 'x',
          type: 'percentage',
          value: 1,
          stackable: true,
          exclusive: true,
        })
      ).status,
    ).toBe(400);
    const foreign = await admin.post(base, {
      name: 'x',
      type: 'percentage',
      value: 1,
      rules: { category_ids: [categoryB] },
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.details).toEqual({ category_ids: [categoryB] });

    const bxgy = await admin.post(base, {
      name: '3 for 2',
      type: 'buy_x_get_y',
      rules: { buy_quantity: 2, get_quantity: 1 },
      status: 'active',
    });
    expect(bxgy.status).toBe(201);
    expect(bxgy.body.rules).toEqual({ buy_quantity: 2, get_quantity: 1 });
  });

  it('lists with paging/sort/status filter; gets and patches (code/type immutable by schema)', async () => {
    const list = await analyst.get(`${base}?status=active&sort=code&order=asc&limit=1`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.total).toBeGreaterThanOrEqual(2);
    expect((await analyst.get(`${base}?sort=nope`)).status).toBe(400);

    const got = await analyst.get(`${base}/${couponId}`);
    expect(got.status).toBe(200);
    expect(got.body.code).toBe('SEARCH10');
    expect((await staff.patch(`${base}/${couponId}`, { status: 'disabled' })).status).toBe(403);
    expect((await admin.patch(`${base}/${couponId}`, {})).status).toBe(400);
    expect((await admin.patch(`${base}/${couponId}`, { code: 'NEW' })).status).toBe(400); // immutable
    const patched = await admin.patch(`${base}/${couponId}`, {
      status: 'disabled',
      exclusive: true,
      stackable: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: 'disabled', exclusive: true, stackable: false });
    await admin.patch(`${base}/${couponId}`, {
      status: 'active',
      exclusive: false,
      stackable: true,
    });
    expect((await admin.get(`/admin/stores/${B}/promotions/${couponId}`)).status).toBe(404); // RLS
  });

  it('loadCandidatePromotions returns automatic promos plus matching codes only', async () => {
    const auto = await loadCandidatePromotions(a, A);
    expect(auto.every((p) => p.code === null)).toBe(true);
    const withCode = await loadCandidatePromotions(a, A, ['search10 ']);
    expect(withCode.some((p) => p.code === 'SEARCH10')).toBe(true);
  });

  it("another store's code is not_found here, not a silent discount (RLS + engine)", async () => {
    // brand-b owns BONLY; a brand-a cart quoting it must be told the code does not exist
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
    await b.query(
      `INSERT INTO promotion (organization_id, store_id, code, name, type, value, status)
       VALUES ($1, $2, 'BONLY', 'Brand B only', 'percentage', 5000, 'active')`,
      [ORG, B],
    );
    const loaded = await loadCandidatePromotions(a, A, ['BONLY']);
    expect(loaded.some((p) => p.code === 'BONLY')).toBe(false);

    const quote = evaluatePromotions(
      [{ id: 'l1', product_id: productA, quantity: 1, unit_price_minor: 1000 }],
      loaded,
      { currency: 'EUR', codes: ['BONLY'], at: new Date('2026-09-14T12:00:00Z') },
    );
    expect(quote.discount_minor).toBe(0);
    expect(quote.rejected).toContainEqual({
      promotion_id: null,
      code: 'BONLY',
      reason: 'not_found',
    });
    // and it still works for the store that owns it
    expect((await loadCandidatePromotions(b, B, ['bonly'])).some((p) => p.code === 'BONLY')).toBe(
      true,
    );
  });

  it('recordPromotionUse counts atomically and refuses past the limit with the contract error', async () => {
    const client = tenantClient({ organizationId: ORG, storeIds: [A], actorId: null });
    await client.transaction(async (tx) => {
      await recordPromotionUse(tx, A, couponId);
      await recordPromotionUse(tx, A, couponId);
      await recordPromotionUse(tx, A, couponId);
    });
    const full = await client
      .transaction((tx) => recordPromotionUse(tx, A, couponId))
      .catch((e: unknown) => e);
    expect(full).toMatchObject({ code: 'conflict' });
    expect((await analyst.get(`${base}/${couponId}`)).body.usage_count).toBe(3);
    const missing = await client
      .transaction((tx) => recordPromotionUse(tx, A, '00000000-0000-4000-8000-0000000000ee'))
      .catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'not_found' });
  });
});

describe('promotion report provider (window 17 data)', () => {
  it('aggregates uses, discount and revenue per code from non-cancelled orders in the window', async () => {
    // fixture orders straight into the read model (the order table is window 1's; writing fixtures in a
    // throwaway test database is not production code)
    const channel = await a.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 LIMIT 1`,
      [A],
    );
    const insert = (
      display: number,
      codes: string[],
      discount: number,
      total: number,
      status = 'confirmed',
      at = '2026-09-05T10:00:00Z',
    ) =>
      db.owner.query(
        `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, email, currency, locale, status,
                              shipping_address, billing_address, promotion_codes, subtotal_minor, discount_minor, total_minor, placed_at)
         VALUES ($1, $2, $3, $4, 'r@example.com', 'EUR', 'en', $5, '{}', '{}', $6, $7, $8, $9, $10)`,
        [
          ORG,
          A,
          display,
          channel.rows[0]!.id,
          status,
          codes,
          total + discount,
          discount,
          total,
          at,
        ],
      );
    await insert(9001, ['WELCOME10'], 200, 1800);
    await insert(9002, ['WELCOME10', 'SHIP'], 300, 2700);
    await insert(9003, ['SHIP'], 0, 500);
    await insert(9004, ['WELCOME10'], 100, 900, 'cancelled'); // excluded
    await insert(9005, ['WELCOME10'], 100, 900, 'confirmed', '2026-10-05T10:00:00Z'); // outside the window

    const report = await promotionReportData(
      a,
      A,
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(report.currency).toBe('EUR');
    const byCode = new Map(report.items.map((i) => [i.code, i]));
    expect(byCode.get('WELCOME10')).toMatchObject({
      uses: 2,
      discount_given: { amount_minor: 500, currency: 'EUR' },
      revenue: { amount_minor: 4500, currency: 'EUR' },
    });
    expect(byCode.get('WELCOME10')!.promotion_id).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(byCode.get('SHIP')).toMatchObject({
      uses: 2,
      revenue: { amount_minor: 3200, currency: 'EUR' },
    });
  });
});
