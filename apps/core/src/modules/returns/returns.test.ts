// Returns module (issue #107) on a fully seeded throwaway database: request within/over the shipped quantities,
// receiving (order returned quantities, restock of resellable goods through the inventory API, return.received),
// the refund seam (called once, idempotent per return, amount rule, captured-only, failed/pending paths), rollback,
// replay of both projections, RLS, exchange link.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import { completeCart, createPaymentSession } from '../checkout';
import {
  confirmOrder,
  markPaymentCaptured,
  markShipmentCreated,
  markShipped,
  projectOrder,
} from '../orders';
import {
  linkExchange,
  manualRefundRequester,
  markReturnRefunded,
  projectReturn,
  receiveReturn,
  refundAmountFor,
  requestReturn,
  RETURN_TRANSITIONS,
  setRefundRequester,
  type RefundRequest,
  type RefundRequester,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const EU = SEED_IDS.warehouses.eu;
const actor = { id: null, type: 'system' as const, requestId: 'req-returns' };
const customer = { id: null, type: 'customer' as const, requestId: 'req-returns' };
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
  db = await createTestDatabase('core_returns');
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
  setRefundRequester(manualRefundRequester);
});

/** A placed, confirmed, captured brand-a order with `lines` lines of quantity 3, fully shipped unless told otherwise. */
async function shippedOrder(lines = 1, ship: 'all' | 'none' | 'partial' = 'all') {
  const i = n++;
  const cart = await createCart(a, scopeA);
  for (let k = 0; k < lines; k++) {
    await addLineItem(a, cart.id, {
      variant_id: variants[(i * 2 + k) % variants.length]!,
      quantity: 3,
    });
  }
  await updateCart(a, cart.id, {
    email: `returns+${i}@example.com`,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: standardOptionId,
  });
  await createPaymentSession(a, cart.id, { provider: 'manual' });
  const { order } = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `returns-${cart.id}`,
    actor: customer,
  });
  await confirmOrder(a, order.id, actor);
  await markPaymentCaptured(a, order.id, actor);
  // the payment row itself is window 7's to capture; mirror it so the refund has a captured payment to go against
  await owner.query(
    `UPDATE payment SET status = 'captured', captured_at = now() WHERE order_id = $1`,
    [order.id],
  );
  await markShipmentCreated(a, order.id, actor);
  if (ship !== 'none') {
    const shipped = await markShipped(
      a,
      order.id,
      order.items.map((l, idx) => ({
        lineItemId: l.id,
        quantity: ship === 'partial' && idx === 0 ? 1 : 3,
      })),
      actor,
    );
    return shipped;
  }
  return order;
}

