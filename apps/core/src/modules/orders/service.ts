// Order state machine (issue #105). ONE way to mutate an order's status fields: `transition()` — locks the row,
// validates every requested field against transitions.ts, applies the change, writes exactly one event
// (order.confirmed / order.cancelled / order.completed for `status`, order.updated otherwise), all in the
// caller's transaction. The public wrappers below are what windows 7 (payments) and 8 (shipping) call: scoped
// client + ids, never provider objects; each one is idempotent on its target state (a webhook retry is not a 409).
// Cancelling voids an authorised payment through the checkout's PaymentProvider (`void`, no-op for `manual`).
import type { Queryable, ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError, conflict, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { paymentProvider } from '../../lib/payment-seam';
import { releaseForOrder } from '../inventory';
import { loadOrder, loadOrderLines, renderAdminOrder } from './read-model';
import { allowed } from './transitions';
import type {
  AdminOrder,
  FulfillmentStatus,
  LineQuantity,
  OrderRow,
  PaymentStatus,
  StatusField,
  TransitionChange,
} from './types';

const FIELDS: readonly StatusField[] = ['status', 'payment_status', 'fulfillment_status'];

function totalsOf(o: OrderRow) {
  return {
    subtotal_minor: Number(o.subtotal_minor),
    discount_minor: Number(o.discount_minor),
    shipping_minor: Number(o.shipping_minor),
    tax_minor: Number(o.tax_minor),
    total_minor: Number(o.total_minor),
  };
}

/**
 * The single mutation path. Illegal → 409 `conflict` with `{ field, from, to }`; a change that names no status
 * field must carry `changed_fields` (an order edit) and emits `order.updated`. Returns the updated row.
 */
export async function transition(
  tx: Queryable,
  orderId: string,
  change: TransitionChange,
): Promise<OrderRow> {
  const before = await loadOrder(tx, orderId, true);
  const sets: string[] = [];
  const params: unknown[] = [orderId];
  const changed: string[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  for (const field of FIELDS) {
    const to = change[field];
    if (to === undefined) continue;
    const from = before[field];
    if (!allowed(field, from, to)) {
      throw conflict(`order ${field} cannot go from ${from} to ${to}`, { field, from, to });
    }
    set(field, to);
    changed.push(field);
  }
  const now = change.occurredAt ?? new Date();
  if (change.status === 'cancelled') {
    set('cancelled_at', now);
    set('cancel_reason', change.reason ?? null);
    changed.push('cancelled_at', 'cancel_reason');
  }
  if (change.status === 'completed') {
    set('completed_at', now);
    changed.push('completed_at');
  }
  const extra = change.changed_fields ?? [];
  if (changed.length === 0 && extra.length === 0) {
    throw validationError('transition changes nothing', {
      change: 'no status field, no changed_fields',
    });
  }
  if (sets.length > 0) {
    await tx.query(
      `UPDATE "order" SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
      params,
    );
  }
  if (change.hooks?.afterUpdate) await change.hooks.afterUpdate(tx);
  const after = await loadOrder(tx, orderId, false);

  const base = {
    organizationId: after.organization_id,
    storeId: after.store_id,
    aggregateType: 'order' as const,
    aggregateId: after.id,
    actor: eventActor(change.actor),
    occurredAt: now,
  };
  const displayId = Number(after.display_id);
  let event;
  if (change.status === 'confirmed') {
    event = await buildEvent({
      ...base,
      topic: 'order.confirmed',
      payload: { order_id: after.id, display_id: displayId, confirmed_at: now.toISOString() },
    });
  } else if (change.status === 'completed') {
    event = await buildEvent({
      ...base,
      topic: 'order.completed',
      payload: { order_id: after.id, display_id: displayId, completed_at: now.toISOString() },
    });
  } else if (change.status === 'cancelled') {
    const legal = await tx.query<{ legal_entity_id: string }>(
      `SELECT legal_entity_id FROM store WHERE id = $1`,
      [after.store_id],
    );
    event = await buildEvent({
      ...base,
      topic: 'order.cancelled',
      payload: {
        order_id: after.id,
        display_id: displayId,
        legal_entity_id: legal.rows[0]!.legal_entity_id,
        currency: after.currency,
        totals: totalsOf(after),
        reason: after.cancel_reason,
        cancelled_at: now.toISOString(),
      },
    });
  } else {
    event = await buildEvent({
      ...base,
      topic: 'order.updated',
      payload: {
        order_id: after.id,
        display_id: displayId,
        status: after.status,
        payment_status: after.payment_status,
        fulfillment_status: after.fulfillment_status,
        changed_fields: [...new Set([...changed, ...extra])].sort(),
      },
    });
  }
  await withEvents(tx, [event]);
  if (change.hooks?.afterEvents) await change.hooks.afterEvents(tx);
  return after;
}

// ---- wrappers (windows 7 and 8; idempotent on the target state) ----

/** One status move on the caller's transaction, idempotent on the target (window 8's INSERT INTO shipment holds FOR KEY SHARE on the order row: a marker must run on that transaction). */
async function moveFieldInTx(
  tx: Queryable,
  orderId: string,
  field: StatusField,
  to: OrderRow[StatusField],
  actor: Actor,
  extra: Partial<TransitionChange> = {},
): Promise<void> {
  // The idempotency read happens under the row lock: a concurrent change cannot slip between the check and
  // the transition (which re-locks the same row in this transaction) — #174 review.
  const current = await loadOrder(tx, orderId, true);
  if (current[field] !== to) {
    await transition(tx, orderId, { [field]: to, actor, ...extra } as TransitionChange);
  }
}

async function moveField(
  client: ScopedClient,
  orderId: string,
  field: StatusField,
  to: OrderRow[StatusField],
  actor: Actor,
  extra: Partial<TransitionChange> = {},
): Promise<AdminOrder> {
  return client.transaction(async (tx) => {
    await moveFieldInTx(tx, orderId, field, to, actor, extra);
    return renderAdminOrder(tx, orderId);
  });
}

/** `pending → confirmed` (operator, or window 7 on capture). */
export const confirmOrder = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'status', 'confirmed', actor);

export const markPaymentAuthorized = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'payment_status', 'authorized', actor);
export const markPaymentCaptured = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'payment_status', 'captured', actor);
/** Payment failure changes only `payment_status`; cancelling stays an explicit call. */
export const markPaymentFailed = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'payment_status', 'failed', actor);
export const markPaymentPartiallyRefunded = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'payment_status', 'partially_refunded', actor);
export const markPaymentRefunded = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'payment_status', 'refunded', actor);

/** Window 8: a shipment exists for the order → `confirmed → processing`. */
export const markShipmentCreated = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'status', 'processing', actor);


// ---- tx-taking twins (window 8, #191): same semantics on the caller's transaction ----
export const confirmOrderInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'status', 'confirmed', actor);
export const markPaymentAuthorizedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'payment_status', 'authorized', actor);
export const markPaymentCapturedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'payment_status', 'captured', actor);
export const markPaymentFailedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'payment_status', 'failed', actor);
export const markPaymentPartiallyRefundedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'payment_status', 'partially_refunded', actor);
export const markPaymentRefundedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'payment_status', 'refunded', actor);
export const markShipmentCreatedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'status', 'processing', actor);

function fulfillmentFrom(
  lines: { quantity: number; fulfilled_quantity: number; returned_quantity: number }[],
  kind: 'fulfilled' | 'returned',
): FulfillmentStatus {
  const total = lines.reduce((n, l) => n + l.quantity, 0);
  const done = lines.reduce(
    (n, l) => n + (kind === 'fulfilled' ? l.fulfilled_quantity : l.returned_quantity),
    0,
  );
  if (kind === 'fulfilled') return done >= total ? 'fulfilled' : 'partially_fulfilled';
  return done >= total ? 'returned' : 'partially_returned';
}

/**
 * Window 8: quantities shipped per line → `order_line_item.fulfilled_quantity` (capped at the line quantity) and
 * `fulfillment_status` partially_fulfilled | fulfilled. Nothing to ship → 400.
 */
export async function markShipped(
  client: ScopedClient,
  orderId: string,
  shipped: readonly LineQuantity[],
  actor: Actor,
): Promise<AdminOrder> {
  return client.transaction(async (tx) => {
    await markShippedInTx(tx, orderId, shipped, actor);
    return renderAdminOrder(tx, orderId);
  });
}

/** `markShipped` on the caller's transaction (window 8, #191). */
export async function markShippedInTx(
  tx: Queryable,
  orderId: string,
  shipped: readonly LineQuantity[],
  actor: Actor,
): Promise<void> {
  if (shipped.length === 0) throw validationError('nothing shipped', { shipped: 'at least one line' });
  await loadOrder(tx, orderId, true);
  for (const s of shipped) {
    const r = await tx.query(
      `UPDATE order_line_item SET fulfilled_quantity = LEAST(quantity, fulfilled_quantity + $3), updated_at = now()
       WHERE id = $1 AND order_id = $2`,
      [s.lineItemId, orderId, s.quantity],
    );
    if (r.rowCount === 0)
      throw validationError('unknown line item', { line_item_id: s.lineItemId });
  }
  const lines = await loadOrderLines(tx, orderId);
  const next = fulfillmentFrom(lines, 'fulfilled');
  const current = await loadOrder(tx, orderId, false);
  if (current.fulfillment_status !== next) {
    await transition(tx, orderId, {
      fulfillment_status: next,
      actor,
      changed_fields: ['line_items'],
    });
  }
}

/** Window 8: delivered → `processing → completed` (requires the order to be fulfilled). */
export async function markDelivered(
  client: ScopedClient,
  orderId: string,
  actor: Actor,
): Promise<AdminOrder> {
  return client.transaction(async (tx) => {
    await markDeliveredInTx(tx, orderId, actor);
    return renderAdminOrder(tx, orderId);
  });
}

/** `markDelivered` on the caller's transaction (window 8, #191). */
export async function markDeliveredInTx(tx: Queryable, orderId: string, actor: Actor): Promise<void> {
  const o = await loadOrder(tx, orderId, true);
  if (o.status === 'completed') return;
  if (o.fulfillment_status !== 'fulfilled') {
    throw conflict('order is not fully fulfilled', {
      field: 'fulfillment_status',
      from: o.fulfillment_status,
      to: 'fulfilled',
    });
  }
  await transition(tx, orderId, { status: 'completed', actor });
}

/** Task 2.5 (returns): quantities received back per line → `returned_quantity` and partially_returned | returned. */
export async function markReturned(
  client: ScopedClient,
  orderId: string,
  returned: readonly LineQuantity[],
  actor: Actor,
): Promise<AdminOrder> {
  return client.transaction(async (tx) => {
    await markReturnedIn(tx, orderId, returned, actor);
    return renderAdminOrder(tx, orderId);
  });
}

/** `markReturned` on the caller's transaction (the returns module runs it inside receiveReturn). */
export async function markReturnedIn(
  tx: Queryable,
  orderId: string,
  returned: readonly LineQuantity[],
  actor: Actor,
): Promise<void> {
  if (returned.length === 0)
    throw validationError('nothing returned', { returned: 'at least one line' });
  await loadOrder(tx, orderId, true);
  for (const s of returned) {
    const r = await tx.query(
      `UPDATE order_line_item SET returned_quantity = LEAST(fulfilled_quantity, returned_quantity + $3), updated_at = now()
       WHERE id = $1 AND order_id = $2`,
      [s.lineItemId, orderId, s.quantity],
    );
    if (r.rowCount === 0)
      throw validationError('unknown line item', { line_item_id: s.lineItemId });
  }
  const lines = await loadOrderLines(tx, orderId);
  const next = fulfillmentFrom(lines, 'returned');
  const current = await loadOrder(tx, orderId, false);
  if (current.fulfillment_status !== next) {
    await transition(tx, orderId, {
      fulfillment_status: next,
      actor,
      changed_fields: ['line_items'],
    });
  }
}

/**
 * Window 8's port (#191): apply a fulfilment status derived from live shipments, on shipping's transaction.
 * Idempotent on the target; illegal per the table → 409 (shipping only asks for unfulfilled | partially_fulfilled |
 * fulfilled and leaves the return states alone).
 */
export async function setFulfillmentStatusIn(
  tx: Queryable,
  orderId: string,
  status: FulfillmentStatus,
  actor: Actor,
): Promise<void> {
  const current = await loadOrder(tx, orderId, true);
  if (current.fulfillment_status !== status) {
    await transition(tx, orderId, { fulfillment_status: status, actor });
  }
}

/** Merges keys into `order.metadata` on the caller's transaction (the returns module's exchange link). No event: metadata is storefront/ops-owned. */
export async function mergeOrderMetadataIn(
  tx: Queryable,
  orderId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const o = await loadOrder(tx, orderId, true);
  await tx.query(`UPDATE "order" SET metadata = $2::jsonb, updated_at = now() WHERE id = $1`, [
    orderId,
    JSON.stringify({ ...o.metadata, ...patch }),
  ]);
}

/** Alias of `markReturnedIn` in the `…InTx` naming window 8 uses. */
export const markReturnedInTx = markReturnedIn;

/** A payment_status move on the caller's transaction, idempotent on the target (the returns module's refunds). */
export async function movePaymentStatusIn(
  tx: Queryable,
  orderId: string,
  to: PaymentStatus,
  actor: Actor,
): Promise<void> {
  const current = await loadOrder(tx, orderId, true);
  if (current.payment_status !== to) await transition(tx, orderId, { payment_status: to, actor });
}

interface AuthorizedPayment {
  id: string;
  provider: string;
  provider_payment_id: string | null;
  idempotency_key: string;
}

/**
 * `POST /admin/stores/{storeId}/orders/{orderId}/cancel` and the module call: allowed only while nothing has
 * shipped (`fulfillment_status = unfulfilled`) and from pending | confirmed | processing (409 otherwise). An
 * authorised (not captured) payment is voided through its PaymentProvider (`manual` → no-op) and marked
 * `cancelled` on the payment row; a captured payment is window 7's to refund on `order.cancelled`. Reservations
 * release in task 2.4 through the inventory public API. Idempotent: an already-cancelled order is returned as is.
 */
export async function cancelOrder(
  client: ScopedClient,
  orderId: string,
  input: { reason: string; actor: Actor },
): Promise<AdminOrder> {
  return client.transaction(async (tx) => {
    await cancelOrderInTx(tx, orderId, input);
    return renderAdminOrder(tx, orderId);
  });
}

/** `cancelOrder` on the caller's transaction (window 8, #191). */
export async function cancelOrderInTx(
  tx: Queryable,
  orderId: string,
  input: { reason: string; actor: Actor },
): Promise<void> {
  const o = await loadOrder(tx, orderId, true);
  if (o.status === 'cancelled') return;
  if (o.fulfillment_status !== 'unfulfilled') {
    throw conflict('order has shipped; cancel is no longer possible (use a return)', {
      field: 'fulfillment_status',
      from: o.fulfillment_status,
      to: 'unfulfilled',
    });
  }
  const payments = await tx.query<AuthorizedPayment>(
    `SELECT id, provider, provider_payment_id, idempotency_key FROM payment
     WHERE order_id = $1 AND status = 'authorized' ORDER BY created_at`,
    [orderId],
  );
  for (const p of payments.rows) {
    const provider = paymentProvider(p.provider);
    if (!provider) {
      throw new AppError(
        'internal',
        `payment provider ${p.provider} is not registered`,
        undefined,
        503,
      );
    }
    if (p.provider_payment_id) {
      const result = await provider.void({
        tx,
        organizationId: o.organization_id,
        storeId: o.store_id,
        providerPaymentId: p.provider_payment_id,
        idempotencyKey: `${p.idempotency_key}:void`,
        reason: input.reason,
      });
      if (result.status !== 'voided') {
        throw new AppError(
          'payment_failed',
          result.failureReason ?? 'payment could not be voided',
          {
            provider: p.provider,
          },
        );
      }
    }
    await tx.query(`UPDATE payment SET status = 'cancelled', updated_at = now() WHERE id = $1`, [
      p.id,
    ]);
  }
  // Reservations are released here, through the orders module's own cancel — never from window 8's side.
  await releaseForOrder(tx, orderId);
  await transition(tx, orderId, {
    status: 'cancelled',
    reason: input.reason,
    actor: input.actor,
  });
}

export type { PaymentStatus };
