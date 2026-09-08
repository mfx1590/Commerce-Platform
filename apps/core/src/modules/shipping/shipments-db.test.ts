// Shipments and tracking on a real seeded database: planning a shipment from a placed order, buying its label,
// the events each transition writes to the outbox, duplicate webhook deliveries, delivered-before-shipped
// ordering, partial shipments moving `order.fulfillment_status`, and a cancel releasing the reservation.
//
// The shared `webhook_event` table is not in db 0.2.0 yet (window 7 files the CONTRACT CHANGE, issue #125), so
// this suite creates the proposed shape itself — the same SQL the module documents.
import { createHmac } from 'node:crypto';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import { completeCart, createPaymentSession } from '../checkout';
import { createManualCarrierProvider } from './manual-provider';
import { setInventoryPort, noopInventoryPort, type InventoryPort } from './ports';
import { resetCarrierProviders, setCarrierProvider } from './registry';
import {
  buyShipmentLabel,
  createShipment,
  getShipment,
  listOrderShipments,
  updateShipment,
} from './shipments';
import { handleEasyPostWebhook } from './tracking';
import {
  PROPOSED_WEBHOOK_EVENT_SQL,
  setWebhookEventStore,
  sqlWebhookEventStore,
} from './webhook-events';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const WH = SEED_IDS.warehouses.eu;
const SECRET = 'whsec_shipping_tests';
const actor = { id: null, type: 'staff' as const, requestId: 'req-shipping-2-3' };
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
let standardOptionId: string;
let counter = 0;

