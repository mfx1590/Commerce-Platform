// Orders module (issue #105) on a fully seeded throwaway database: the transition table (source of truth, asserted
// equal to the README), one event per legal transition, 409 with { field, from, to } for illegal ones, the
// wrappers windows 7 and 8 call (idempotent on their target state), cancel with the PaymentProvider void, order
// edits with recomputed totals, the outbox replay through the pure projection, compensation (row unchanged, no
// event), the Admin API list/read/cancel services and RLS.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import {
  completeCart,
  createPaymentSession,
  manualPaymentProvider,
  setFraudCheck,
  setPaymentProvider,
} from '../checkout';
import {
  cancelLine,
  cancelOrder,
  confirmOrder,
  decreaseLineQuantity,
  FULFILLMENT_TRANSITIONS,
  getAdminOrder,
  listAdminOrders,
  markDelivered,
  markPaymentAuthorized,
  markPaymentCaptured,
  markPaymentFailed,
  markShipmentCreated,
  markShipmentStarted,
  markShipped,
  PAYMENT_TRANSITIONS,
  projectOrder,
  resolveOrderReviewWith,
  setFulfillmentStatus,
  STATUS_TRANSITIONS,
  transition,
  transitionTableMarkdown,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: null, type: 'system' as const, requestId: 'req-orders' };
const customer = { id: null, type: 'customer' as const, requestId: 'req-orders' };
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
let b: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let variants: string[];
let standardOptionId: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase('core_orders');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
  const vs = await owner.query<{ id: string }>(
    `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     WHERE v.store_id = $1 AND (SELECT coalesce(sum(il.available), 0) FROM inventory_level il WHERE il.variant_id = v.id) >= 20
     ORDER BY v.sku`,
    [A],
  );
  variants = vs.rows.map((v) => v.id);
  const opt = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  standardOptionId = opt.rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

afterEach(() => {
  setPaymentProvider(manualPaymentProvider);
});

/** Places a brand-a order with `lines` variants (quantity 2 each) through the cart + checkout modules. */
async function placeOrder(lines = 1, metadata?: Record<string, unknown>) {
  const i = n++;
  const cart = await createCart(a, scopeA, metadata ? { metadata } : {});
  for (let k = 0; k < lines; k++) {
    await addLineItem(a, cart.id, {
      variant_id: variants[(i * 3 + k) % variants.length]!,
      quantity: 2,
    });
  }
  await updateCart(a, cart.id, {
    email: `orders+${i}@example.com`,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: standardOptionId,
  });
  await createPaymentSession(a, cart.id, { provider: 'manual' });
  const { order } = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `orders-${cart.id}`,
    actor: customer,
  });
  return order;
}

const stream = async (orderId: string) =>
  (
    await owner.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM outbox WHERE topic LIKE 'order.%' AND aggregate_id::text = $1::text ORDER BY occurred_at, id`,
      [orderId],
    )
  ).rows;

const row = async (orderId: string) =>
  (
    await owner.query<{
      status: string;
      payment_status: string;
      fulfillment_status: string;
      display_id: string;
      subtotal_minor: string;
      discount_minor: string;
      shipping_minor: string;
      tax_minor: string;
      total_minor: string;
      cancelled_at: Date | null;
      completed_at: Date | null;
      cancel_reason: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT status, payment_status, fulfillment_status, display_id::text, subtotal_minor::text, discount_minor::text,
              shipping_minor::text, tax_minor::text, total_minor::text, cancelled_at, completed_at, cancel_reason, metadata
       FROM "order" WHERE id = $1`,
      [orderId],
    )
  ).rows[0]!;

/** The row as the projection sees it. */
const projectionOf = async (orderId: string) => {
  const r = await row(orderId);
  return {
    status: r.status,
    payment_status: r.payment_status,
    fulfillment_status: r.fulfillment_status,
    display_id: Number(r.display_id),
    totals: {
      subtotal_minor: Number(r.subtotal_minor),
      discount_minor: Number(r.discount_minor),
      shipping_minor: Number(r.shipping_minor),
      tax_minor: Number(r.tax_minor),
      total_minor: Number(r.total_minor),
    },
    cancelled_at: r.cancelled_at?.toISOString() ?? null,
    completed_at: r.completed_at?.toISOString() ?? null,
    cancel_reason: r.cancel_reason,
  };
};

