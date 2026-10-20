// Integration 3, gate G2 (#519): two brands buy from ONE stock pool through the APIs they actually use. Brand A and
// brand B each sell a variant that maps the seeded shared stock item (`SEED_IDS.sharedStock`); a brand only ever
// talks to the Store API with its own publishable key, HQ fulfils through the Admin API with a dev token. The
// module-level proofs are inventory/shared-pool.test.ts and hq-warehouse/shared-pool.test.ts; this file proves the
// same pool through HTTP, on its own throwaway database (no shared-data writes). It prints the order ids and the
// quantities at every step.
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminNotFound, coreErrorHandler, DevTokenVerifier, moduleAdminRouters } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { stockAwareAllocationPolicy } from '../src/modules/hq-warehouse';
import { priorityGreedyPolicy, setAllocationPolicy } from '../src/modules/inventory';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const store = specValidator('store-api.yaml');
const admin = specValidator('admin-api.yaml');
const ORG = SEED_IDS.organization;
const ITEM = SEED_IDS.sharedStock.stockItem;
const EU = SEED_IDS.warehouses.eu;
const ON_HAND = 5;

interface Brand {
  name: 'A' | 'B';
  storeId: string;
  key: string;
  variantId: string;
  country: string;
  handle: string;
}

let db: TestDatabase;
let app: express.Express;
let owner: ReturnType<typeof createOrganizationClient>;
let A: Brand;
let B: Brand;

const log = (step: string, facts: Record<string, unknown>) =>
  console.info(`[#519 G2] ${step}: ${JSON.stringify(facts)}`);

const pool = async () => {
  const r = await owner.query<{ warehouse_id: string; on_hand: number; reserved: number }>(
    `SELECT warehouse_id, on_hand, reserved FROM inventory_level WHERE stock_item_id = $1 ORDER BY warehouse_id`,
    [ITEM],
  );
  const sum = (k: 'on_hand' | 'reserved') => r.rows.reduce((n, row) => n + row[k], 0);
  return { on_hand: sum('on_hand'), reserved: sum('reserved') };
};

const storeApi = (b: Brand) => ({
  get: (path: string) => request(app).get(path).set('X-Publishable-Key', b.key),
  post: (path: string) =>
    request(app).post(path).set('X-Publishable-Key', b.key).set('Content-Type', 'application/json'),
  patch: (path: string) =>
    request(app)
      .patch(path)
      .set('X-Publishable-Key', b.key)
      .set('Content-Type', 'application/json'),
});
const hq = {
  post: (path: string, body: unknown) =>
    request(app).post(path).set('Authorization', 'Bearer dev:seed-operations').send(body),
  patch: (path: string, body: unknown) =>
    request(app).patch(path).set('Authorization', 'Bearer dev:seed-operations').send(body),
};

/** What the brand's storefront shows for its variant of the shared item (Store API product read). */
async function availableIn(b: Brand): Promise<number> {
  const res = await storeApi(b).get(`/store/products/${b.handle}`);
  expect(res.status).toBe(200);
  store.assertSchema('Product', res.body);
  const v = (res.body.variants as { id: string; available_quantity: number }[]).find(
    (x) => x.id === b.variantId,
  );
  expect(v).toBeDefined();
  return v!.available_quantity;
}

/** One order through the brand's Store API: cart → line → shipping → manual payment → complete. */
async function buy(b: Brand, quantity: number) {
  const api = storeApi(b);
  const cart = await api.post('/store/carts').send({ country: b.country });
  expect(cart.status).toBe(201);
  const line = await api
    .post(`/store/carts/${cart.body.id}/line-items`)
    .send({ variant_id: b.variantId, quantity });
  if (line.status !== 200) return { status: line.status, body: line.body, order: null };
  const options = await api.get(`/store/carts/${cart.body.id}/shipping-options`);
  expect(options.status).toBe(200);
  const address = {
    first_name: 'Pool',
    last_name: 'Gate',
    line1: 'Main Street 1',
    city: b.country === 'GB' ? 'London' : 'Amsterdam',
    postal_code: b.country === 'GB' ? 'N1 9GU' : '1015 CJ',
    country: b.country,
  };
  const updated = await api.patch(`/store/carts/${cart.body.id}`).send({
    email: `g2-${b.name.toLowerCase()}@example.com`,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: options.body.items[0].id,
  });
  expect(updated.status).toBe(200);
  const session = await api
    .post(`/store/carts/${cart.body.id}/payment-session`)
    .send({ provider: 'manual' });
  expect(session.status).toBe(200);
  const placed = await api
    .post(`/store/carts/${cart.body.id}/complete`)
    .set('Idempotency-Key', `g2-${cart.body.id}`)
    .send();
  return {
    status: placed.status,
    body: placed.body,
    order: placed.status === 201 ? placed.body : null,
  };
}