beforeAll(async () => {
  db = await createTestDatabase('core_shipments');
  await seed(db.owner, { log: () => {} });
  await db.owner.query(PROPOSED_WEBHOOK_EVENT_SQL);
  // The app role must reach the mirror table the way it will reach the real one.
  await db.owner.query(`GRANT SELECT, INSERT, UPDATE ON webhook_event TO platform_app`);
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
      ORDER BY v.sku LIMIT 4`,
    [A],
  );
  variants = vs.rows.map((row) => row.id);
  const opt = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  standardOptionId = opt.rows[0]!.id;
  setWebhookEventStore(sqlWebhookEventStore);
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

beforeEach(() => {
  const carrier = createManualCarrierProvider();
  setCarrierProvider(carrier);
});

afterEach(() => {
  resetCarrierProviders();
  setInventoryPort(noopInventoryPort);
});

/** Places a real order with `lines` line items of 2 units each and returns it with its line ids. */
async function placedOrder(lines = 1) {
  const n = counter++;
  const cart = await createCart(a, scopeA);
  for (let i = 0; i < lines; i += 1) {
    await addLineItem(a, cart.id, { variant_id: variants[i % variants.length]!, quantity: 2 });
  }
  await updateCart(a, cart.id, {
    email: `jane+${n}@example.com`,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: standardOptionId,
  });
  await createPaymentSession(a, cart.id, { provider: 'manual' });
  const placed = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `ship-2-3-${n}-${cart.id}`,
    actor: { id: null, type: 'customer', requestId: 'req-place' },
  });
  const items = await owner.query<{ id: string; quantity: number }>(
    `SELECT id, quantity FROM order_line_item WHERE order_id = $1 ORDER BY created_at, id`,
    [placed.order.id],
  );
  return { orderId: placed.order.id, lines: items.rows };
}

const eventsFor = (shipmentId: string) =>
  owner.query<{ topic: string; payload: Record<string, unknown> }>(
    `SELECT topic, payload FROM outbox WHERE aggregate_type = 'shipment' AND aggregate_id = $1
      ORDER BY occurred_at, topic`,
    [shipmentId],
  );

const fulfillmentStatus = async (orderId: string) =>
  (
    await owner.query<{ fulfillment_status: string }>(
      `SELECT fulfillment_status FROM "order" WHERE id = $1`,
      [orderId],
    )
  ).rows[0]!.fulfillment_status;

/** A signed EasyPost webhook for a tracking number at a given status. */
function webhook(trackingNumber: string, status: string, eventId: string, at: string) {
  const rawBody = JSON.stringify({
    id: eventId,
    description: 'tracker.updated',
    result: {
      tracking_code: trackingNumber,
      carrier: 'manual',
      status,
      updated_at: at,
      tracking_details: [{ object_id: `${eventId}_d`, status, datetime: at }],
    },
  });
  return {
    rawBody,
    signature: `hmac-sha256-hex=${createHmac('sha256', SECRET).update(rawBody, 'utf8').digest('hex')}`,
    secret: SECRET,
    organizationId: ORG,
    storeId: A,
    actor,
  };
}

describe('shipments', () => {
  it('plans a shipment, emits shipment.created and marks the order partially fulfilled', async () => {
    const order = await placedOrder(2);
    const shipment = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    expect(shipment).toMatchObject({
      order_id: order.orderId,
      warehouse_id: WH,
      carrier: 'manual',
      status: 'pending',
      tracking_number: null,
      label_url: null,
      cost: null,
    });
    const events = await eventsFor(shipment.id);
    expect(events.rows.map((row) => row.topic)).toEqual(['shipment.created']);
    expect(events.rows[0]!.payload).toMatchObject({
      shipment_id: shipment.id,
      order_id: order.orderId,
      warehouse_id: WH,
      destination_country: 'NL',
      currency: 'EUR',
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
    });
    // No address anywhere in the event.
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain('Keizersgracht');
    expect(await fulfillmentStatus(order.orderId)).toBe('partially_fulfilled');
  });

  it('refuses more than the order still owes, an unknown line and an unknown warehouse', async () => {
    const order = await placedOrder();
    const line = order.lines[0]!.id;
    await expect(
      createShipment(a, {
        orderId: order.orderId,
        warehouseId: WH,
        items: [{ order_line_item_id: line, quantity: 3 }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      createShipment(a, {
        orderId: order.orderId,
        warehouseId: WH,
        items: [{ order_line_item_id: SEED_IDS.warehouses.us, quantity: 1 }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      createShipment(a, {
        orderId: order.orderId,
        warehouseId: SEED_IDS.organization,
        items: [{ order_line_item_id: line, quantity: 1 }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      createShipment(a, { orderId: order.orderId, warehouseId: WH, items: [], actor }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('counts what earlier shipments already cover and fulfils the order when nothing is left', async () => {
    const order = await placedOrder();
    const line = order.lines[0]!.id;
    await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: line, quantity: 1 }],
      actor,
    });
    expect(await fulfillmentStatus(order.orderId)).toBe('partially_fulfilled');
    await expect(
      createShipment(a, {
        orderId: order.orderId,
        warehouseId: WH,
        items: [{ order_line_item_id: line, quantity: 2 }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'conflict', details: { outstanding: 1 } });
    await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: line, quantity: 1 }],
      actor,
    });
    expect(await fulfillmentStatus(order.orderId)).toBe('fulfilled');
    expect(await listOrderShipments(a, order.orderId)).toHaveLength(2);
  });

  it('buys a label once and is idempotent on a second call', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      service: 'manual_standard',
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    const labelled = await buyShipmentLabel(a, planned.id, { actor });
    expect(labelled).toMatchObject({ status: 'label_created', carrier: 'manual' });
    expect(labelled.tracking_number).toMatch(/^MAN[0-9A-F]{16}$/);
    expect(labelled.label_url).toMatch(/^https:\/\//);
    expect(labelled.cost).toEqual({ amount_minor: 590, currency: 'EUR' });
    const again = await buyShipmentLabel(a, planned.id, { actor });
    expect(again).toEqual(labelled);
    // Buying a label is not a shipment event: only shipment.created so far.
    expect((await eventsFor(planned.id)).rows.map((row) => row.topic)).toEqual([
      'shipment.created',
    ]);
  });

  it('reports a carrier failure as 502 and leaves the shipment pending', async () => {
    const broken = createManualCarrierProvider();
    broken.rates = async () => {
      throw new Error('carrier exploded');
    };
    setCarrierProvider(broken);
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await expect(buyShipmentLabel(a, planned.id, { actor })).rejects.toMatchObject({ status: 502 });
    expect((await getShipment(a, planned.id)).status).toBe('pending');
  });

  it('emits exactly one event per legal transition and refuses an illegal one', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await buyShipmentLabel(a, planned.id, { actor });
    const shipped = await updateShipment(a, planned.id, { status: 'shipped', actor });
    expect(shipped.shipped_at).not.toBeNull();
    await updateShipment(a, planned.id, { status: 'in_transit', actor });
    const delivered = await updateShipment(a, planned.id, { status: 'delivered', actor });
    expect(delivered.delivered_at).not.toBeNull();

    const events = await eventsFor(planned.id);
    expect(events.rows.map((row) => row.topic)).toEqual([
      'shipment.created',
      'shipment.shipped',
      'shipment.delivered',
    ]);
    expect(events.rows[1]!.payload).toMatchObject({
      shipment_id: planned.id,
      order_id: order.orderId,
      carrier: 'manual',
      cost_minor: 590,
      currency: 'EUR',
    });

    await expect(
      updateShipment(a, planned.id, { status: 'in_transit', actor }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(updateShipment(a, planned.id, { status: 'shipped', actor })).rejects.toMatchObject(
      {
        code: 'conflict',
      },
    );
  });

  it('emits shipment.shipped before delivered even when the carrier skips the scans', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await buyShipmentLabel(a, planned.id, { actor });
    await updateShipment(a, planned.id, { status: 'delivered', actor });
    const events = await eventsFor(planned.id);
    expect(events.rows.map((row) => row.topic)).toEqual([
      'shipment.created',
      'shipment.delivered',
      'shipment.shipped',
    ]);
    const row = await getShipment(a, planned.id);
    expect(row.shipped_at).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
  });

  it('releases the reservation when a planned shipment is cancelled', async () => {
    const released = vi.fn();
    const port: InventoryPort = {
      consumeReservations: async () => {},
      releaseReservations: async (input) => released(input.shipmentId, input.items),
    };
    setInventoryPort(port);
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await updateShipment(a, planned.id, { status: 'cancelled', actor });
    expect(released).toHaveBeenCalledWith(planned.id, [
      { orderLineItemId: order.lines[0]!.id, quantity: 2 },
    ]);
    // A cancelled shipment no longer covers the line: the order is unfulfilled again.
    expect(await fulfillmentStatus(order.orderId)).toBe('unfulfilled');
  });

  it('consumes the reservation through the inventory port when a shipment is planned', async () => {
    const consumed = vi.fn();
    setInventoryPort({
      consumeReservations: async (input) => consumed(input.orderId, input.warehouseId, input.items),
      releaseReservations: async () => {},
    });
    const order = await placedOrder();
    await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    expect(consumed).toHaveBeenCalledWith(order.orderId, WH, [
      { orderLineItemId: order.lines[0]!.id, quantity: 2 },
    ]);
  });
});

describe('tracking webhooks', () => {
  async function shippedShipment() {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    const labelled = await buyShipmentLabel(a, planned.id, { actor });
    return { orderId: order.orderId, shipmentId: planned.id, tracking: labelled.tracking_number! };
  }

  it('applies a scan, and a duplicate delivery changes nothing', async () => {
    const { shipmentId, tracking } = await shippedShipment();
    const request = webhook(
      tracking,
      'in_transit',
      `evt_dup_${shipmentId}`,
      '2026-09-08T10:00:00Z',
    );
    const first = await handleEasyPostWebhook(a, request);
    expect(first).toMatchObject({ outcome: 'applied', shipmentId, status: 'in_transit' });

    const second = await handleEasyPostWebhook(a, request);
    expect(second.outcome).toBe('duplicate');
    // The transition emitted shipment.shipped once (in_transit passes through shipped), never twice.
    const events = await eventsFor(shipmentId);
    expect(events.rows.filter((row) => row.topic === 'shipment.shipped')).toHaveLength(1);
  });

  it('handles delivered before shipped: the late scan does not move the shipment back', async () => {
    const { shipmentId, tracking } = await shippedShipment();
    const delivered = await handleEasyPostWebhook(
      a,
      webhook(tracking, 'delivered', `evt_del_${shipmentId}`, '2026-09-09T11:00:00Z'),
    );
    expect(delivered).toMatchObject({ outcome: 'applied', status: 'delivered' });

    const late = await handleEasyPostWebhook(
      a,
      webhook(tracking, 'in_transit', `evt_late_${shipmentId}`, '2026-09-08T10:00:00Z'),
    );
    expect(late).toMatchObject({ outcome: 'ignored', status: 'delivered' });

    const events = await eventsFor(shipmentId);
    expect(events.rows.map((row) => row.topic).sort()).toEqual([
      'shipment.created',
      'shipment.delivered',
      'shipment.shipped',
    ]);
    const row = await getShipment(a, shipmentId);
    expect(row.status).toBe('delivered');
    // The carrier's own clock, not ours.
    expect(row.delivered_at).toContain('2026-09-09');
  });

  it('rejects a bad signature and a body that is not a tracker update', async () => {
    const { tracking } = await shippedShipment();
    const request = webhook(tracking, 'in_transit', 'evt_badsig', '2026-09-08T10:00:00Z');
    await expect(
      handleEasyPostWebhook(a, { ...request, signature: 'hmac-sha256-hex=deadbeef' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(handleEasyPostWebhook(a, { ...request, signature: null })).rejects.toMatchObject({
      code: 'unauthorized',
    });

    const notJson = { ...request, rawBody: 'not json' };
    await expect(
      handleEasyPostWebhook(a, {
        ...notJson,
        signature: `hmac-sha256-hex=${createHmac('sha256', SECRET).update('not json', 'utf8').digest('hex')}`,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('records but ignores a scan for a tracking number we do not know', async () => {
    const result = await handleEasyPostWebhook(
      a,
      webhook('MANUNKNOWN', 'delivered', 'evt_unknown_1', '2026-09-09T11:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'ignored', shipmentId: null });
    const row = await owner.query<{ status: string }>(
      `SELECT status FROM webhook_event WHERE provider = 'easypost' AND external_id = 'evt_unknown_1'`,
    );
    expect(row.rows[0]!.status).toBe('ignored');
  });

  it('ignores a carrier status that maps to nothing actionable', async () => {
    const { shipmentId, tracking } = await shippedShipment();
    const result = await handleEasyPostWebhook(
      a,
      webhook(tracking, 'pre_transit', `evt_pre_${shipmentId}`, '2026-09-08T08:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'ignored', status: 'label_created' });
  });

  it('stores the carrier timestamp separately from ours', async () => {
    const { shipmentId, tracking } = await shippedShipment();
    await handleEasyPostWebhook(
      a,
      webhook(tracking, 'in_transit', `evt_ts_${shipmentId}`, '2026-09-08T10:00:00Z'),
    );
    const row = await owner.query<{ occurred_at: Date; received_at: Date; status: string }>(
      `SELECT occurred_at, received_at, status FROM webhook_event WHERE external_id = $1`,
      [`evt_ts_${shipmentId}`],
    );
    expect(row.rows[0]!.status).toBe('processed');
    expect(row.rows[0]!.occurred_at.toISOString()).toBe('2026-09-08T10:00:00.000Z');
    expect(row.rows[0]!.received_at.getTime()).toBeGreaterThan(row.rows[0]!.occurred_at.getTime());
  });
});
