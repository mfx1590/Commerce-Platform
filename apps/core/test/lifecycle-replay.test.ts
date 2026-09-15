// Whole-lifecycle replay (issue #108): place → confirm → capture → shipment created → shipped (reservation consumed,
// window 8's port) → delivered → return requested → received (restock + refund through a requester that writes
// window 7's refund row) → the outbox streams of the order, the return and the touched stock levels are folded
// with the pure projections and compared with the rows. Plus the cancel branch (reservations released) and the
// abandoned branch (cart never placed → job → cart.abandoned). One event per transition, end to end.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addLineItem, createCart, markAllAbandonedCarts, updateCart } from '../src/modules/cart';
import { completeCart, createPaymentSession } from '../src/modules/checkout';
import { consumeReservationsForShipment } from '../src/modules/inventory';
import {
  cancelOrder,
  confirmOrder,
  markDelivered,
  markPaymentCaptured,
  markShipmentCreated,
  markShipped,
  projectOrder,
} from '../src/modules/orders';
import {
  projectReturn,
  receiveReturn,
  requestReturn,
  setRefundRequester,
  type RefundRequest,
} from '../src/modules/returns';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const EU = SEED_IDS.warehouses.eu;
const system = { id: null, type: 'system' as const, requestId: 'req-lifecycle' };
const customer = { id: null, type: 'customer' as const, requestId: 'req-lifecycle' };
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
let variantId: string;
let standardOptionId: string;

beforeAll(async () => {
  db = await createTestDatabase('core_lifecycle');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: null };
  const v = await owner.query<{ id: string }>(
    `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder ORDER BY v.sku LIMIT 1`,
    [A],
  );
  variantId = v.rows[0]!.id;
  await owner.query(
    `UPDATE inventory_level SET on_hand = CASE warehouse_id WHEN $2::uuid THEN 10 ELSE 10 END, reserved = 0 WHERE variant_id = $1`,
    [variantId, EU],
  );
  const opt = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  standardOptionId = opt.rows[0]!.id;
  // window 7's requester stand-in: writes the refund row and returns its id
  setRefundRequester({
    async request(input: RefundRequest) {
      const r = await input.tx.query<{ id: string }>(
        `INSERT INTO refund (organization_id, store_id, order_id, payment_id, return_id, amount_minor, currency, reason, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'return', 'succeeded', $8) RETURNING id`,
        [
          input.organizationId,
          input.storeId,
          input.orderId,
          input.paymentId,
          input.returnId,
          input.amountMinor,
          input.currency,
          input.idempotencyKey,
        ],
      );
      return { status: 'succeeded', refundId: r.rows[0]!.id };
    },
  });
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

async function place(quantity: number, email: string) {
  const cart = await createCart(a, scopeA);
  await addLineItem(a, cart.id, { variant_id: variantId, quantity });
  await updateCart(a, cart.id, {
    email,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: standardOptionId,
  });
  await createPaymentSession(a, cart.id, { provider: 'manual' });
  const { order } = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `life-${cart.id}`,
    actor: customer,
  });
  return { cartId: cart.id, order };
}