describe('transition table', () => {
  it('is the one the README documents', () => {
    // prettier pads table cells: compare with runs of spaces collapsed
    const squash = (t: string) => t.replace(/ +/g, ' ');
    const readme = squash(readFileSync(join(__dirname, 'README.md'), 'utf8'));
    for (const table of [STATUS_TRANSITIONS, PAYMENT_TRANSITIONS, FULFILLMENT_TRANSITIONS]) {
      for (const line of transitionTableMarkdown(table)) expect(readme).toContain(squash(line));
    }
  });

  it('every terminal state has no exits; illegal moves → 409 conflict with { field, from, to }', async () => {
    expect(STATUS_TRANSITIONS.completed).toEqual([]);
    expect(STATUS_TRANSITIONS.cancelled).toEqual([]);
    expect(PAYMENT_TRANSITIONS.refunded).toEqual([]);
    expect(FULFILLMENT_TRANSITIONS.returned).toEqual([]);
    const order = await placeOrder(); // confirmed at placement (#350)
    await expect(
      a.transaction((tx) => transition(tx, order.id, { status: 'completed', actor })),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { field: 'status', from: 'confirmed', to: 'completed' },
    });
    await expect(
      a.transaction((tx) => transition(tx, order.id, { payment_status: 'refunded', actor })),
    ).rejects.toMatchObject({
      details: { field: 'payment_status', from: 'authorized', to: 'refunded' },
    });
    await expect(
      a.transaction((tx) => transition(tx, order.id, { fulfillment_status: 'returned', actor })),
    ).rejects.toMatchObject({
      details: { field: 'fulfillment_status', from: 'unfulfilled', to: 'returned' },
    });
    await expect(a.transaction((tx) => transition(tx, order.id, { actor }))).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect((await stream(order.id)).map((e) => e.topic)).toEqual([
      'order.placed',
      'order.confirmed',
    ]);
  });
});

