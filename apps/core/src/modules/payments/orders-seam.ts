// LOCAL MIRROR of the orders module's payment-status wrappers (window 1, core 2.3, PR #174 — not on main yet).
// Same signatures and semantics: scoped client + ids, own transaction, idempotent on the target state, exactly
// one `order.updated` event, illegal transition → 409 with `{ field, from, to }`. When #174 lands on main this
// file's body becomes a re-export and nothing else changes:
//
//   export { markPaymentCaptured, markPaymentFailed } from '../orders';
//
import type { LatestPayloads } from '@platform/events';
import type { Queryable, ScopedClient } from '@platform/db';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import type { Actor } from '../../lib/audit';
import { conflict, notFound } from '../../lib/errors';

// PAYMENT_TRANSITIONS from PR #174's `orders/transitions.ts`, verbatim.
const PAYMENT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  awaiting: ['authorized', 'failed'],
  authorized: ['captured', 'failed'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  refunded: [],
  failed: ['authorized'],
};

type OrderUpdated = LatestPayloads['order.updated'];
type PaymentStatus = OrderUpdated['payment_status'];

interface OrderStatusRow {
  id: string;
  display_id: string;
  status: OrderUpdated['status'];
  payment_status: PaymentStatus;
  fulfillment_status: OrderUpdated['fulfillment_status'];
  organization_id: string;
  store_id: string;
}

async function movePaymentStatus(
  client: ScopedClient,
  orderId: string,
  to: PaymentStatus,
  actor: Actor,
): Promise<void> {
  await client.transaction(async (tx: Queryable) => {
    const r = await tx.query<OrderStatusRow>(
      `SELECT id, display_id::text, status, payment_status, fulfillment_status, organization_id, store_id
       FROM "order" WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = r.rows[0];
    if (!order) throw notFound('order', orderId);
    if (order.payment_status === to) return; // idempotent on the target state
    if (!(PAYMENT_TRANSITIONS[order.payment_status] ?? []).includes(to)) {
      throw conflict(`order payment_status cannot go from ${order.payment_status} to ${to}`, {
        field: 'payment_status',
        from: order.payment_status,
        to,
      });
    }
    await tx.query(`UPDATE "order" SET payment_status = $2, updated_at = now() WHERE id = $1`, [
      orderId,
      to,
    ]);
    await withEvents(tx, [
      await buildEvent({
        topic: 'order.updated',
        organizationId: order.organization_id,
        storeId: order.store_id,
        aggregateType: 'order',
        aggregateId: order.id,
        actor: eventActor(actor),
        payload: {
          order_id: order.id,
          display_id: Number(order.display_id),
          status: order.status,
          payment_status: to,
          fulfillment_status: order.fulfillment_status,
          changed_fields: ['payment_status'],
        },
      }),
    ]);
  });
}

export const markPaymentCaptured = (client: ScopedClient, orderId: string, actor: Actor) =>
  movePaymentStatus(client, orderId, 'captured', actor);

export const markPaymentFailed = (client: ScopedClient, orderId: string, actor: Actor) =>
  movePaymentStatus(client, orderId, 'failed', actor);