const stream = async (aggregateId: string, prefix: string) =>
  (
    await owner.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM outbox WHERE topic LIKE $2 AND aggregate_id::text = $1::text ORDER BY occurred_at, id`,
      [aggregateId, `${prefix}%`],
    )
  ).rows;

const levelOf = async (variantId: string) =>
  (
    await owner.query<{ on_hand: number }>(
      `SELECT on_hand FROM inventory_level WHERE variant_id = $1 AND warehouse_id = $2`,
      [variantId, EU],
    )
  ).rows[0]!.on_hand;

/** What window 7's requester does on success: write its refund row (return.refund_id references it) and return the id. */
async function insertRefundRow(
  tx: { query: (text: string, params?: unknown[]) => Promise<{ rows: { id: string }[] }> },
  input: Pick<
    RefundRequest,
    | 'organizationId'
    | 'storeId'
    | 'orderId'
    | 'returnId'
    | 'paymentId'
    | 'amountMinor'
    | 'currency'
    | 'idempotencyKey'
  >,
  status: 'succeeded' | 'pending' = 'succeeded',
): Promise<string> {
  const r = await tx.query(
    `INSERT INTO refund (organization_id, store_id, order_id, payment_id, return_id, amount_minor, currency, reason, status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'return', $8, $9) RETURNING id`,
    [
      input.organizationId,
      input.storeId,
      input.orderId,
      input.paymentId,
      input.returnId,
      input.amountMinor,
      input.currency,
      status,
      input.idempotencyKey,
    ],
  );
  return r.rows[0]!.id;
}

/** return_item rows of one request share created_at; compare item lists sorted by line id. */
const byLine = <T extends { order_line_item_id: string }>(items: readonly T[]): T[] =>
  [...items].sort((x, y) => x.order_line_item_id.localeCompare(y.order_line_item_id));

function countingRequester(outcome: 'succeeded' | 'failed' | 'pending' = 'succeeded') {
  const calls: RefundRequest[] = [];
  const requester: RefundRequester = {
    async request(input) {
      calls.push(input);
      if (outcome === 'succeeded') {
        return { status: 'succeeded', refundId: await insertRefundRow(input.tx, input) };
      }
      return outcome === 'failed'
        ? { status: 'failed', refundId: null, failureReason: 'PSP down' }
        : { status: 'pending', refundId: null };
    },
  };
  return { requester, calls };
}

describe('requestReturn', () => {
  it('within the shipped quantity → requested + return.requested; over it → 409; unshipped order → 409', async () => {
    expect(RETURN_TRANSITIONS.refunded).toEqual([]);
    const order = await shippedOrder(2, 'partial'); // one line shipped 1 of 3, the other 3 of 3
    const l0 = order.items.find((l) => l.fulfilled_quantity === 1)!;
    const l1 = order.items.find((l) => l.fulfilled_quantity === 3)!;
    await expect(
      requestReturn(a, order.id, { items: [{ order_line_item_id: l0!.id, quantity: 2 }], actor }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { order_line_item_id: l0!.id, requested: 2, returnable: 1 },
    });
    const ret = await requestReturn(a, order.id, {
      items: [
        { order_line_item_id: l0!.id, quantity: 1 },
        { order_line_item_id: l1!.id, quantity: 2 },
      ],
      reason: 'wrong size',
      actor,
    });
    expect(ret).toMatchObject({
      order_id: order.id,
      status: 'requested',
      reason: 'wrong size',
      warehouse_id: null,
      refund_id: null,
      received_at: null,
    });
    expect(byLine(ret.items)).toEqual(
      byLine([
        { order_line_item_id: l0!.id, quantity: 1, condition: null },
        { order_line_item_id: l1!.id, quantity: 2, condition: null },
      ]),
    );
    const events = await stream(ret.id, 'return.');
    expect(events.map((e) => e.topic)).toEqual(['return.requested']);
    expect(events[0]!.payload).toMatchObject({
      return_id: ret.id,
      order_id: order.id,
      reason: 'wrong size',
    });
    // the open request counts against what is still returnable
    await expect(
      requestReturn(a, order.id, { items: [{ order_line_item_id: l1!.id, quantity: 2 }], actor }),
    ).rejects.toMatchObject({ code: 'conflict', details: { returnable: 1 } });
    await expect(
      requestReturn(a, order.id, { items: [{ order_line_item_id: order.id, quantity: 1 }], actor }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const unshipped = await shippedOrder(1, 'none');
    await expect(
      requestReturn(a, unshipped.id, {
        items: [{ order_line_item_id: unshipped.items[0]!.id, quantity: 1 }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'conflict', details: { field: 'fulfillment_status' } });
  });
});

describe('receiveReturn', () => {
  it('updates returned quantities + fulfillment_status, restocks resellable goods only, emits return.received, refunds once', async () => {
    const { requester, calls } = countingRequester();
    setRefundRequester(requester);
    const order = await shippedOrder(2);
    const [l0, l1] = order.items;
    const v0 = l0!.variant_id!;
    const v1 = l1!.variant_id!;
    const onHand0 = await levelOf(v0);
    const onHand1 = await levelOf(v1);
    const ret = await requestReturn(a, order.id, {
      items: [
        { order_line_item_id: l0!.id, quantity: 2 },
        { order_line_item_id: l1!.id, quantity: 3 },
      ],
      actor,
    });
    const received = await receiveReturn(a, ret.id, {
      warehouseId: EU,
      items: [
        { order_line_item_id: l0!.id, quantity: 2, condition: 'resellable' },
        { order_line_item_id: l1!.id, quantity: 1, condition: 'damaged' }, // 2 of the 3 never came back
      ],
      actor,
    });
    expect(received).toMatchObject({ status: 'refunded', warehouse_id: EU });
    expect(received.refund_id).toBeTruthy();
    const refundRow = await owner.query<{ return_id: string; status: string }>(
      `SELECT return_id, status FROM refund WHERE id = $1`,
      [received.refund_id],
    );
    expect(refundRow.rows[0]).toEqual({ return_id: ret.id, status: 'succeeded' });
    expect(received.received_at).toBeTruthy();
    expect(byLine(received.items)).toEqual(
      byLine([
        { order_line_item_id: l0!.id, quantity: 2, condition: 'resellable' },
        { order_line_item_id: l1!.id, quantity: 1, condition: 'damaged' },
      ]),
    );
    // order side
    const lines = await owner.query<{ id: string; returned_quantity: number }>(
      `SELECT id, returned_quantity FROM order_line_item WHERE order_id = $1`,
      [order.id],
    );
    const returnedBy = new Map(lines.rows.map((l) => [l.id, l.returned_quantity]));
    expect(returnedBy.get(l0!.id)).toBe(2);
    expect(returnedBy.get(l1!.id)).toBe(1);
    const o = await owner.query<{ fulfillment_status: string; payment_status: string }>(
      `SELECT fulfillment_status, payment_status FROM "order" WHERE id = $1`,
      [order.id],
    );
    expect(o.rows[0]).toEqual({
      fulfillment_status: 'partially_returned',
      payment_status: 'partially_refunded',
    });
    // stock: resellable restocked, damaged not
    expect(await levelOf(v0)).toBe(onHand0 + 2);
    expect(await levelOf(v1)).toBe(onHand1);
    const movements = await owner.query<{ delta: number; reason: string; reference_id: string }>(
      `SELECT delta, reason, reference_id FROM stock_movement WHERE reference_type = 'return' AND reference_id = $1`,
      [ret.id],
    );
    expect(movements.rows).toEqual([{ delta: 2, reason: 'return', reference_id: ret.id }]);
    // events: return.requested, return.received (this module) + one stock.moved (inventory) + order.updated ×2 (orders)
    expect((await stream(ret.id, 'return.')).map((e) => e.topic)).toEqual([
      'return.requested',
      'return.received',
    ]);
    const receivedEvent = (await stream(ret.id, 'return.received'))[0]!.payload;
    expect(receivedEvent).toMatchObject({
      return_id: ret.id,
      order_id: order.id,
      warehouse_id: EU,
    });
    expect(byLine(receivedEvent.items as typeof received.items)).toEqual(byLine(received.items));
    // refund seam: once, with the amount rule (shares of the line totals, shipping excluded), keyed per return
    expect(calls).toHaveLength(1);
    const expected = refundAmountFor(
      [
        { id: l0!.id, quantity: 3, total_minor: String(l0!.total.amount_minor) },
        { id: l1!.id, quantity: 3, total_minor: String(l1!.total.amount_minor) },
      ],
      [
        { order_line_item_id: l0!.id, quantity: 2 },
        { order_line_item_id: l1!.id, quantity: 1 },
      ],
    );
    expect(expected).toBe(
      Math.floor((l0!.total.amount_minor * 2) / 3) + Math.floor(l1!.total.amount_minor / 3),
    );
    expect(calls[0]).toMatchObject({
      orderId: order.id,
      returnId: ret.id,
      amountMinor: expected,
      currency: 'EUR',
      reason: 'return',
      idempotencyKey: `return:${ret.id}`,
      provider: 'manual',
    });
    // receiving again is a 409 (received → received is not a transition) and does not ask the seam again
    await expect(
      receiveReturn(a, ret.id, {
        warehouseId: EU,
        items: [{ order_line_item_id: l0!.id, quantity: 1, condition: 'resellable' }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(calls).toHaveLength(1);
    // replay: both projections reproduce the rows
    const r = await owner.query<{ status: string; warehouse_id: string; items: number }>(
      `SELECT r.status, r.warehouse_id, (SELECT count(*) FROM return_item ri WHERE ri.return_id = r.id)::int AS items FROM "return" r WHERE r.id = $1`,
      [ret.id],
    );
    const projected = projectReturn(await stream(ret.id, 'return.'))!;
    expect(projected).toMatchObject({ status: 'received', warehouse_id: EU }); // refunded needs window 7's refund.issued
    expect(projected.items).toHaveLength(r.rows[0]!.items);
    const orderProjection = projectOrder(await stream(order.id, 'order.'))!;
    expect(orderProjection).toMatchObject({
      fulfillment_status: 'partially_returned',
      payment_status: 'partially_refunded',
    });
  });

  it('a full return of a captured order refunds the whole amount → payment_status refunded, fulfillment returned', async () => {
    const order = await shippedOrder(1);
    const l = order.items[0]!;
    const ret = await requestReturn(a, order.id, {
      items: [{ order_line_item_id: l.id, quantity: 3 }],
      actor,
    });
    // manual default requester: provider refund succeeds, no refund id
    const received = await receiveReturn(a, ret.id, {
      warehouseId: EU,
      items: [{ order_line_item_id: l.id, quantity: 3, condition: 'resellable' }],
      actor,
    });
    expect(received).toMatchObject({ status: 'refunded', refund_id: null });
    const o = await owner.query<{
      fulfillment_status: string;
      payment_status: string;
      metadata: Record<string, unknown>;
    }>(`SELECT fulfillment_status, payment_status, metadata FROM "order" WHERE id = $1`, [
      order.id,
    ]);
    expect(o.rows[0]).toMatchObject({ fulfillment_status: 'returned' });
    // the line total is the whole captured amount minus shipping → partial by the amount rule
    const total = order.totals.total.amount_minor;
    const lineTotal = l.total.amount_minor;
    expect(o.rows[0]!.payment_status).toBe(lineTotal >= total ? 'refunded' : 'partially_refunded');
    const rr = await owner.query<{ metadata: { refund: Record<string, unknown> } }>(
      `SELECT metadata FROM "return" WHERE id = $1`,
      [ret.id],
    );
    expect(rr.rows[0]!.metadata.refund).toMatchObject({
      status: 'succeeded',
      amount_minor: lineTotal,
      currency: 'EUR',
      refund_id: null,
    });
  });

  it('failed and pending outcomes leave the return received; markReturnRefunded finishes a pending one; retries never refund twice', async () => {
    const failed = countingRequester('failed');
    setRefundRequester(failed.requester);
    const order = await shippedOrder(1);
    const l = order.items[0]!;
    const ret = await requestReturn(a, order.id, {
      items: [{ order_line_item_id: l.id, quantity: 1 }],
      actor,
    });
    const r1 = await receiveReturn(a, ret.id, {
      warehouseId: EU,
      items: [{ order_line_item_id: l.id, quantity: 1, condition: 'damaged' }],
      actor,
    });
    expect(r1.status).toBe('received');
    const meta = await owner.query<{ metadata: { refund: Record<string, unknown> } }>(
      `SELECT metadata FROM "return" WHERE id = $1`,
      [ret.id],
    );
    expect(meta.rows[0]!.metadata.refund).toMatchObject({
      status: 'failed',
      failure_reason: 'PSP down',
    });

    const pending = countingRequester('pending');
    setRefundRequester(pending.requester);
    const order2 = await shippedOrder(1);
    const l2 = order2.items[0]!;
    const ret2 = await requestReturn(a, order2.id, {
      items: [{ order_line_item_id: l2.id, quantity: 2 }],
      actor,
    });
    const r2 = await receiveReturn(a, ret2.id, {
      warehouseId: EU,
      items: [{ order_line_item_id: l2.id, quantity: 2, condition: 'resellable' }],
      actor,
    });
    expect(r2.status).toBe('received');
    expect(pending.calls).toHaveLength(1);
    // window 7's webhook settles it: its refund row exists by then, and it hands the id over
    const settledId = await insertRefundRow(owner, pending.calls[0]!, 'succeeded');
    const done = await markReturnRefunded(a, ret2.id, settledId, actor);
    expect(done).toMatchObject({ status: 'refunded', refund_id: settledId });
    const o2 = await owner.query<{ payment_status: string }>(
      `SELECT payment_status FROM "order" WHERE id = $1`,
      [order2.id],
    );
    expect(o2.rows[0]!.payment_status).toBe('partially_refunded');
    await markReturnRefunded(a, ret2.id, 'ignored', actor); // idempotent
    expect(pending.calls).toHaveLength(1);
  });

  it('no captured payment → 409 and nothing is written; a failure after return.received rolls everything back', async () => {
    const order = await shippedOrder(1);
    await owner.query(
      `UPDATE payment SET status = 'authorized', captured_at = NULL WHERE order_id = $1`,
      [order.id],
    );
    const l = order.items[0]!;
    const v = l.variant_id!;
    const onHand = await levelOf(v);
    const ret = await requestReturn(a, order.id, {
      items: [{ order_line_item_id: l.id, quantity: 1 }],
      actor,
    });
    const before = await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox`);
    await expect(
      receiveReturn(a, ret.id, {
        warehouseId: EU,
        items: [{ order_line_item_id: l.id, quantity: 1, condition: 'resellable' }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'conflict', message: /capture first/ });
    // nothing of the receive survived
    const status = await owner.query<{ status: string }>(
      `SELECT status FROM "return" WHERE id = $1`,
      [ret.id],
    );
    expect(status.rows[0]!.status).toBe('requested');
    expect(await levelOf(v)).toBe(onHand);
    expect(
      (await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox`)).rows[0]!.n,
    ).toBe(before.rows[0]!.n);
    const rq = await owner.query<{ returned_quantity: number }>(
      `SELECT returned_quantity FROM order_line_item WHERE id = $1`,
      [l.id],
    );
    expect(rq.rows[0]!.returned_quantity).toBe(0);

    // hook-injected failure after the outbox insert: same result
    await owner.query(
      `UPDATE payment SET status = 'captured', captured_at = now() WHERE order_id = $1`,
      [order.id],
    );
    await expect(
      receiveReturn(a, ret.id, {
        warehouseId: EU,
        items: [{ order_line_item_id: l.id, quantity: 1, condition: 'resellable' }],
        actor,
        hooks: { afterEvents: async () => Promise.reject(new Error('boom after events')) },
      }),
    ).rejects.toThrow('boom after events');
    expect(
      (await owner.query<{ status: string }>(`SELECT status FROM "return" WHERE id = $1`, [ret.id]))
        .rows[0]!.status,
    ).toBe('requested');
    expect(await levelOf(v)).toBe(onHand);
    expect(
      (await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox`)).rows[0]!.n,
    ).toBe(before.rows[0]!.n);
  });
});