describe('lifecycle through the public wrappers (windows 7 and 8)', () => {
  it('confirmed at placement → captured → processing → shipped → delivered: one event per transition, idempotent re-calls, replay matches', async () => {
    const order = await placeOrder(2);
    const topics = async () => (await stream(order.id)).map((e) => e.topic);
    // #350: the payment was authorised at placement, so the order is confirmed in the placement transaction —
    // order.placed first, order.confirmed right behind it.
    expect(order.status).toBe('confirmed');
    expect(await topics()).toEqual(['order.placed', 'order.confirmed']);
    await confirmOrder(a, order.id, actor); // the explicit call is a no-op now
    expect(await topics()).toHaveLength(2);

    const captured = await markPaymentCaptured(a, order.id, actor);
    expect(captured.payment_status).toBe('captured');
    let last = (await stream(order.id)).at(-1)!;
    expect(last.topic).toBe('order.updated');
    expect(last.payload.changed_fields).toEqual(['payment_status']);

    // planning a shipment moves nothing (#350: processing waits for the first shipment to LEAVE planned) …
    const planned = await markShipmentCreated(a, order.id, actor);
    expect(planned.status).toBe('confirmed');
    expect(await topics()).toHaveLength(3);
    // … and a delivery report before anything shipped is a quiet no-op, not a 409
    expect((await markDelivered(a, order.id, actor)).status).toBe('confirmed');
    expect(await topics()).toHaveLength(3);

    const processing = await markShipmentStarted(a, order.id, actor);
    expect(processing.status).toBe('processing');
    last = (await stream(order.id)).at(-1)!;
    expect(last).toMatchObject({
      topic: 'order.updated',
      payload: { status: 'processing', changed_fields: ['status'] },
    });
    await markShipmentStarted(a, order.id, actor); // idempotent
    expect(await topics()).toHaveLength(4);

    const [l1, l2] = processing.items;
    const partial = await markShipped(a, order.id, [{ lineItemId: l1!.id, quantity: 2 }], actor);
    expect(partial.fulfillment_status).toBe('partially_fulfilled');
    expect(partial.items.find((l) => l.id === l1!.id)!.fulfilled_quantity).toBe(2);
    const full = await markShipped(a, order.id, [{ lineItemId: l2!.id, quantity: 5 }], actor); // capped at 2
    expect(full.fulfillment_status).toBe('fulfilled');
    expect(full.items.find((l) => l.id === l2!.id)!.fulfilled_quantity).toBe(2);
    last = (await stream(order.id)).at(-1)!;
    expect(last.payload.changed_fields).toEqual(['fulfillment_status', 'line_items']);

    const done = await markDelivered(a, order.id, actor);
    expect(done.status).toBe('completed');
    expect(await topics()).toEqual([
      'order.placed',
      'order.confirmed',
      'order.updated',
      'order.updated',
      'order.updated',
      'order.updated',
      'order.completed',
    ]);
    await markDelivered(a, order.id, actor); // idempotent
    expect(await topics()).toHaveLength(7);

    // replay: the outbox stream reproduces the row
    const projected = projectOrder(await stream(order.id))!;
    const { applied: _applied, order_id: _id, placed_at: _p, ...state } = projected;
    expect(state).toEqual(await projectionOf(order.id));
  });

  it('a pending order: a shipment leaving planned is illegal (pending → processing); payment failure only touches payment_status; a new authorisation confirms it', async () => {
    const order = await placeOrder();
    // placed-but-not-confirmed is what a fraud hold leaves behind; the row is put there by hand
    await owner.query(`UPDATE "order" SET status = 'pending' WHERE id = $1`, [order.id]);
    await expect(markShipmentStarted(a, order.id, actor)).rejects.toMatchObject({
      details: { field: 'status', from: 'pending', to: 'processing' },
    });
    const failed = await markPaymentFailed(a, order.id, actor);
    expect(failed).toMatchObject({ status: 'pending', payment_status: 'failed' });
    // #350: the authorisation confirms the order in the same transaction as the payment move
    const authorized = await markPaymentAuthorized(a, order.id, actor);
    expect(authorized).toMatchObject({ status: 'confirmed', payment_status: 'authorized' });
    expect(
      (await stream(order.id)).slice(-2).map((e) => [e.topic, e.payload.changed_fields ?? null]),
    ).toEqual([
      ['order.updated', ['payment_status']],
      ['order.confirmed', null],
    ]);
  });
});

