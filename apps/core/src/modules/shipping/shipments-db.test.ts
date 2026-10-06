// Shipments and tracking on a real seeded database: planning a shipment from a placed order, buying its label,
// the events each transition writes to the outbox, duplicate webhook deliveries, delivered-before-shipped
// ordering, partial shipments moving `order.fulfillment_status`, and a cancel releasing the reservation.
//
// The shared `webhook_event` table (#187) comes from migration 0140 in @platform/db.
// The router tests run the real core middleware with dev tokens.
import { createHash, createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../http';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import { addLineItem, createCart, updateCart } from '../cart';
import { confirmOrder, projectOrder, type ProjectedEvent } from '../orders';
import { completeCart, createPaymentSession } from '../checkout';
import { createTestCarrierProvider } from './manual-provider';
import { coreInventoryPort, setInventoryPort, type InventoryPort } from './ports';
import { resetCarrierProviders, setCarrierProvider } from './registry';
import {
  buyShipmentLabel,
  createShipment,
  getShipment,
  listOrderShipments,
  readShipmentMetadata,
  updateShipment,
} from './shipments';
import { shippingAdminRouter, shippingWebhookRouter } from './http';
import { handleEasyPostWebhook } from './tracking';
import { payloadHashOf } from './webhook-events';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const WH = SEED_IDS.warehouses.eu;
const SECRET = 'whsec_shipping_tests';
/** The name brand A's `settings.shipping.provider` points at; the test double registers under it. */
const TEST_CARRIER = 'test-carrier';
/**
 * The carrier the double's labels name. It keeps the manual pricing table, so the label's carrier — the brand
 * that moves the parcel, what lands in `shipment.carrier` and in the event — stays `manual` while the provider
 * doing the buying is `test-carrier`. The two are different things and this suite asserts both.
 */
const LABEL_CARRIER = 'manual';
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
  // The router resolves stores and scopes through the app pool, like the running server.
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
  const opt = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  standardOptionId = opt.rows[0]!.id;
  // Brand A's carrier is the deterministic test double, which CAN buy labels. The built-in `manual` carrier
  // cannot (Admin API 0.4.9 answers 422 `provider_unsupported` for it), so a store left on the default would
  // never get past the capability check — `refuses a label for the manual carrier` relies on exactly that.
  await owner.query(
    `UPDATE store SET settings = coalesce(settings, '{}'::jsonb)
       || jsonb_build_object('shipping',
            coalesce(settings -> 'shipping', '{}'::jsonb) || jsonb_build_object('provider', $2::text))
      WHERE id = $1`,
    [A, TEST_CARRIER],
  );
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

beforeEach(() => {
  const carrier = createTestCarrierProvider();
  setCarrierProvider(carrier);
});

afterEach(() => {
  resetCarrierProviders();
  setInventoryPort(coreInventoryPort);
});

/**
 * Places a real order with `lines` line items of 2 units each and confirms it, because the orders module
 * (core 2.3) only allows `confirmed → processing`: a shipment on an unconfirmed order is legal but leaves the
 * status alone. `confirm: false` exercises exactly that.
 */
async function placedOrder(lines = 1, confirm = true) {
  const n = counter++;
  const cart = await createCart(a, scopeA);
  for (let i = 0; i < lines; i += 1) {
    // Rotate through the variants: shipments consume real stock, so one variant would run dry.
    await addLineItem(a, cart.id, {
      variant_id: variants[(n + i) % variants.length]!,
      quantity: 2,
    });
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
  if (confirm) await confirmOrder(a, placed.order.id, actor);
  const items = await owner.query<{ id: string; quantity: number }>(
    `SELECT id, quantity FROM order_line_item WHERE order_id = $1 ORDER BY created_at, id`,
    [placed.order.id],
  );
  return { orderId: placed.order.id, lines: items.rows };
}

// Ordered by `seq`, the outbox's identity column: the order the rows were written. occurred_at is a wall-clock
// value per event and two events from one transition can tie or straddle a millisecond (#255).
const eventsFor = (shipmentId: string) =>
  owner.query<{ topic: string; payload: Record<string, unknown> }>(
    `SELECT topic, payload FROM outbox WHERE aggregate_type = 'shipment' AND aggregate_id = $1
      ORDER BY seq`,
    [shipmentId],
  );

/**
 * Moves a planned shipment to `packed`, the only state `buyShipmentLabel` accepts (Admin API 0.4.9). The
 * warehouse reaches it through the fulfillment module's `pickShipment` / `packShipment`; this file is shipping's
 * own suite, so it writes the status through the same state machine directly.
 */
const pack = async (shipmentId: string) =>
  updateShipment(a, shipmentId, { status: 'packed', actor });

/**
 * The order's **fulfilment** state, which is the part shipping reports and owns (`markShipmentCreatedInTx`,
 * `markShippedInTx`, `markDeliveredInTx` write it). `order.status` is the orders module's own lifecycle and
 * changes with #350 — confirmed on authorisation, `processing` once a shipment leaves `pending` — so a test in
 * this suite that asserted it would be red on one side of that change or the other. Read this instead (#366).
 */
const orderFulfillment = async (orderId: string) =>
  (
    await owner.query<{ fulfillment_status: string }>(
      `SELECT fulfillment_status FROM "order" WHERE id = $1`,
      [orderId],
    )
  ).rows[0]!.fulfillment_status;

const orderState = async (orderId: string) =>
  (
    await owner.query<{ status: string; fulfillment_status: string }>(
      `SELECT status, fulfillment_status FROM "order" WHERE id = $1`,
      [orderId],
    )
  ).rows[0]!;

/** A signed EasyPost webhook for a tracking number at a given status. */
function webhook(trackingNumber: string, status: string, eventId: string, at: string) {
  const rawBody = JSON.stringify({
    id: eventId,
    description: 'tracker.updated',
    result: {
      id: `trk_${eventId}`,
      tracking_code: trackingNumber,
      carrier: 'manual',
      status,
      updated_at: at,
      signed_by: 'Jane Doe',
      destination: { street1: 'Keizersgracht 1', city: 'Amsterdam', zip: '1015 CJ', country: 'NL' },
      tracking_details: [
        {
          object_id: `${eventId}_d`,
          status,
          datetime: at,
          tracking_location: { city: 'Amsterdam', state: null, country: 'NL' },
        },
      ],
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
  it('plans a shipment, emits shipment.created and fulfils nothing yet', async () => {
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
    // Planning is not fulfilment — nothing has left the warehouse. Asserted on what this module owns: the
    // order's fulfilment state, and the shipment itself sitting there planned. Whether the ORDER is `confirmed`,
    // `processing` or still `pending` at this point is the orders module's lifecycle and moves with #350, so it
    // is deliberately not asserted here (#366).
    expect(await orderFulfillment(order.orderId)).toBe('unfulfilled');
    expect(await listOrderShipments(a, order.orderId)).toMatchObject([
      { id: shipment.id, status: 'pending', shipped_at: null, delivered_at: null },
    ]);
  });

  it('still plans a shipment for an order nobody confirmed', async () => {
    const order = await placedOrder(1, false);
    const shipment = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    // The point of the test: planning does not depend on the order's status, and a refusal from the orders
    // module's state machine is reported, not thrown (the call runs inside a SAVEPOINT). So the shipment exists
    // and nothing is fulfilled — while the order's own status is left to the orders module, whose lifecycle
    // #350 changes (an order may already be `confirmed` here once authorisation confirms it).
    expect(shipment.status).toBe('pending');
    expect(await listOrderShipments(a, order.orderId)).toMatchObject([
      { id: shipment.id, status: 'pending' },
    ]);
    expect(await orderFulfillment(order.orderId)).toBe('unfulfilled');
  });

  it('moves the order to processing when a shipment leaves pending, and a cancel does not', async () => {
    // #366 part 2, on top of #350: planning alone is not work starting — the order only moves once someone
    // picks (or packs, labels, or despatches straight away). The call is on shipping's own transaction.
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    const afterPlanning = await orderState(order.orderId);
    expect(afterPlanning.fulfillment_status).toBe('unfulfilled');
    expect(afterPlanning.status).not.toBe('processing');

    await updateShipment(a, planned.id, { status: 'picking', actor });
    expect(await orderState(order.orderId)).toEqual({
      status: 'processing',
      fulfillment_status: 'unfulfilled',
    });

    // Every later move is a no-op on the order's status: only the FIRST leaving of `pending` starts it, and
    // the orders module is idempotent on the target state anyway.
    await updateShipment(a, planned.id, { status: 'packed', actor });
    expect((await orderState(order.orderId)).status).toBe('processing');

    // A second shipment on the same order that is cancelled while still planned must not claim work started.
    const other = await placedOrder();
    const doomed = await createShipment(a, {
      orderId: other.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: other.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await updateShipment(a, doomed.id, { status: 'cancelled', actor });
    expect((await orderState(other.orderId)).status).not.toBe('processing');
  });

  it('starts the order even when the shipment goes straight from pending to shipped', async () => {
    // The same guarantee as `shipment.shipped` before `shipment.delivered`: a skipped step is filled in, so an
    // order never reaches its fulfilment without having passed through `processing`.
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await updateShipment(a, planned.id, { status: 'shipped', actor });
    expect(await orderState(order.orderId)).toEqual({
      status: 'processing',
      fulfillment_status: 'fulfilled',
    });
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

  it('counts what earlier shipments already cover, and each despatch moves the order', async () => {
    const order = await placedOrder();
    const line = order.lines[0]!.id;
    const first = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: line, quantity: 1 }],
      actor,
    });
    await expect(
      createShipment(a, {
        orderId: order.orderId,
        warehouseId: WH,
        items: [{ order_line_item_id: line, quantity: 2 }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'conflict', details: { outstanding: 1 } });
    const second = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: line, quantity: 1 }],
      actor,
    });
    expect(await listOrderShipments(a, order.orderId)).toHaveLength(2);

    // Half the line leaves: partially fulfilled. Then the rest: fulfilled, and delivery completes the order.
    await updateShipment(a, first.id, { status: 'shipped', actor });
    expect((await orderState(order.orderId)).fulfillment_status).toBe('partially_fulfilled');
    await updateShipment(a, second.id, { status: 'shipped', actor });
    expect((await orderState(order.orderId)).fulfillment_status).toBe('fulfilled');

    await updateShipment(a, first.id, { status: 'delivered', actor });
    await updateShipment(a, second.id, { status: 'delivered', actor });
    expect((await orderState(order.orderId)).status).toBe('completed');
  });

  it('buys a label for a packed shipment, emits shipment.label_created, and 409s on a second call', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      service: 'manual_standard',
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await pack(planned.id);
    const labelled = await buyShipmentLabel(a, planned.id, { actor });
    expect(labelled).toMatchObject({ status: 'label_created', carrier: LABEL_CARRIER });
    expect(labelled.tracking_number).toMatch(/^MAN[0-9A-F]{16}$/);
    expect(labelled.label_url).toMatch(/^https:\/\//);
    expect(labelled.tracking_url).toMatch(/^https:\/\//);
    expect(labelled.cost).toEqual({ amount_minor: 590, currency: 'EUR' });

    // The label and its announcement commit together: the event is on the outbox, with the ids, the carrier
    // and the label URL — and nothing that could identify the customer (events 0.3.1).
    const events = await eventsFor(planned.id);
    expect(events.rows.map((row) => row.topic)).toEqual([
      'shipment.created',
      'shipment.label_created',
    ]);
    expect(events.rows[1]!.payload).toEqual({
      shipment_id: planned.id,
      order_id: order.orderId,
      store_id: A,
      carrier: LABEL_CARRIER,
      tracking_number: labelled.tracking_number,
      label_url: labelled.label_url,
      created_at: expect.any(String),
    });

    // A shipment that already holds a label is `label_created`, not `packed`: the second call is a 409 and no
    // second parcel is bought. The contract has no "returned unchanged" answer for this operation.
    await expect(buyShipmentLabel(a, planned.id, { actor })).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { shipment_id: planned.id, status: 'label_created' },
    });
    expect((await eventsFor(planned.id)).rows).toHaveLength(2);
  });

  it('refuses a label for the manual carrier with 422 provider_unsupported', async () => {
    // The store's own setting decides, not the registry: `manual` is "no carrier integration", so an operator
    // attaches tracking with updateShipment instead. Permanent — the client must not retry.
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await pack(planned.id);
    await owner.query(
      `UPDATE store SET settings = jsonb_set(settings, ARRAY['shipping', 'provider'], '"manual"'::jsonb, true)
        WHERE id = $1`,
      [A],
    );
    try {
      await expect(buyShipmentLabel(a, planned.id, { actor })).rejects.toMatchObject({
        code: 'provider_unsupported',
        status: 422,
        details: { provider: 'manual' },
      });
    } finally {
      await owner.query(
        `UPDATE store SET settings = jsonb_set(settings, ARRAY['shipping', 'provider'], $2::jsonb, true)
          WHERE id = $1`,
        [A, JSON.stringify(TEST_CARRIER)],
      );
    }
    // Nothing moved and nothing was announced.
    expect((await getShipment(a, planned.id)).status).toBe('packed');
    expect((await eventsFor(planned.id)).rows.map((row) => row.topic)).toEqual([
      'shipment.created',
    ]);
  });

  it('refuses a label on a shipment that is not packed yet', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await expect(buyShipmentLabel(a, planned.id, { actor })).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { shipment_id: planned.id, status: 'pending' },
    });
    await updateShipment(a, planned.id, { status: 'picking', actor });
    await expect(buyShipmentLabel(a, planned.id, { actor })).rejects.toMatchObject({
      code: 'conflict',
      details: { status: 'picking' },
    });
  });

  it('voids a label it could not record, and leaves the shipment where it found it', async () => {
    // The shipment is cancelled WHILE the carrier is buying: step 3 must refuse, and the bought label — real
    // money — goes back to the carrier instead of being orphaned.
    const carrier = createTestCarrierProvider();
    const voided: string[] = [];
    const realBuy = carrier.buyLabel.bind(carrier);
    const realVoid = carrier.voidLabel.bind(carrier);
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await pack(planned.id);
    carrier.buyLabel = async (request) => {
      const label = await realBuy(request);
      await updateShipment(a, planned.id, { status: 'cancelled', actor });
      return label;
    };
    carrier.voidLabel = async (request) => {
      voided.push(request.providerShipmentId);
      return realVoid(request);
    };
    setCarrierProvider(carrier);

    await expect(buyShipmentLabel(a, planned.id, { actor })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(voided).toHaveLength(1);
    const row = await getShipment(a, planned.id);
    expect(row.status).toBe('cancelled');
    expect(row.label_url).toBeNull();
  });

  it('reports a carrier failure as 502 and leaves the shipment packed', async () => {
    const broken = createTestCarrierProvider();
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
    await pack(planned.id);
    // A carrier outage is NOT 422: 422 says the carrier can never do this, while this call can be retried.
    await expect(buyShipmentLabel(a, planned.id, { actor })).rejects.toMatchObject({
      status: 502,
      code: 'internal',
    });
    expect((await getShipment(a, planned.id)).status).toBe('packed');
  });

  it('voids the label when a shipment holding one is cancelled', async () => {
    const carrier = createTestCarrierProvider();
    const voided: string[] = [];
    const realVoid = carrier.voidLabel.bind(carrier);
    carrier.voidLabel = async (request) => {
      voided.push(request.providerShipmentId);
      return realVoid(request);
    };
    setCarrierProvider(carrier);

    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await pack(planned.id);
    const labelled = await buyShipmentLabel(a, planned.id, { actor });
    expect(labelled.status).toBe('label_created');

    const cancelled = await updateShipment(a, planned.id, { status: 'cancelled', actor });
    expect(cancelled.status).toBe('cancelled');
    expect(voided).toHaveLength(1);
  });

  it('refuses the cancel when the void fails, and records the divergence', async () => {
    const carrier = createTestCarrierProvider();
    carrier.voidLabel = async () => {
      throw new Error('carrier refused');
    };
    setCarrierProvider(carrier);

    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await pack(planned.id);
    await buyShipmentLabel(a, planned.id, { actor });

    await expect(
      updateShipment(a, planned.id, { status: 'cancelled', actor }),
    ).rejects.toMatchObject({ code: 'conflict', details: { shipment_id: planned.id } });

    // The shipment still matches reality: the carrier holds a live label.
    expect((await getShipment(a, planned.id)).status).toBe('label_created');
    const ref = await readShipmentMetadata(a, planned.id, 'carrier_label');
    expect(ref).toMatchObject({ needs_reconciliation: true });
    // A plain Error from a provider is not trusted verbatim; the recorded reason says what happened.
    expect(String(ref!.reconcile_reason)).toContain('provider failure voiding the label');
  });

  it('emits exactly one event per legal transition and refuses an illegal one', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await pack(planned.id);
    await buyShipmentLabel(a, planned.id, { actor });
    const shipped = await updateShipment(a, planned.id, { status: 'shipped', actor });
    expect(shipped.shipped_at).not.toBeNull();
    await updateShipment(a, planned.id, { status: 'in_transit', actor });
    const delivered = await updateShipment(a, planned.id, { status: 'delivered', actor });
    expect(delivered.delivered_at).not.toBeNull();

    const events = await eventsFor(planned.id);
    expect(events.rows.map((row) => row.topic)).toEqual([
      'shipment.created',
      'shipment.label_created',
      'shipment.shipped',
      'shipment.delivered',
    ]);
    expect(events.rows[2]!.payload).toMatchObject({
      shipment_id: planned.id,
      order_id: order.orderId,
      carrier: LABEL_CARRIER,
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
    await pack(planned.id);
    await buyShipmentLabel(a, planned.id, { actor });
    await updateShipment(a, planned.id, { status: 'delivered', actor });
    // Both events are written in one transaction, shipped first: `seq` (the outbox identity) is the write order.
    // occurred_at can tie or differ by a millisecond between the two, so it must not decide the order (#255).
    const events = await eventsFor(planned.id);
    expect(events.rows.map((row) => row.topic)).toEqual([
      'shipment.created',
      'shipment.label_created',
      'shipment.shipped',
      'shipment.delivered',
    ]);
    const row = await getShipment(a, planned.id);
    expect(row.shipped_at).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
    // The order hears both facts even though the carrier reported only one.
    expect(await orderState(order.orderId)).toEqual({
      status: 'completed',
      fulfillment_status: 'fulfilled',
    });
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
    // Nothing had shipped, so nothing was fulfilled to undo; the line is free to be planned again.
    expect((await orderState(order.orderId)).fulfillment_status).toBe('unfulfilled');
    const again = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    expect(again.status).toBe('pending');
  });

  it('consumes and releases stock through the real inventory module, once per shipment', async () => {
    const order = await placedOrder();
    const line = order.lines[0]!;
    const variant = (
      await owner.query<{ variant_id: string }>(
        `SELECT variant_id FROM order_line_item WHERE id = $1`,
        [line.id],
      )
    ).rows[0]!.variant_id;
    const level = async () =>
      (
        await owner.query<{ on_hand: number; reserved: number }>(
          `SELECT on_hand, reserved FROM inventory_level WHERE variant_id = $1 AND warehouse_id = $2`,
          [variant, WH],
        )
      ).rows[0]!;
    const movements = (shipmentId: string) =>
      owner.query<{ reason: string; delta: number; reference_type: string }>(
        `SELECT reason, delta, reference_type FROM stock_movement
          WHERE reference_id = $1 ORDER BY created_at, reason`,
        [shipmentId],
      );

    const before = await level();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: line.id, quantity: 2 }],
      actor,
    });
    const consumed = await movements(planned.id);
    expect(consumed.rows).toEqual([{ reason: 'sale', delta: -2, reference_type: 'shipment' }]);
    const afterConsume = await level();
    expect(afterConsume.on_hand).toBe(before.on_hand - 2);

    await updateShipment(a, planned.id, { status: 'cancelled', actor });
    const released = await movements(planned.id);
    expect(released.rows.map((row) => row.reference_type).sort()).toEqual([
      'shipment',
      'shipment_release',
    ]);
    // The goods are back on hand: net zero movement for this shipment.
    expect((await level()).on_hand).toBe(before.on_hand);
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

