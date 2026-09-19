// Fulfilment on a real seeded database: routing a placed order to the right warehouse (and the store override),
// the provider receiving it, cancel before pick releasing the reservation through the real inventory module,
// cancel after pick refused, a failed push compensated, and a provider's `shipped` moving the shipment.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import { completeCart, createPaymentSession } from '../checkout';
import { confirmOrder } from '../orders';
import {
  coreInventoryPort,
  getShipment,
  readShipmentMetadata,
  setInventoryPort,
} from '../shipping';
import { createMemoryFulfillmentProvider, type MemoryFulfillmentProvider } from './memory-provider';
import { resetFulfillmentProviders, setFulfillmentProvider } from './registry';
import { applyFulfillmentUpdate, cancelFulfillment, requestFulfillment } from './service';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const C = SEED_IDS.stores.brandC;
const actor = { id: null, type: 'staff' as const, requestId: 'req-fulfilment-2-4' };

let db: TestDatabase;
let owner: ReturnType<typeof createOrganizationClient>;
let provider: MemoryFulfillmentProvider;
let counter = 0;

interface StoreFixture {
  client: ReturnType<typeof createTenantClient>;
  scope: { organizationId: string; storeId: string; salesChannelId: string | null };
  variant: string;
  optionId: string;
  address: Record<string, string>;
  currency: string;
}
const stores: Record<string, StoreFixture> = {};

async function fixture(storeId: string, address: Record<string, string>, currency: string) {
  const client = createTenantClient(db.app, { organizationId: ORG, storeIds: [storeId] });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [storeId],
  );
  const variant = await owner.query<{ id: string }>(
    `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
      JOIN price pr ON pr.variant_id = v.id AND pr.currency = $2 AND pr.min_quantity = 1
      WHERE v.store_id = $1
        AND coalesce((SELECT sum(il.available) FROM inventory_level il WHERE il.variant_id = v.id), 0) >= 20
      ORDER BY v.sku LIMIT 1`,
    [storeId, currency],
  );
  const option = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [storeId],
  );
  return {
    client,
    scope: { organizationId: ORG, storeId, salesChannelId: channel.rows[0]!.id },
    variant: variant.rows[0]!.id,
    optionId: option.rows[0]!.id,
    address,
    currency,
  };
}

beforeAll(async () => {
  db = await createTestDatabase('core_fulfilment');
  await seed(db.owner, { log: () => {} });
  // #225's DDL, exactly as filed; migration 0160 replaces this once it lands (the #187/0140 pattern).
  await db.owner.query(
    readFileSync(join(__dirname, 'proposed', '0160_shipment_pick_pack.sql'), 'utf8'),
  );
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  stores.a = await fixture(
    A,
    {
      first_name: 'Jane',
      last_name: 'Doe',
      line1: 'Unter den Linden 1',
      city: 'Berlin',
      postal_code: '10117',
      country: 'DE',
    },
    'EUR',
  );
  stores.c = await fixture(
    C,
    {
      first_name: 'John',
      last_name: 'Roe',
      line1: '1 Main St',
      city: 'Austin',
      region: 'TX',
      postal_code: '73301',
      country: 'US',
    },
    'USD',
  );
}, 180_000);

afterAll(async () => {
  resetFulfillmentProviders();
  await db?.drop();
});

beforeEach(async () => {
  resetFulfillmentProviders();
  provider = createMemoryFulfillmentProvider();
  setFulfillmentProvider(provider);
  await owner.query(`UPDATE store SET settings = settings - 'fulfillment' WHERE id = ANY($1)`, [
    [A, C],
  ]);
});

/** A confirmed order of 2 units in the given store. */
async function placedOrder(store: StoreFixture) {
  const n = counter++;
  const cart = await createCart(store.client, store.scope, { currency: store.currency });
  await updateCart(store.client, cart.id, { country: store.address.country! });
  await addLineItem(store.client, cart.id, { variant_id: store.variant, quantity: 2 });
  await updateCart(store.client, cart.id, {
    email: `buyer+${n}@example.com`,
    shipping_address: store.address,
    billing_address: store.address,
    shipping_option_id: store.optionId,
  });
  await createPaymentSession(store.client, cart.id, { provider: 'manual' });
  const placed = await completeCart(store.client, {
    cartId: cart.id,
    idempotencyKey: `ful-2-4-${n}-${cart.id}`,
    actor: { id: null, type: 'customer', requestId: 'req-place' },
  });
  await confirmOrder(store.client, placed.order.id, actor);
  return placed.order.id;
}

const onHand = async (variant: string, warehouse: string) =>
  (
    await owner.query<{ on_hand: number }>(
      `SELECT on_hand FROM inventory_level WHERE variant_id = $1 AND warehouse_id = $2`,
      [variant, warehouse],
    )
  ).rows[0]?.on_hand ?? null;