describe('the automatic lifecycle (#350)', () => {
  const statusOf = async (orderId: string) => (await row(orderId)).status;
  const shipmentRows = async (orderId: string, statuses: string[]) => {
    const ids: string[] = [];
    for (const status of statuses) {
      const r = await owner.query<{ id: string }>(
        `INSERT INTO shipment (organization_id, store_id, order_id, warehouse_id, carrier, currency, status)
         VALUES ($1, $2, $3, $4, 'manual', 'EUR', $5) RETURNING id`,
        [ORG, A, orderId, SEED_IDS.warehouses.eu, status],
      );
      ids.push(r.rows[0]!.id);
    }
    return ids;
  };
  const setShipment = (id: string, status: string) =>
    owner.query(`UPDATE shipment SET status = $2 WHERE id = $1`, [id, status]);

  it('an order held by a fraud review stays pending — through a capture too — and confirms when the review is cleared', async () => {
    setFraudCheck({
      async evaluate() {
        return { outcome: 'review', reasonCode: 'velocity_email', provider: 'rules' };
      },
    });
    let order;
    try {
      order = await placeOrder();
    } finally {
      setFraudCheck(null);
    }
    expect(order.status).toBe('pending');
    const topics = async () => (await stream(order.id)).map((e) => e.topic);
    // the review flag and order.placed are written in the placement transaction (the flag first); no confirmation
    expect([...(await topics())].sort()).toEqual(['order.placed', 'order.updated']);
    expect((await markPaymentCaptured(a, order.id, actor)).status).toBe('pending');
    await expect(confirmOrder(a, order.id, actor)).rejects.toMatchObject({ code: 'conflict' });

    await resolveOrderReviewWith(a, order.id, {
      status: 'cleared',
      resolution: 'looked fine',
      actor,
    });
    expect(await statusOf(order.id)).toBe('confirmed');
    expect((await topics()).slice(2)).toEqual([
      'order.updated', // captured
      'order.updated', // cleared
      'order.confirmed',
    ]);
    // a second clearing changes nothing
    await resolveOrderReviewWith(a, order.id, { status: 'cleared', resolution: 'again', actor });
    expect(await topics()).toHaveLength(5);
  });

  it('confirmed_fraud keeps the hold: no confirmation, and a later capture does not confirm either', async () => {
    setFraudCheck({
      async evaluate() {
        return { outcome: 'review', reasonCode: 'velocity_email', provider: 'rules' };
      },
    });
    let order;
    try {
      order = await placeOrder();
    } finally {
      setFraudCheck(null);
    }
    await resolveOrderReviewWith(a, order.id, {
      status: 'confirmed_fraud',
      resolution: 'stolen card',
      actor,
    });
    expect((await markPaymentCaptured(a, order.id, actor)).status).toBe('pending');
    expect((await stream(order.id)).map((e) => e.topic)).not.toContain('order.confirmed');
  });

  it('shipping goods moves a confirmed order to processing in the same event as the fulfilment; a pending order keeps its status', async () => {
    const order = await placeOrder(2);
    const [l1, l2] = order.items;
    const partial = await markShipped(a, order.id, [{ lineItemId: l1!.id, quantity: 2 }], actor);
    expect(partial).toMatchObject({
      status: 'processing',
      fulfillment_status: 'partially_fulfilled',
    });
    const last = (await stream(order.id)).at(-1)!;
    expect(last).toMatchObject({
      topic: 'order.updated',
      payload: {
        status: 'processing',
        fulfillment_status: 'partially_fulfilled',
        changed_fields: ['fulfillment_status', 'line_items', 'status'],
      },
    });
    const rest = await markShipped(a, order.id, [{ lineItemId: l2!.id, quantity: 2 }], actor);
    expect(rest).toMatchObject({ status: 'processing', fulfillment_status: 'fulfilled' });

    const held = await placeOrder();
    await owner.query(`UPDATE "order" SET status = 'pending' WHERE id = $1`, [held.id]);
    const shipped = await markShipped(
      a,
      held.id,
      [{ lineItemId: held.items[0]!.id, quantity: 2 }],
      actor,
    );
    expect(shipped).toMatchObject({ status: 'pending', fulfillment_status: 'fulfilled' });
  });

  it('completed only when EVERY shipment is delivered (cancelled ones do not count) and the order is fulfilled; a delivery report before that is a quiet no-op', async () => {
    const order = await placeOrder(2);
    const [first, second, dropped] = await shipmentRows(order.id, [
      'pending',
      'pending',
      'cancelled',
    ]);
    // delivered reports arrive before anything shipped: nothing happens, nothing emitted
    expect((await markDelivered(a, order.id, actor)).status).toBe('confirmed');
    await markShipped(
      a,
      order.id,
      order.items.map((l) => ({ lineItemId: l.id, quantity: 2 })),
      actor,
    );
    expect(await statusOf(order.id)).toBe('processing');
    const before = (await stream(order.id)).length;

    await setShipment(first!, 'delivered');
    expect((await markDelivered(a, order.id, actor)).status).toBe('processing'); // one still open
    expect((await stream(order.id)).length).toBe(before);
    await setShipment(second!, 'delivered');
    const done = await markDelivered(a, order.id, actor);
    expect(done.status).toBe('completed');
    expect((await stream(order.id)).at(-1)!.topic).toBe('order.completed');
    expect(dropped).toBeTruthy(); // the cancelled shipment never counted
    await markDelivered(a, order.id, actor); // idempotent
    expect((await stream(order.id)).length).toBe(before + 1);
  });

  it('a confirmed order whose shipments are all delivered passes through processing on the way to completed (two events)', async () => {
    const order = await placeOrder();
    await owner.query(
      `UPDATE order_line_item SET fulfilled_quantity = quantity WHERE order_id = $1`,
      [order.id],
    );
    await a.transaction((tx) =>
      setFulfillmentStatus({ tx, orderId: order.id, status: 'fulfilled', actor }),
    );
    const [only] = await shipmentRows(order.id, ['delivered']);
    expect(only).toBeTruthy();
    expect((await markDelivered(a, order.id, actor)).status).toBe('completed');
    expect(
      (await stream(order.id)).slice(-2).map((e) => [e.topic, e.payload.status ?? null]),
    ).toEqual([
      ['order.updated', 'processing'],
      ['order.completed', null],
    ]);
  });
});