interface WebhookRow {
  provider: string;
  provider_event_id: string;
  event_type: string;
  provider_object_id: string | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  status: string;
  failure_reason: string | null;
  occurred_at: Date | null;
  received_at: Date;
  payload: Record<string, unknown>;
  payload_hash: string;
  store_id: string;
  replay_count: number;
}
const webhookRow = async (eventId: string) =>
  (
    await owner.query<WebhookRow>(
      `SELECT provider, provider_event_id, event_type, provider_object_id, aggregate_type, aggregate_id, status,
              failure_reason, occurred_at, received_at, payload, payload_hash, store_id, replay_count
         FROM webhook_event WHERE provider = 'easypost' AND provider_event_id = $1`,
      [eventId],
    )
  ).rows[0];

async function shippedShipment() {
  const order = await placedOrder();
  const planned = await createShipment(a, {
    orderId: order.orderId,
    warehouseId: WH,
    items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
    actor,
  });
  await pack(planned.id);
  const labelled = await buyShipmentLabel(a, planned.id, { actor });
  return { orderId: order.orderId, shipmentId: planned.id, tracking: labelled.tracking_number! };
}

describe('a two-shipment order, replayed', () => {
  it('folds its own event stream back into the order the database holds', async () => {
    // Two lines, one shipment each, despatched at different times — the partial-fulfilment path end to end.
    const order = await placedOrder(2);
    const [first, second] = order.lines;
    const shipmentOne = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: first!.id, quantity: first!.quantity }],
      actor,
    });
    await updateShipment(a, shipmentOne.id, { status: 'shipped', actor });
    expect((await orderState(order.orderId)).fulfillment_status).toBe('partially_fulfilled');

    const shipmentTwo = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: second!.id, quantity: second!.quantity }],
      actor,
    });
    await updateShipment(a, shipmentTwo.id, { status: 'shipped', actor });
    await updateShipment(a, shipmentOne.id, { status: 'delivered', actor });
    await updateShipment(a, shipmentTwo.id, { status: 'delivered', actor });

    // Every order event this order ever wrote, in order, folded from nothing.
    const stream = await owner.query<ProjectedEvent>(
      `SELECT topic, payload FROM outbox
        WHERE aggregate_type = 'order' AND aggregate_id = $1 ORDER BY seq`,
      [order.orderId],
    );
    const replayed = projectOrder(stream.rows);
    const live = await owner.query<{
      status: string;
      payment_status: string;
      fulfillment_status: string;
    }>(`SELECT status, payment_status, fulfillment_status FROM "order" WHERE id = $1`, [
      order.orderId,
    ]);

    expect(replayed).toMatchObject({
      order_id: order.orderId,
      status: live.rows[0]!.status,
      payment_status: live.rows[0]!.payment_status,
      fulfillment_status: live.rows[0]!.fulfillment_status,
    });
    // The shipments told the truth on the way: fulfilled, delivered, completed.
    expect(replayed!.fulfillment_status).toBe('fulfilled');
    expect(replayed!.status).toBe('completed');

    // And each shipment's own stream is exactly one event per transition.
    for (const id of [shipmentOne.id, shipmentTwo.id]) {
      const topics = (await eventsFor(id)).rows.map((row) => row.topic);
      expect(topics).toEqual(['shipment.created', 'shipment.shipped', 'shipment.delivered']);
    }
  });
});