describe('fulfilment routing', () => {
  it('routes an EU order to wh-eu and hands it to the provider', async () => {
    const orderId = await placedOrder(stores.a!);
    const result = await requestFulfillment(stores.a!.client, { orderId, actor });
    expect(result.routing).toMatchObject({
      rule: 'same_region',
      warehouse: { code: 'wh-eu', id: SEED_IDS.warehouses.eu },
    });
    expect(result.shipment.warehouse_id).toBe(SEED_IDS.warehouses.eu);
    expect(provider.requests()).toEqual([
      expect.objectContaining({
        reference: result.shipment.id,
        orderId,
        warehouseCode: 'wh-eu',
        lines: [expect.objectContaining({ quantity: 2 })],
      }),
    ]);
    expect(
      await readShipmentMetadata(stores.a!.client, result.shipment.id, 'fulfillment'),
    ).toMatchObject({ provider: 'memory', external_id: result.externalId, state: 'accepted' });
  });

  it('routes a US order to wh-us', async () => {
    const orderId = await placedOrder(stores.c!);
    const result = await requestFulfillment(stores.c!.client, { orderId, actor });
    expect(result.routing).toMatchObject({ rule: 'same_country', warehouse: { code: 'wh-us' } });
    expect(result.shipment.warehouse_id).toBe(SEED_IDS.warehouses.us);
  });

  it('honours a per-store override', async () => {
    await owner.query(
      `UPDATE store SET settings = jsonb_set(settings, '{fulfillment}', $2::jsonb, true) WHERE id = $1`,
      [A, JSON.stringify({ routing: { countries: { DE: 'wh-us' } } })],
    );
    const orderId = await placedOrder(stores.a!);
    const result = await requestFulfillment(stores.a!.client, { orderId, actor });
    expect(result.routing).toMatchObject({ rule: 'store_country', warehouse: { code: 'wh-us' } });
  });

  it('refuses a second fulfilment when the order owes nothing more', async () => {
    const orderId = await placedOrder(stores.a!);
    await requestFulfillment(stores.a!.client, { orderId, actor });
    await expect(requestFulfillment(stores.a!.client, { orderId, actor })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});

describe('fulfilment cancel and updates', () => {
  it('cancel before pick releases the reservation through the inventory module', async () => {
    const store = stores.a!;
    const orderId = await placedOrder(store);
    const before = await onHand(store.variant, SEED_IDS.warehouses.eu);
    const { shipment } = await requestFulfillment(store.client, { orderId, actor });
    expect(await onHand(store.variant, SEED_IDS.warehouses.eu)).toBe(before! - 2);

    const cancelled = await cancelFulfillment(store.client, shipment.id, actor);
    expect(cancelled.status).toBe('cancelled');
    expect(await onHand(store.variant, SEED_IDS.warehouses.eu)).toBe(before);
    const released = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movement
        WHERE reference_type = 'shipment_release' AND reference_id = $1`,
      [shipment.id],
    );
    expect(Number(released.rows[0]!.n)).toBeGreaterThan(0);
    expect(await readShipmentMetadata(store.client, shipment.id, 'fulfillment')).toMatchObject({
      state: 'cancelled',
    });
    // The order owes the goods again.
    await expect(requestFulfillment(store.client, { orderId, actor })).resolves.toBeTruthy();
  });

  it('refuses to cancel once picking has started and changes nothing', async () => {
    const store = stores.a!;
    const orderId = await placedOrder(store);
    const { shipment, externalId } = await requestFulfillment(store.client, { orderId, actor });
    const before = await onHand(store.variant, SEED_IDS.warehouses.eu);
    provider.advance(externalId, 'picking');
    await expect(cancelFulfillment(store.client, shipment.id, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'already picking' },
    });
    expect((await getShipment(store.client, shipment.id)).status).toBe('pending');
    expect(await onHand(store.variant, SEED_IDS.warehouses.eu)).toBe(before);
  });

  it('compensates a failed push: the shipment is cancelled and its stock released', async () => {
    const store = stores.a!;
    const orderId = await placedOrder(store);
    const before = await onHand(store.variant, SEED_IDS.warehouses.eu);
    provider.failNextPush('warehouse offline');
    await expect(requestFulfillment(store.client, { orderId, actor })).rejects.toMatchObject({
      status: 502,
    });
    expect(await onHand(store.variant, SEED_IDS.warehouses.eu)).toBe(before);
    const shipments = await owner.query<{ status: string }>(
      `SELECT status FROM shipment WHERE order_id = $1`,
      [orderId],
    );
    expect(shipments.rows.map((row) => row.status)).toEqual(['cancelled']);
  });

  it("applies the provider's states in order: picking, packed, then shipped with tracking", async () => {
    const store = stores.a!;
    const orderId = await placedOrder(store);
    const { shipment, externalId } = await requestFulfillment(store.client, { orderId, actor });

    const picking = provider.advance(externalId, 'picking');
    const started = await applyFulfillmentUpdate(store.client, picking, actor);
    // Since #225 the pick/pack lifecycle IS the shipment status, so this moves the row.
    expect(started.applied).toBe(true);
    expect(started.shipment).toMatchObject({ status: 'picking' });
    expect((await getShipment(store.client, shipment.id)).status).toBe('picking');

    const packed = await applyFulfillmentUpdate(
      store.client,
      provider.advance(externalId, 'packed'),
      actor,
    );
    expect(packed.shipment).toMatchObject({ status: 'packed' });
    const shipped = provider.advance(externalId, 'shipped', { trackingNumber: 'TRK-2-4' });
    const applied = await applyFulfillmentUpdate(store.client, shipped, actor);
    expect(applied.shipment).toMatchObject({ status: 'shipped', tracking_number: 'TRK-2-4' });
    // The same update again changes nothing.
    expect(await applyFulfillmentUpdate(store.client, shipped, actor)).toEqual({
      applied: false,
      shipment: null,
    });
    const order = await owner.query<{ fulfillment_status: string }>(
      `SELECT fulfillment_status FROM "order" WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]!.fulfillment_status).toBe('fulfilled');
  });

  it('records a divergence when the provider cancels but the shipment cannot', async () => {
    const store = stores.a!;
    const orderId = await placedOrder(store);
    const { shipment, externalId } = await requestFulfillment(store.client, { orderId, actor });
    // The parcel has left: cancelling the shipment is no longer legal, but the provider still accepts a cancel
    // (it thinks the job is fresh). The divergence must be written down, not swallowed.
    provider.advance(externalId, 'picking');
    provider.advance(externalId, 'packed');
    provider.advance(externalId, 'shipped', { trackingNumber: 'TRK-DIVERGE' });
    await applyFulfillmentUpdate(store.client, await provider.status(externalId), actor);
    expect((await getShipment(store.client, shipment.id)).status).toBe('shipped');

    // A provider that agrees to cancel an already-shipped job — exactly the state that must not be lost.
    provider.cancel = async () => ({ cancelled: true });
    await expect(cancelFulfillment(store.client, shipment.id, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { shipment_id: shipment.id, provider: 'memory' },
    });
    expect(await readShipmentMetadata(store.client, shipment.id, 'fulfillment')).toMatchObject({
      state: 'cancelled',
      needs_reconciliation: true,
      reconcile_reason: 'provider cancelled the fulfilment; the shipment could not be cancelled',
    });
    // Our row is untouched: the parcel really is on its way.
    expect((await getShipment(store.client, shipment.id)).status).toBe('shipped');
  });

  it('leaves the reference where it was when the move fails, so the retry still works', async () => {
    const store = stores.a!;
    const orderId = await placedOrder(store);
    const { shipment, externalId } = await requestFulfillment(store.client, { orderId, actor });
    const cancelled = { ...(await provider.status(externalId)), state: 'cancelled' as const };

    // Releasing stock fails for a reason that is not a conflict: the whole update must fail, and the
    // reference must NOT record `cancelled`, or the provider's retry would find nothing to do.
    setInventoryPort({
      consumeReservations: async () => {},
      releaseReservations: async () => {
        throw new Error('inventory unavailable');
      },
    });
    await expect(applyFulfillmentUpdate(store.client, cancelled, actor)).rejects.toThrow(
      'inventory unavailable',
    );
    expect(await readShipmentMetadata(store.client, shipment.id, 'fulfillment')).toMatchObject({
      state: 'accepted',
    });
    expect((await getShipment(store.client, shipment.id)).status).toBe('pending');

    // With inventory back, the same update lands.
    setInventoryPort(coreInventoryPort);
    const retried = await applyFulfillmentUpdate(store.client, cancelled, actor);
    expect(retried.shipment).toMatchObject({ status: 'cancelled' });
    expect(await readShipmentMetadata(store.client, shipment.id, 'fulfillment')).toMatchObject({
      state: 'cancelled',
    });
  });

  it('rejects an update whose external id does not match the shipment', async () => {
    const store = stores.a!;
    const orderId = await placedOrder(store);
    const { shipment, externalId } = await requestFulfillment(store.client, { orderId, actor });
    const update = { ...(await provider.status(externalId)), externalId: 'ful_someone_else' };
    await expect(applyFulfillmentUpdate(store.client, update, actor)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect((await getShipment(store.client, shipment.id)).status).toBe('pending');
  });
});