describe('cancelOrder', () => {
  it('voids the authorised payment through the provider once, marks the payment cancelled, emits order.cancelled; idempotent; replay matches', async () => {
    let voids = 0;
    setPaymentProvider({
      ...manualPaymentProvider,
      async void(input) {
        voids++;
        expect(input.providerPaymentId).toMatch(/^manpay_/);
        expect(input.reason).toBe('customer request');
        return { status: 'voided' };
      },
    });
    const order = await placeOrder();
    await confirmOrder(a, order.id, actor);
    const cancelled = await cancelOrder(a, order.id, { reason: 'customer request', actor });
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'customer request' });
    expect(cancelled.payments[0]!.status).toBe('cancelled');
    expect(voids).toBe(1);
    const events = await stream(order.id);
    const last = events.at(-1)!;
    expect(last.topic).toBe('order.cancelled');
    expect(last.payload).toMatchObject({
      order_id: order.id,
      display_id: order.display_id,
      legal_entity_id: SEED_IDS.legalEntities.brandA,
      currency: 'EUR',
      reason: 'customer request',
      totals: { total_minor: order.totals.total.amount_minor },
    });
    await cancelOrder(a, order.id, { reason: 'again', actor });
    expect(await stream(order.id)).toHaveLength(events.length);
    expect(voids).toBe(1);
    const r = await row(order.id);
    expect(r.cancelled_at).toBeInstanceOf(Date);
    const {
      applied: _a,
      order_id: _i,
      placed_at: _p,
      ...state
    } = projectOrder(await stream(order.id))!;
    expect(state).toEqual(await projectionOf(order.id));
  });

  it('refuses once something shipped (409), and fails closed when the provider cannot void', async () => {
    const order = await placeOrder();
    await confirmOrder(a, order.id, actor);
    await markShipmentCreated(a, order.id, actor);
    await markShipped(a, order.id, [{ lineItemId: order.items[0]!.id, quantity: 1 }], actor);
    await expect(cancelOrder(a, order.id, { reason: 'late', actor })).rejects.toMatchObject({
      code: 'conflict',
      details: { field: 'fulfillment_status', from: 'partially_fulfilled', to: 'unfulfilled' },
    });

    setPaymentProvider({
      ...manualPaymentProvider,
      async void() {
        return { status: 'failed', failureReason: 'PSP down' };
      },
    });
    const other = await placeOrder();
    await expect(cancelOrder(a, other.id, { reason: 'x', actor })).rejects.toMatchObject({
      code: 'payment_failed',
      message: 'PSP down',
    });
    expect((await row(other.id)).status).toBe('confirmed');
    expect((await stream(other.id)).map((e) => e.topic)).toEqual([
      'order.placed',
      'order.confirmed',
    ]);
  });
});

describe('compensation', () => {
  it('a failure after the row update, or after the event, leaves the row unchanged and writes no event', async () => {
    const order = await placeOrder();
    const before = await row(order.id);
    const count = async () => (await stream(order.id)).length;
    const events = await count();
    for (const hooks of [
      { afterUpdate: async () => Promise.reject(new Error('boom after update')) },
      { afterEvents: async () => Promise.reject(new Error('boom after events')) },
    ]) {
      await expect(
        a.transaction((tx) => transition(tx, order.id, { status: 'processing', actor, hooks })),
      ).rejects.toThrow(/boom/);
      expect(await row(order.id)).toEqual(before);
      expect(await count()).toBe(events);
    }
  });
});