const stream = (aggregateId: string, prefix: string) =>
  owner
    .query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM outbox WHERE topic LIKE $2 AND aggregate_id::text = $1::text ORDER BY occurred_at, id`,
      [aggregateId, `${prefix}%`],
    )
    .then((r) => r.rows);

const orderRow = (id: string) =>
  owner
    .query<{
      status: string;
      payment_status: string;
      fulfillment_status: string;
      total_minor: string;
    }>(
      `SELECT status, payment_status, fulfillment_status, total_minor::text FROM "order" WHERE id = $1`,
      [id],
    )
    .then((r) => r.rows[0]!);

/** Folds the stock.moved stream of one (variant, warehouse) from a starting on_hand. */
function projectOnHand(events: { payload: Record<string, unknown> }[], start: number): number {
  return events.reduce((n, e) => n + Number(e.payload.delta), start);
}

describe('whole lifecycle: place → confirm → capture → ship → deliver → return → refund', () => {
  it('the outbox streams reproduce the order, the return and the stock level', async () => {
    const onHandBefore = (
      await owner.query<{ on_hand: number }>(
        `SELECT on_hand FROM inventory_level WHERE variant_id = $1 AND warehouse_id = $2`,
        [variantId, EU],
      )
    ).rows[0]!.on_hand;
    const { order } = await place(3, 'life@example.com');
    await confirmOrder(a, order.id, system);
    await markPaymentCaptured(a, order.id, system);
    await owner.query(
      `UPDATE payment SET status = 'captured', captured_at = now() WHERE order_id = $1`,
      [order.id],
    );
    await markShipmentCreated(a, order.id, system);
    // window 8: plan the shipment → consume the reservation (port shape, idempotent per shipment), then ship
    const shipmentId = '80000000-0000-4000-8000-000000000001';
    const line = order.items[0]!;
    await a.transaction((tx) =>
      consumeReservationsForShipment(tx, {
        organizationId: ORG,
        storeId: A,
        orderId: order.id,
        shipmentId,
        warehouseId: EU,
        items: [{ orderLineItemId: line.id, quantity: 3 }],
        actor: system,
      }),
    );
    const again = await a.transaction((tx) =>
      consumeReservationsForShipment(tx, {
        organizationId: ORG,
        storeId: A,
        orderId: order.id,
        shipmentId,
        items: [{ orderLineItemId: line.id, quantity: 3 }],
        actor: system,
      }),
    );
    expect(again).toEqual([]); // retry: nothing moves twice
    await markShipped(a, order.id, [{ lineItemId: line.id, quantity: 3 }], system);
    await markDelivered(a, order.id, system);
    // return one unit, resellable → restocked, refunded through the requester
    const ret = await requestReturn(a, order.id, {
      items: [{ order_line_item_id: line.id, quantity: 1 }],
      actor: system,
    });
    const received = await receiveReturn(a, ret.id, {
      warehouseId: EU,
      items: [{ order_line_item_id: line.id, quantity: 1, condition: 'resellable' }],
      actor: system,
    });
    expect(received.status).toBe('refunded');
    expect(received.refund_id).toBeTruthy();

    // ---- one event per transition, end to end ----
    const orderTopics = (await stream(order.id, 'order.')).map((e) => e.topic);
    expect(orderTopics).toEqual([
      'order.placed',
      'order.confirmed',
      'order.updated', // payment captured
      'order.updated', // processing
      'order.updated', // fulfilled
      'order.completed',
      'order.updated', // partially_returned
      'order.updated', // partially_refunded
    ]);
    const returnTopics = (await stream(ret.id, 'return.')).map((e) => e.topic);
    expect(returnTopics).toEqual(['return.requested', 'return.received']);

    // ---- replay: order ----
    const projected = projectOrder(await stream(order.id, 'order.'))!;
    const row = await orderRow(order.id);
    expect(projected).toMatchObject({
      status: row.status,
      payment_status: row.payment_status,
      fulfillment_status: row.fulfillment_status,
    });
    expect(projected.totals.total_minor).toBe(Number(row.total_minor));
    expect(row).toMatchObject({
      status: 'completed',
      fulfillment_status: 'partially_returned',
      payment_status: 'partially_refunded',
    });

    // ---- replay: return (refund.issued is window 7's event; the stream ends at received without it) ----
    const retProjected = projectReturn(await stream(ret.id, 'return.'))!;
    expect(retProjected).toMatchObject({ status: 'received', warehouse_id: EU });
    // with window 7's refund.issued appended, the projection reaches refunded with the stored id
    const withRefund = projectReturn([
      ...(await stream(ret.id, 'return.')),
      { topic: 'refund.issued', payload: { return_id: ret.id, refund_id: received.refund_id } },
    ])!;
    expect(withRefund).toMatchObject({ status: 'refunded', refund_id: received.refund_id });

    // ---- replay: stock (EU level of the variant): −3 sale, +1 return ----
    const moves = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = 'stock.moved' AND payload->>'variant_id' = $1 AND payload->>'warehouse_id' = $2 ORDER BY occurred_at, id`,
      [variantId, EU],
    );
    const level = await owner.query<{ on_hand: number; reserved: number }>(
      `SELECT on_hand, reserved FROM inventory_level WHERE variant_id = $1 AND warehouse_id = $2`,
      [variantId, EU],
    );
    expect(projectOnHand(moves.rows, onHandBefore)).toBe(level.rows[0]!.on_hand);
    expect(level.rows[0]!.reserved).toBe(0);
    expect(moves.rows.map((m) => m.payload.reason)).toEqual(['sale', 'return']);
  });

  it('cancel branch: place → confirm → cancel releases the reservation; the streams agree', async () => {
    const { order } = await place(2, 'cancel@example.com');
    await confirmOrder(a, order.id, system);
    const before = await owner.query<{ reserved: number }>(
      `SELECT sum(reserved)::int AS reserved FROM inventory_level WHERE variant_id = $1`,
      [variantId],
    );
    await cancelOrder(a, order.id, { reason: 'changed mind', actor: system });
    const after = await owner.query<{ reserved: number }>(
      `SELECT sum(reserved)::int AS reserved FROM inventory_level WHERE variant_id = $1`,
      [variantId],
    );
    expect(after.rows[0]!.reserved).toBe(before.rows[0]!.reserved - 2);
    expect((await stream(order.id, 'order.')).map((e) => e.topic)).toEqual([
      'order.placed',
      'order.confirmed',
      'order.cancelled',
    ]);
    const projected = projectOrder(await stream(order.id, 'order.'))!;
    expect(projected).toMatchObject({ status: 'cancelled', cancel_reason: 'changed mind' });
    expect((await orderRow(order.id)).status).toBe('cancelled');
    expect(
      (
        await owner.query(`SELECT 1 FROM reservation WHERE order_id = $1 AND released_at IS NULL`, [
          order.id,
        ])
      ).rows,
    ).toHaveLength(0);
  });

  it('abandoned branch: a cart never placed is abandoned by the job with one cart.abandoned', async () => {
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: variantId, quantity: 1 });
    // seven hours later (injected clock; the schema's trigger would overwrite a backdated updated_at)
    const r = await markAllAbandonedCarts(a, {
      now: new Date(Date.now() + 7 * 3_600_000),
      idleForMs: 6 * 3_600_000,
    });
    expect(r.cartIds).toContain(cart.id);
    const ev = await owner.query<{ topic: string }>(
      `SELECT topic FROM outbox WHERE aggregate_id::text = $1::text`,
      [cart.id],
    );
    expect(ev.rows.map((e) => e.topic)).toEqual(['cart.abandoned']);
  });
});
