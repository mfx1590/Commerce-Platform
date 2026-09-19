// The pick/pack lifecycle on a seeded database: the two moves, the events they write to the outbox, what they
// refuse, and the pick list a warehouse floor reads. The statuses come from migration 0160 and the topics from
// events 0.3.0 (CONTRACT CHANGE #225, contracts-v0.4.3).
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../http';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import { addLineItem, createCart, updateCart } from '../cart';
import { completeCart, createPaymentSession } from '../checkout';
import { confirmOrder } from '../orders';
import { createShipment, getShipment, updateShipment } from '../shipping';
import {
  clearPendingLifecycleEvents,
  pendingLifecycleEvents,
  topicIsKnown,
} from './lifecycle-events';
import { listPickLists, packShipment, pickShipment } from './lifecycle';
import { fulfillmentAdminRouter } from './http';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const EU = SEED_IDS.warehouses.eu;
const US = SEED_IDS.warehouses.us;
const actor = { id: null, type: 'staff' as const, requestId: 'req-lifecycle-2-5' };
const address = {
  first_name: 'Jane',
  last_name: 'Doe',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let variants: string[];
let optionId: string;
let counter = 0;

beforeAll(async () => {
  db = await createTestDatabase('core_lifecycle');
  await seed(db.owner, { log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
  const vs = await owner.query<{ id: string }>(
    `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
      JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
      WHERE v.store_id = $1
        AND coalesce((SELECT sum(il.available) FROM inventory_level il WHERE il.variant_id = v.id), 0) >= 20
      ORDER BY v.sku LIMIT 12`,
    [A],
  );
  variants = vs.rows.map((row) => row.id);
  optionId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
      [A],
    )
  ).rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

beforeEach(() => {
  clearPendingLifecycleEvents();
});

/** A confirmed order with one line of 2 units, and a shipment planned for it. */
async function plannedShipment(warehouseId = EU) {
  const n = counter++;
  const cart = await createCart(a, scopeA);
  await addLineItem(a, cart.id, { variant_id: variants[n % variants.length]!, quantity: 2 });
  await updateCart(a, cart.id, {
    email: `floor+${n}@example.com`,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: optionId,
  });
  await createPaymentSession(a, cart.id, { provider: 'manual' });
  const placed = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `life-2-5-${n}-${cart.id}`,
    actor: { id: null, type: 'customer', requestId: 'req-place' },
  });
  await confirmOrder(a, placed.order.id, actor);
  const line = (
    await owner.query<{ id: string }>(
      `SELECT id FROM order_line_item WHERE order_id = $1 ORDER BY created_at LIMIT 1`,
      [placed.order.id],
    )
  ).rows[0]!;
  const shipment = await createShipment(a, {
    orderId: placed.order.id,
    warehouseId,
    items: [{ order_line_item_id: line.id, quantity: 2 }],
    actor,
  });
  return { orderId: placed.order.id, lineId: line.id, shipment };
}

const outboxFor = (shipmentId: string) =>
  owner.query<{ topic: string; payload: Record<string, unknown> }>(
    `SELECT topic, payload FROM outbox WHERE aggregate_type = 'shipment' AND aggregate_id = $1
      ORDER BY occurred_at, seq`,
    [shipmentId],
  );

describe('pick and pack', () => {
  it('moves pending → picking → packed, emitting one lifecycle event each', async () => {
    const { shipment } = await plannedShipment();

    const picking = await pickShipment(a, shipment.id, actor);
    expect(picking.status).toBe('picking');

    const packed = await packShipment(a, shipment.id, { actor, parcelCount: 2 });
    expect(packed.status).toBe('packed');

    // One event per transition, not two — and the shipment's own stream still starts with its creation.
    const topics = (await outboxFor(shipment.id)).rows.map((row) => row.topic);
    expect(topics).toEqual(['shipment.created', 'fulfillment.picking', 'fulfillment.packed']);
  });

  it('writes each lifecycle event to the outbox, with the payload the schema requires', async () => {
    const { shipment, orderId, lineId } = await plannedShipment();
    await pickShipment(a, shipment.id, actor);
    await packShipment(a, shipment.id, { actor, parcelCount: 2 });

    // events 0.3.0 shipped the topics, so nothing is buffered any more.
    expect(topicIsKnown('fulfillment.picking')).toBe(true);
    expect(topicIsKnown('fulfillment.packed')).toBe(true);
    expect(pendingLifecycleEvents()).toEqual([]);

    const rows = await outboxFor(shipment.id);
    expect(rows.rows.map((row) => row.topic)).toEqual([
      'shipment.created',
      'fulfillment.picking',
      'fulfillment.packed',
    ]);
    const picking = rows.rows.find((row) => row.topic === 'fulfillment.picking')!;
    expect(picking.payload).toEqual({
      shipment_id: shipment.id,
      order_id: orderId,
      warehouse_id: EU,
      items: [{ order_line_item_id: lineId, quantity: 2 }],
      occurred_at: expect.any(String),
    });
    const packed = rows.rows.find((row) => row.topic === 'fulfillment.packed')!;
    expect(packed.payload).toMatchObject({ shipment_id: shipment.id, parcel_count: 2 });
    // Warehouse events carry ids and quantities, never a person or a place.
    expect(JSON.stringify(rows.rows)).not.toMatch(/Keizersgracht|Amsterdam|Jane/);
  });

  it('refuses the same move twice and any move backwards', async () => {
    const { shipment } = await plannedShipment();
    await pickShipment(a, shipment.id, actor);
    await expect(pickShipment(a, shipment.id, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { status: 'picking' },
    });
    await packShipment(a, shipment.id, { actor });
    await expect(pickShipment(a, shipment.id, actor)).rejects.toMatchObject({ code: 'conflict' });
    expect((await getShipment(a, shipment.id)).status).toBe('packed');
  });

  it('allows skipping picking, and refuses picking once the parcel has gone', async () => {
    const straightToPacked = await plannedShipment();
    // A small store packs without a pick step: pending → packed is a forward move.
    expect((await packShipment(a, straightToPacked.shipment.id, { actor })).status).toBe('packed');

    const gone = await plannedShipment();
    await updateShipment(a, gone.shipment.id, { status: 'shipped', actor });
    await expect(pickShipment(a, gone.shipment.id, actor)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('rejects a parcel count that is not a positive integer', async () => {
    const { shipment } = await plannedShipment();
    await expect(packShipment(a, shipment.id, { actor, parcelCount: 0 })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(packShipment(a, shipment.id, { actor, parcelCount: 1.5 })).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect((await getShipment(a, shipment.id)).status).toBe('pending');
  });
});

describe('pick lists', () => {
  it('groups open work by warehouse, oldest first, and leaves finished shipments out', async () => {
    const first = await plannedShipment(EU);
    const second = await plannedShipment(US);
    const done = await plannedShipment(EU);
    await pickShipment(a, second.shipment.id, actor);
    await updateShipment(a, done.shipment.id, { status: 'shipped', actor });

    const lists = await listPickLists(a, A);
    const ids = lists.items.flatMap((group) => group.shipments.map((s) => s.id));
    expect(ids).toContain(first.shipment.id);
    expect(ids).toContain(second.shipment.id);
    expect(ids).not.toContain(done.shipment.id);

    const eu = lists.items.find((group) => group.warehouse_id === EU)!;
    expect(eu.warehouse_code).toBe('wh-eu');
    expect(lists.items.find((group) => group.warehouse_id === US)!.shipments[0]).toMatchObject({
      id: second.shipment.id,
      status: 'picking',
    });
  });

  it('filters by warehouse and by status, and pages over shipments', async () => {
    const mine = await plannedShipment(US);
    await pickShipment(a, mine.shipment.id, actor);

    const byWarehouse = await listPickLists(a, A, { warehouseId: US });
    expect(byWarehouse.items).toHaveLength(1);
    expect(byWarehouse.items[0]!.warehouse_id).toBe(US);

    const picking = await listPickLists(a, A, { status: 'picking' });
    expect(picking.items.flatMap((g) => g.shipments).every((s) => s.status === 'picking')).toBe(
      true,
    );

    const firstPage = await listPickLists(a, A, { limit: 1, page: 1 });
    expect(firstPage.items.flatMap((g) => g.shipments)).toHaveLength(1);
    expect(firstPage.page).toMatchObject({ page: 1, limit: 1 });
    expect(firstPage.page.total).toBeGreaterThan(1);
    const secondPage = await listPickLists(a, A, { limit: 1, page: 2 });
    expect(secondPage.items.flatMap((g) => g.shipments)[0]!.id).not.toBe(
      firstPage.items.flatMap((g) => g.shipments)[0]!.id,
    );
  });
});

describe('fulfillmentAdminRouter', () => {
  let app: express.Express;
  const as = (subject: string) => ({
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
    post: (path: string, body?: unknown) =>
      request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  });

  beforeAll(() => {
    app = express();
    mountCoreMiddleware(app, new DevTokenVerifier());
    app.use(fulfillmentAdminRouter());
    app.use(coreErrorHandler);
  });

  it('picks and packs through the API, with the permission the spec names', async () => {
    const { shipment } = await plannedShipment();

    // `operations` on the organization — a store admin does not have it.
    expect((await as('seed-store-admin').post(`/admin/shipments/${shipment.id}/pick`)).status).toBe(
      403,
    );

    const picked = await as('seed-operations').post(`/admin/shipments/${shipment.id}/pick`);
    expect(picked.status).toBe(200);
    expect(picked.body).toMatchObject({ id: shipment.id, status: 'picking' });

    const packed = await as('seed-operations').post(`/admin/shipments/${shipment.id}/pack`, {
      parcel_count: 3,
    });
    expect(packed.status).toBe(200);
    expect(packed.body.status).toBe('packed');

    // The same move twice, and a move backwards, are both 409.
    expect((await as('seed-operations').post(`/admin/shipments/${shipment.id}/pack`)).status).toBe(
      409,
    );
    expect((await as('seed-operations').post(`/admin/shipments/${shipment.id}/pick`)).status).toBe(
      409,
    );
  });

  it('refuses a parcel count that is not a positive integer, and an unknown shipment', async () => {
    const { shipment } = await plannedShipment();
    const bad = await as('seed-operations').post(`/admin/shipments/${shipment.id}/pack`, {
      parcel_count: 0,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation_error');

    const missing = await as('seed-operations').post(
      '/admin/shipments/00000000-0000-4000-8000-000000000000/pick',
    );
    expect(missing.status).toBe(404);
    expect((await as('seed-operations').post('/admin/shipments/not-a-uuid/pick')).status).toBe(400);
  });

  it('answers 404 for a shipment in another organization, never 403 or its contents', async () => {
    // A second organization, invisible to this one. Guessing its shipment id must look exactly like guessing
    // an id that does not exist — no existence leak, no cross-tenant read.
    const other = await owner.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ('Other Co', 'other-co') RETURNING id`,
    );
    const otherOrg = other.rows[0]!.id;
    const entity = await owner.query<{ id: string }>(
      `INSERT INTO legal_entity (organization_id, code, name, country, currency)
       VALUES ($1, 'other-co', 'Other Co Ltd', 'US', 'USD') RETURNING id`,
      [otherOrg],
    );
    const otherStore = await owner.query<{ id: string }>(
      `INSERT INTO store (organization_id, legal_entity_id, code, name, default_currency, default_locale,
         default_country) VALUES ($1, $2, 'other', 'Other', 'USD', 'en-US', 'US') RETURNING id`,
      [otherOrg, entity.rows[0]!.id],
    );
    const otherOrder = await owner.query<{ id: string }>(
      `INSERT INTO "order" (organization_id, store_id, sales_channel_id, email, currency, locale, status,
         payment_status, shipping_address, billing_address, subtotal_minor, discount_minor, shipping_minor,
         tax_minor, total_minor)
       SELECT $1, $2, sc.id, 'someone@other.example', 'USD', 'en-US', 'confirmed', 'authorized',
              '{}'::jsonb, '{}'::jsonb, 0, 0, 0, 0, 0
         FROM sales_channel sc WHERE sc.store_id = $3 LIMIT 1
       RETURNING id`,
      [otherOrg, otherStore.rows[0]!.id, A],
    );
    const otherShipment = await owner.query<{ id: string }>(
      `INSERT INTO shipment (organization_id, store_id, order_id, warehouse_id, carrier, currency, status)
       VALUES ($1, $2, $3, $4, 'manual', 'USD', 'pending') RETURNING id`,
      [otherOrg, otherStore.rows[0]!.id, otherOrder.rows[0]!.id, EU],
    );

    const res = await as('seed-operations').post(
      `/admin/shipments/${otherShipment.rows[0]!.id}/pick`,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    // Nothing of the other organization's shipment comes back.
    expect(JSON.stringify(res.body)).not.toContain(otherStore.rows[0]!.id);
  });

  it('lists pick lists, validating the query', async () => {
    const { shipment } = await plannedShipment(US);
    const ok = await as('seed-operations').get(`/admin/stores/${A}/pick-lists?warehouse_id=${US}`);
    expect(ok.status).toBe(200);
    expect(ok.body.items.flatMap((g: { shipments: { id: string }[] }) => g.shipments)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: shipment.id })]),
    );
    expect(ok.body.page).toMatchObject({ page: 1, limit: 20 });

    const badStatus = await as('seed-operations').get(
      `/admin/stores/${A}/pick-lists?status=shipped`,
    );
    expect(badStatus.status).toBe(400);
    const badWarehouse = await as('seed-operations').get(
      `/admin/stores/${A}/pick-lists?warehouse_id=nope`,
    );
    expect(badWarehouse.status).toBe(400);
    expect((await as('seed-store-admin').get(`/admin/stores/${A}/pick-lists`)).status).toBe(403);
  });
});