describe('order edits before fulfilment', () => {
  it('quantity down and line cancel recompute totals with the tax calculator, record the delta, emit order.updated', async () => {
    const order = await placeOrder(2);
    const [l1, l2] = order.items;
    const unit1 = l1!.unit_price.amount_minor;
    const edited = await decreaseLineQuantity(a, order.id, l1!.id, 1, actor);
    const line1 = edited.items.find((l) => l.id === l1!.id)!;
    expect(line1.quantity).toBe(1);
    expect(line1.tax.amount_minor).toBe(Math.floor((unit1 * 2100 + 5000) / 10000));
    expect(edited.totals.subtotal.amount_minor).toBe(unit1 + 2 * l2!.unit_price.amount_minor);
    expect(edited.totals.total.amount_minor).toBe(
      edited.totals.subtotal.amount_minor +
        edited.totals.shipping.amount_minor +
        edited.totals.tax.amount_minor,
    );
    const edits = edited.metadata.edits as {
      line_item_id: string;
      from_quantity: number;
      to_quantity: number;
      delta_minor: number;
    }[];
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ line_item_id: l1!.id, from_quantity: 2, to_quantity: 1 });
    expect(edits[0]!.delta_minor).toBe(
      order.totals.total.amount_minor - edited.totals.total.amount_minor,
    );
    expect(edits[0]!.delta_minor).toBeGreaterThan(0);
    let last = (await stream(order.id)).at(-1)!;
    expect(last.topic).toBe('order.updated');
    expect(last.payload.changed_fields).toEqual(
      expect.arrayContaining([
        'line_items',
        'metadata',
        'subtotal_minor',
        'tax_minor',
        'total_minor',
      ]),
    );

    await expect(decreaseLineQuantity(a, order.id, l2!.id, 3, actor)).rejects.toMatchObject({
      code: 'validation_error',
    });
    const one = await cancelLine(a, order.id, l2!.id, actor);
    expect(one.items.map((l) => l.id)).toEqual([l1!.id]);
    expect((one.metadata.edits as unknown[]).length).toBe(2);
    await expect(cancelLine(a, order.id, l1!.id, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { field: 'line_items' },
    });
    last = (await stream(order.id)).at(-1)!;
    expect(last.topic).toBe('order.updated');

    // after fulfilment started: no more edits
    await confirmOrder(a, order.id, actor);
    await markShipmentStarted(a, order.id, actor);
    await expect(decreaseLineQuantity(a, order.id, l1!.id, 1, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { field: 'status', from: 'processing' },
    });
  });
});

describe('admin read model', () => {
  it('lists with filters, q (display id / email), sort + order, pagination; RLS hides other stores', async () => {
    const o1 = await placeOrder(); // confirmed at placement (#350)
    const o2 = await placeOrder();
    await markShipmentStarted(a, o2.id, actor); // processing
    const all = await listAdminOrders(a, A, { limit: 100 });
    expect(all.total).toBeGreaterThanOrEqual(2);
    for (const item of all.items) expect(item.total.currency).toBe('EUR');
    const processing = await listAdminOrders(a, A, { status: 'processing', limit: 100 });
    expect(processing.items.map((i) => i.id)).toContain(o2.id);
    expect(processing.items.map((i) => i.id)).not.toContain(o1.id);
    const byId = await listAdminOrders(a, A, { q: `#${o1.display_id}` });
    expect(byId.items.map((i) => i.id)).toEqual([o1.id]);
    const byEmail = await listAdminOrders(a, A, { q: o2.email.toUpperCase() });
    expect(byEmail.items.map((i) => i.id)).toEqual([o2.id]);
    const asc = await listAdminOrders(a, A, { sort: 'display_id', order: 'asc', limit: 100 });
    const ids = asc.items.map((i) => i.display_id);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    const future = await listAdminOrders(a, A, { placed_from: new Date(Date.now() + 86_400_000) });
    expect(future.total).toBe(0);
    const page2 = await listAdminOrders(a, A, { limit: 1, page: 2 });
    expect(page2.items).toHaveLength(1);
    expect(page2).toMatchObject({ page: 2, limit: 1 });

    expect((await listAdminOrders(b, A, {})).total).toBe(0);
    await expect(getAdminOrder(b, o1.id)).rejects.toMatchObject({ code: 'not_found' });
    const detail = await getAdminOrder(a, o1.id);
    expect(detail).toMatchObject({
      id: o1.id,
      customer_id: null,
      sales_channel_id: scopeA.salesChannelId,
      payments: [{ provider: 'manual', status: 'authorized' }],
      refunds: [],
      shipments: [],
      returns: [],
      cancel_reason: null,
    });
    expect(detail.items[0]).toMatchObject({
      tax_rate_bp: 2100,
      fulfilled_quantity: 0,
      returned_quantity: 0,
    });
  });
});