describe('RLS and exchange', () => {
  it('store B cannot see or receive store A returns; an exchange links both orders', async () => {
    const order = await shippedOrder(1);
    const l = order.items[0]!;
    const ret = await requestReturn(a, order.id, {
      items: [{ order_line_item_id: l.id, quantity: 1 }],
      actor,
    });
    await expect(
      requestReturn(b, order.id, { items: [{ order_line_item_id: l.id, quantity: 1 }], actor }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      receiveReturn(b, ret.id, {
        warehouseId: EU,
        items: [{ order_line_item_id: l.id, quantity: 1, condition: 'resellable' }],
        actor,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const replacement = await shippedOrder(1, 'none');
    await expect(linkExchange(a, ret.id, order.id)).rejects.toMatchObject({
      code: 'validation_error',
    });
    await linkExchange(a, ret.id, replacement.id);
    const rr = await owner.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "return" WHERE id = $1`,
      [ret.id],
    );
    expect(rr.rows[0]!.metadata).toMatchObject({ exchange: { order_id: replacement.id } });
    const oo = await owner.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "order" WHERE id = $1`,
      [replacement.id],
    );
    expect(oo.rows[0]!.metadata).toMatchObject({
      exchange_for: { return_id: ret.id, order_id: order.id },
    });
  });
});