beforeAll(async () => {
  db = await createTestDatabase('core_two_brands_one_pool');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), { moduleRouters: moduleAdminRouters() });
  app.use('/admin', adminNotFound);
  app.use(coreErrorHandler);
  // what createServer() registers (src/wiring.ts): window 11's engine decides the warehouse
  setAllocationPolicy(stockAwareAllocationPolicy);

  const brand = async (
    name: 'A' | 'B',
    storeId: string,
    key: string,
    variantId: string,
    country: string,
  ): Promise<Brand> => {
    const r = await owner.query<{
      handle: string;
      stock_item_id: string;
      allow_backorder: boolean;
    }>(
      `SELECT p.handle, v.stock_item_id, v.allow_backorder
       FROM product_variant v JOIN product p ON p.id = v.product_id WHERE v.id = $1`,
      [variantId],
    );
    // the seed pools both brands' first variant on one item, sold without backorder
    expect(r.rows[0]).toMatchObject({ stock_item_id: ITEM, allow_backorder: false });
    return { name, storeId, key, variantId, country, handle: r.rows[0]!.handle };
  };
  A = await brand(
    'A',
    SEED_IDS.stores.brandA,
    SEED_IDS.publishableKeys.brandA,
    SEED_IDS.sharedStock.variantBrandA,
    'NL',
  );
  B = await brand(
    'B',
    SEED_IDS.stores.brandB,
    SEED_IDS.publishableKeys.brandB,
    SEED_IDS.sharedStock.variantBrandB,
    'GB',
  );
  // fixture on the throwaway database: a known shelf — ON_HAND in wh-eu, none in wh-us, nothing reserved
  await owner.query(
    `UPDATE inventory_level SET on_hand = CASE warehouse_id WHEN $2::uuid THEN $3::int ELSE 0 END, reserved = 0
     WHERE stock_item_id = $1`,
    [ITEM, EU, ON_HAND],
  );
}, 180_000);

afterAll(async () => {
  setAllocationPolicy(priorityGreedyPolicy);
  await closePool();
  await db?.drop();
});

describe('G2 (#519): two brands, one stock pool, through the Store and Admin APIs', () => {
  it('A buys, B sees it; HQ ships A; B buys the rest; neither brand can oversell', async () => {
    expect(await pool()).toEqual({ on_hand: ON_HAND, reserved: 0 });
    expect(await availableIn(A)).toBe(ON_HAND);
    expect(await availableIn(B)).toBe(ON_HAND);
    log('start', {
      stock_item_id: ITEM,
      on_hand: ON_HAND,
      available_a: ON_HAND,
      available_b: ON_HAND,
    });

    // 1. brand A places 2 through its Store API
    const first = await buy(A, 2);
    expect(first.status).toBe(201);
    store.assertSchema('Order', first.body);
    const orderA = first.order!;
    expect(orderA).toMatchObject({ status: 'confirmed', payment_status: 'authorized' });
    expect(await pool()).toEqual({ on_hand: ON_HAND, reserved: 2 });

    // 2. brand B's storefront shows the pool minus A's reservation
    const afterA = { a: await availableIn(A), b: await availableIn(B) };
    expect(afterA).toEqual({ a: ON_HAND - 2, b: ON_HAND - 2 });
    log('A placed', { order_a: orderA.id, quantity: 2, ...(await pool()), available_b: afterA.b });

    // 3. HQ ships A's order through the Admin API: on_hand drops by 2, one sale movement, B unchanged
    const reserved = await owner.query<{ warehouse_id: string; allocation_rule: string }>(
      `SELECT warehouse_id, allocation_rule FROM reservation WHERE order_id = $1`,
      [orderA.id],
    );
    expect(reserved.rows).toEqual([{ warehouse_id: EU, allocation_rule: expect.any(String) }]);
    const shipment = await hq.post(`/admin/stores/${A.storeId}/orders/${orderA.id}/shipments`, {
      warehouse_id: EU,
      items: orderA.items.map((i: { id: string; quantity: number }) => ({
        order_line_item_id: i.id,
        quantity: i.quantity,
      })),
    });
    expect(shipment.status).toBe(201);
    admin.assertSchema('Shipment', shipment.body);
    const shipped = await hq.patch(`/admin/shipments/${shipment.body.id}`, { status: 'shipped' });
    expect(shipped.status).toBe(200);
    expect(shipped.body.status).toBe('shipped');
    expect(await pool()).toEqual({ on_hand: ON_HAND - 2, reserved: 0 });
    const sales = await owner.query<{
      store_id: string;
      variant_id: string;
      delta: number;
      warehouse_id: string;
    }>(
      `SELECT store_id, variant_id, delta, warehouse_id FROM stock_movement
       WHERE stock_item_id = $1 AND reason = 'sale'`,
      [ITEM],
    );
    expect(sales.rows).toEqual([
      { store_id: A.storeId, variant_id: A.variantId, delta: -2, warehouse_id: EU },
    ]);
    const afterShip = { a: await availableIn(A), b: await availableIn(B) };
    expect(afterShip).toEqual({ a: ON_HAND - 2, b: ON_HAND - 2 });
    log('A shipped', {
      order_a: orderA.id,
      shipment: shipment.body.id,
      sale_delta: -2,
      ...(await pool()),
      available_b: afterShip.b,
    });

    // 4. brand B buys everything that is left; then a further unit is refused in BOTH brands
    const rest = ON_HAND - 2;
    const second = await buy(B, rest);
    expect(second.status).toBe(201);
    const orderB = second.order!;
    expect(await pool()).toEqual({ on_hand: rest, reserved: rest });
    expect({ a: await availableIn(A), b: await availableIn(B) }).toEqual({ a: 0, b: 0 });
    log('B placed', { order_b: orderB.id, quantity: rest, ...(await pool()), available_a: 0 });

    for (const b of [A, B]) {
      const extra = await buy(b, 1);
      // refused at the line (409 out of stock) or at placement — never an order
      expect(extra.order).toBeNull();
      expect(extra.status).toBe(409);
      expect(extra.body.code).toBe('out_of_stock');
      log(`one more unit for brand ${b.name}`, { status: extra.status, code: extra.body.code });
    }
    const orders = await owner.query<{ n: string }>(
      `SELECT count(DISTINCT r.order_id)::text AS n FROM reservation r WHERE r.stock_item_id = $1`,
      [ITEM],
    );
    expect(Number(orders.rows[0]!.n)).toBe(2);
    expect(await pool()).toEqual({ on_hand: rest, reserved: rest }); // nothing oversold, nothing lost
    log('end', { orders: [orderA.id, orderB.id], ...(await pool()) });
  });
});