describe('tracking webhooks', () => {
  it('carries a packed shipment from its label to delivered on carrier scans alone', async () => {
    // Integration 2a end to end: the operator buys the label, then only the carrier moves the shipment. Every
    // scan arrives signed, is recorded once, and the shipment's own state machine decides what it means.
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      service: 'manual_standard',
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await pack(planned.id);
    const labelled = await buyShipmentLabel(a, planned.id, { actor });
    const tracking = labelled.tracking_number!;

    const scans: { status: string; at: string }[] = [
      { status: 'pre_transit', at: '2026-10-06T08:00:00Z' },
      { status: 'in_transit', at: '2026-10-06T12:00:00Z' },
      { status: 'out_for_delivery', at: '2026-10-07T07:30:00Z' },
      { status: 'delivered', at: '2026-10-07T10:15:00Z' },
    ];
    const outcomes: string[] = [];
    for (const [index, scan] of scans.entries()) {
      const result = await handleEasyPostWebhook(
        a,
        webhook(tracking, scan.status, `evt_life_${planned.id}_${index}`, scan.at),
      );
      outcomes.push(`${scan.status}:${result.outcome}:${result.status ?? '-'}`);
    }
    expect(outcomes).toEqual([
      // `pre_transit` maps to nothing actionable; `out_for_delivery` is still `in_transit` for us, so the
      // shipment is already there and the scan is recorded and skipped.
      'pre_transit:skipped:label_created',
      'in_transit:applied:in_transit',
      'out_for_delivery:skipped:in_transit',
      'delivered:applied:delivered',
    ]);

    const finished = await getShipment(a, planned.id);
    expect(finished).toMatchObject({ status: 'delivered', tracking_number: tracking });
    expect(finished.label_url).toBe(labelled.label_url);
    // The carrier's own clock, not ours: `in_transit` is when the parcel left, delivery when it arrived.
    expect(finished.shipped_at).toBe('2026-10-06T12:00:00.000Z');
    expect(finished.delivered_at).toBe('2026-10-07T10:15:00.000Z');

    // The whole stream, in `seq` order (the outbox identity = the write order, #255): the label first, then
    // the despatch the `in_transit` scan implies, then the delivery.
    const events = await eventsFor(planned.id);
    expect(events.rows.map((row) => row.topic)).toEqual([
      'shipment.created',
      'shipment.label_created',
      'shipment.shipped',
      'shipment.delivered',
    ]);
    expect(events.rows[3]!.payload).toMatchObject({
      shipment_id: planned.id,
      order_id: order.orderId,
      // The event passes the carrier's instant through exactly as the carrier wrote it; the column above is the
      // same instant after Postgres normalised it. Both are ISO-8601 and neither is invented here.
      delivered_at: '2026-10-07T10:15:00Z',
    });
    // And the order heard it: one shipment, fully delivered.
    expect(await orderState(order.orderId)).toEqual({
      status: 'completed',
      fulfillment_status: 'fulfilled',
    });
  });

  it('applies a scan, stores a redacted extract with the raw body hash, and a duplicate changes nothing', async () => {
    const { shipmentId, tracking } = await shippedShipment();
    const req = webhook(tracking, 'in_transit', `evt_dup_${shipmentId}`, '2026-09-08T10:00:00Z');
    const first = await handleEasyPostWebhook(a, req);
    expect(first).toMatchObject({ outcome: 'applied', shipmentId, status: 'in_transit' });

    const row = (await webhookRow(`evt_dup_${shipmentId}`))!;
    expect(row).toMatchObject({
      provider: 'easypost',
      event_type: 'tracker.updated',
      provider_object_id: `trk_evt_dup_${shipmentId}`,
      aggregate_type: 'shipment',
      aggregate_id: shipmentId,
      status: 'processed',
      failure_reason: null,
      store_id: A,
      replay_count: 0,
    });
    expect(row.payload_hash).toBe(createHash('sha256').update(req.rawBody).digest('hex'));
    expect(row.payload_hash).toBe(payloadHashOf(req.rawBody));
    expect(row.payload).toEqual({
      provider_event_id: `evt_dup_${shipmentId}`,
      event_type: 'tracker.updated',
      tracker_id: `trk_evt_dup_${shipmentId}`,
      tracking_code: tracking,
      carrier: 'manual',
      status: 'in_transit',
      occurred_at: '2026-09-08T10:00:00Z',
    });
    // #187: no raw payload, no address, name or scan location anywhere on the row.
    const stored = JSON.stringify(row);
    for (const pii of ['Keizersgracht', 'Amsterdam', '1015 CJ', 'Jane Doe']) {
      expect(stored).not.toContain(pii);
    }

    const second = await handleEasyPostWebhook(a, req);
    expect(second.outcome).toBe('duplicate');
    // The transition emitted shipment.shipped once (in_transit passes through shipped), never twice.
    const events = await eventsFor(shipmentId);
    expect(events.rows.filter((e) => e.topic === 'shipment.shipped')).toHaveLength(1);
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
    expect(late).toMatchObject({ outcome: 'skipped', status: 'delivered' });
    expect(await webhookRow(`evt_late_${shipmentId}`)).toMatchObject({
      status: 'skipped',
      aggregate_id: shipmentId,
      failure_reason: 'shipment is already at or past this status',
    });

    const events = await eventsFor(shipmentId);
    expect(events.rows.map((e) => e.topic).sort()).toEqual([
      'shipment.created',
      'shipment.delivered',
      'shipment.label_created',
      'shipment.shipped',
    ]);
    const row = await getShipment(a, shipmentId);
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).toContain('2026-09-09');
  });

  it('rejects a bad signature and a body that is not a tracker update, storing nothing', async () => {
    const { tracking } = await shippedShipment();
    const req = webhook(tracking, 'in_transit', 'evt_badsig', '2026-09-08T10:00:00Z');
    await expect(
      handleEasyPostWebhook(a, { ...req, signature: 'hmac-sha256-hex=deadbeef' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(handleEasyPostWebhook(a, { ...req, signature: null })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(
      handleEasyPostWebhook(a, {
        ...req,
        rawBody: 'not json',
        signature: `hmac-sha256-hex=${createHmac('sha256', SECRET).update('not json', 'utf8').digest('hex')}`,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(await webhookRow('evt_badsig')).toBeUndefined();
  });

  it('refuses to guess when two shipments share a tracking number', async () => {
    const first = await shippedShipment();
    const second = await shippedShipment();
    // Force the collision the schema does not prevent.
    await owner.query(`UPDATE shipment SET tracking_number = $2 WHERE id = $1`, [
      second.shipmentId,
      first.tracking,
    ]);
    const result = await handleEasyPostWebhook(
      a,
      webhook(
        first.tracking,
        'delivered',
        `evt_ambig_${second.shipmentId}`,
        '2026-09-09T11:00:00Z',
      ),
    );
    expect(result).toMatchObject({
      outcome: 'skipped',
      shipmentId: null,
      reason: 'more than one shipment has this tracking number',
    });
    // Neither shipment moved.
    expect((await getShipment(a, first.shipmentId)).status).toBe('label_created');
    expect((await getShipment(a, second.shipmentId)).status).toBe('label_created');
    expect(await webhookRow(`evt_ambig_${second.shipmentId}`)).toMatchObject({
      status: 'skipped',
      aggregate_id: null,
    });
  });

  it('records a scan for a tracking number we do not know as skipped', async () => {
    const result = await handleEasyPostWebhook(
      a,
      webhook('MANUNKNOWN', 'delivered', 'evt_unknown_1', '2026-09-09T11:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'skipped', shipmentId: null });
    expect(await webhookRow('evt_unknown_1')).toMatchObject({
      status: 'skipped',
      aggregate_type: null,
      aggregate_id: null,
      failure_reason: 'no shipment with this tracking number',
    });
  });

  it('skips a carrier status that maps to nothing actionable', async () => {
    const { shipmentId, tracking } = await shippedShipment();
    const result = await handleEasyPostWebhook(
      a,
      webhook(tracking, 'pre_transit', `evt_pre_${shipmentId}`, '2026-09-08T08:00:00Z'),
    );
    expect(result).toMatchObject({ outcome: 'skipped', status: 'label_created' });
  });

  it('stores the carrier timestamp separately from ours, and null when the carrier sent none', async () => {
    const { shipmentId, tracking } = await shippedShipment();
    await handleEasyPostWebhook(
      a,
      webhook(tracking, 'in_transit', `evt_ts_${shipmentId}`, '2026-09-08T10:00:00Z'),
    );
    const row = (await webhookRow(`evt_ts_${shipmentId}`))!;
    expect(row.status).toBe('processed');
    expect(row.occurred_at!.toISOString()).toBe('2026-09-08T10:00:00.000Z');
    expect(row.received_at.getTime()).toBeGreaterThan(row.occurred_at!.getTime());

    // No timestamp at all: occurred_at stays null and the shipment still moves, on receipt time.
    const { shipmentId: other, tracking: code } = await shippedShipment();
    const rawBody = JSON.stringify({
      id: `evt_nots_${other}`,
      description: 'tracker.updated',
      result: { tracking_code: code, status: 'in_transit' },
    });
    const signature = `hmac-sha256-hex=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
    const moved = await handleEasyPostWebhook(a, {
      rawBody,
      signature,
      secret: SECRET,
      organizationId: ORG,
      storeId: A,
    });
    expect(moved).toMatchObject({ outcome: 'applied' });
    expect((await webhookRow(`evt_nots_${other}`))!.occurred_at).toBeNull();
    const shipped = await getShipment(a, other);
    expect(new Date(shipped.shipped_at!).getFullYear()).toBeGreaterThan(2000);
  });
});

describe('shippingWebhookRouter', () => {
  let logLines: string[];
  const env = { EASYPOST_WEBHOOK_SECRET_BRAND_A: SECRET };
  function app(routerEnv: NodeJS.ProcessEnv = env) {
    const e = express();
    e.use(shippingWebhookRouter({ env: routerEnv, log: (line) => logLines.push(line) }));
    e.use(coreErrorHandler);
    return e;
  }
  beforeEach(() => {
    logLines = [];
  });

  it('POST /webhooks/easypost/:storeCode verifies the raw body: 200 applied, 200 duplicate', async () => {
    const { shipmentId, tracking } = await shippedShipment();
    const req = webhook(tracking, 'in_transit', `evt_http_${shipmentId}`, '2026-09-08T10:00:00Z');
    const send = () =>
      request(app())
        .post('/webhooks/easypost/brand-a')
        .set('Content-Type', 'application/json; charset=utf-8')
        .set('X-Hmac-Signature', req.signature)
        .send(req.rawBody); // a string goes on the wire verbatim
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      received: true,
      event_id: `evt_http_${shipmentId}`,
      outcome: 'applied',
      shipment_id: shipmentId,
    });
    const dup = await send();
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ outcome: 'duplicate', shipment_id: null });
    // One line per delivery, ids and outcome only.
    expect(logLines).toHaveLength(2);
    for (const line of logLines) {
      expect(line).not.toMatch(/Keizersgracht|Amsterdam|Jane|whsec/);
    }
  });

  it('401 on a wrong signature, 404 on an unknown store, 503 without a configured secret', async () => {
    const { tracking } = await shippedShipment();
    const req = webhook(tracking, 'in_transit', 'evt_http_bad', '2026-09-08T10:00:00Z');
    const bad = await request(app())
      .post('/webhooks/easypost/brand-a')
      .set('Content-Type', 'application/json')
      .set('X-Hmac-Signature', 'hmac-sha256-hex=deadbeef')
      .send(req.rawBody);
    expect(bad.status).toBe(401);

    const unknown = await request(app())
      .post('/webhooks/easypost/no-such-store')
      .set('X-Hmac-Signature', req.signature)
      .send(req.rawBody);
    expect(unknown.status).toBe(404);

    const unconfigured = await request(app({}))
      .post('/webhooks/easypost/brand-a')
      .set('X-Hmac-Signature', req.signature)
      .send(req.rawBody);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.details).toEqual({ missing: 'EASYPOST_WEBHOOK_SECRET_BRAND_A' });
    expect(JSON.stringify(unconfigured.body)).not.toContain(SECRET);
    expect(await webhookRow('evt_http_bad')).toBeUndefined();
  });
});

describe('shippingAdminRouter', () => {
  let app: express.Express;
  const as = (subject: string) => ({
    post: (path: string, body?: unknown) =>
      request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
    patch: (path: string, body?: unknown) =>
      request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  });

  beforeAll(() => {
    app = express();
    mountCoreMiddleware(app, new DevTokenVerifier());
    app.use(shippingAdminRouter());
    app.use(coreErrorHandler);
  });

  it('createShipment: 201 for operations, 403 for a store admin, 400 on a body the spec refuses', async () => {
    const order = await placedOrder();
    const path = `/admin/stores/${A}/orders/${order.orderId}/shipments`;
    const payload = {
      warehouse_id: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
    };

    const denied = await as('seed-store-admin').post(path, payload);
    expect(denied.status).toBe(403);

    const invalid = await as('seed-operations').post(path, { warehouse_id: WH, items: [] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('validation_error');

    const created = await as('seed-operations').post(path, payload);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      order_id: order.orderId,
      warehouse_id: WH,
      status: 'pending',
      items: payload.items,
    });
  });

  it('buyShipmentLabel: 200 on a packed shipment, 403, 409 unless packed, 404 unknown', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      service: 'manual_standard',
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    const path = `/admin/shipments/${planned.id}/label`;

    // The permission is the spec's (`operations` on `organization:hq`), exactly like pick and pack.
    expect((await as('seed-store-admin').post(path)).status).toBe(403);

    const tooEarly = await as('seed-operations').post(path);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body).toMatchObject({ code: 'conflict', details: { status: 'pending' } });

    await pack(planned.id);
    const bought = await as('seed-operations').post(path);
    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({
      id: planned.id,
      order_id: order.orderId,
      status: 'label_created',
      carrier: LABEL_CARRIER,
    });
    expect(bought.body.tracking_number).toMatch(/^MAN[0-9A-F]{16}$/);
    expect(bought.body.label_url).toMatch(/^https:\/\//);
    expect(bought.body.tracking_url).toMatch(/^https:\/\//);

    // A second call finds `label_created`, not `packed`.
    expect((await as('seed-operations').post(path)).status).toBe(409);

    const missing = await as('seed-operations').post(
      '/admin/shipments/00000000-0000-4000-8000-000000000000/label',
    );
    expect(missing.status).toBe(404);
  });

  it('buyShipmentLabel: 422 provider_unsupported for the manual carrier', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    await pack(planned.id);
    await owner.query(
      `UPDATE store SET settings = jsonb_set(settings, ARRAY['shipping', 'provider'], '"manual"'::jsonb, true)
        WHERE id = $1`,
      [A],
    );
    try {
      const refused = await as('seed-operations').post(`/admin/shipments/${planned.id}/label`);
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual({
        code: 'provider_unsupported',
        message: expect.stringContaining('cannot buy labels'),
        details: { provider: 'manual' },
      });
    } finally {
      await owner.query(
        `UPDATE store SET settings = jsonb_set(settings, ARRAY['shipping', 'provider'], $2::jsonb, true)
          WHERE id = $1`,
        [A, JSON.stringify(TEST_CARRIER)],
      );
    }
  });

  it('updateShipment: resolves the shipment store, 200 for operations, 409 on an illegal move, 404 unknown', async () => {
    const order = await placedOrder();
    const planned = await createShipment(a, {
      orderId: order.orderId,
      warehouseId: WH,
      items: [{ order_line_item_id: order.lines[0]!.id, quantity: 2 }],
      actor,
    });
    const path = `/admin/shipments/${planned.id}`;

    expect((await as('seed-store-admin').patch(path, { status: 'shipped' })).status).toBe(403);

    const shipped = await as('seed-operations').patch(path, {
      status: 'shipped',
      tracking_number: 'TRK-ADMIN-1',
    });
    expect(shipped.status).toBe(200);
    expect(shipped.body).toMatchObject({ status: 'shipped', tracking_number: 'TRK-ADMIN-1' });

    const backwards = await as('seed-operations').patch(path, { status: 'label_created' });
    expect(backwards.status).toBe(409);

    const bogus = await as('seed-operations').patch(path, { status: 'teleported' });
    expect(bogus.status).toBe(400);

    const missing = await as('seed-operations').patch(
      '/admin/shipments/00000000-0000-4000-8000-000000000000',
      { status: 'shipped' },
    );
    expect(missing.status).toBe(404);
  });
});