describe("tx-taking markers (window 8, #191): no deadlock behind a shipment insert's FOR KEY SHARE lock", () => {
  it('(confirmed at placement) → shipment created → started → shipped → delivered inside ONE transaction that also inserts the shipment row', async () => {
    const {
      confirmOrderInTx,
      markShipmentCreatedInTx,
      markShipmentStartedInTx,
      markShippedInTx,
      markDeliveredInTx,
      markPaymentCapturedInTx,
    } = await import('./index');
    const order = await placeOrder();
    await a.transaction(async (tx) => {
      await confirmOrderInTx(tx, order.id, actor);
      await markPaymentCapturedInTx(tx, order.id, actor);
      // window 8's INSERT INTO shipment (FK → order) takes FOR KEY SHARE on the order row in this transaction
      await tx.query(
        `INSERT INTO shipment (organization_id, store_id, order_id, warehouse_id, carrier, currency, status)
         VALUES ($1, $2, $3, $4, 'manual', 'EUR', 'pending')`,
        [ORG, A, order.id, SEED_IDS.warehouses.eu],
      );
      await markShipmentCreatedInTx(tx, order.id, actor); // would deadlock on a second connection
      await markShipmentStartedInTx(tx, order.id, actor);
      await markShippedInTx(
        tx,
        order.id,
        order.items.map((l) => ({ lineItemId: l.id, quantity: 2 })),
        actor,
      );
      // window 8 moves the shipment row before it reports the delivery (#350: completion checks every shipment)
      await tx.query(`UPDATE shipment SET status = 'delivered' WHERE order_id = $1`, [order.id]);
      await markDeliveredInTx(tx, order.id, actor);
    });
    const r = await row(order.id);
    expect(r).toMatchObject({
      status: 'completed',
      payment_status: 'captured',
      fulfillment_status: 'fulfilled',
    });
    expect((await stream(order.id)).map((e) => e.topic)).toEqual([
      'order.placed',
      'order.confirmed',
      'order.updated',
      'order.updated',
      'order.updated',
      'order.completed',
    ]);
  });
});

describe("#191's object shape (#214)", () => {
  it('setFulfillmentStatus({ tx, orderId, status, actor }) is the positional twin: applies, idempotent on the target, 409 per the table', async () => {
    const order = await placeOrder();
    await confirmOrder(a, order.id, actor);
    await a.transaction((tx) =>
      setFulfillmentStatus({ tx, orderId: order.id, status: 'partially_fulfilled', actor }),
    );
    expect((await row(order.id)).fulfillment_status).toBe('partially_fulfilled');
    await a.transaction((tx) =>
      setFulfillmentStatus({ tx, orderId: order.id, status: 'partially_fulfilled', actor }),
    );
    expect((await row(order.id)).fulfillment_status).toBe('partially_fulfilled');
    await expect(
      a.transaction((tx) =>
        setFulfillmentStatus({ tx, orderId: order.id, status: 'returned', actor }),
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
