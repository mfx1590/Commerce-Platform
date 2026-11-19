// Order state machine (issue #105). ONE way to mutate an order's status fields: `transition()` — locks the row,
// validates every requested field against transitions.ts, applies the change, writes exactly one event
// (order.confirmed / order.cancelled / order.completed for `status`, order.updated otherwise), all in the
// caller's transaction. The public wrappers below are what windows 7 (payments) and 8 (shipping) call: scoped
// client + ids, never provider objects; each one is idempotent on its target state (a webhook retry is not a 409).
// Cancelling voids an authorised payment through the checkout's PaymentProvider (`void`, no-op for `manual`).
//
// The `status` lifecycle is AUTOMATIC (#350, contracts 0.4.11): `confirmed` when the payment is authorised
// (`confirmOnAuthorizationInTx` — at placement, on a payment_status move to authorized / captured, when a fraud
// review is cleared), `processing` when the first shipment leaves planned (`markShipmentStartedInTx`, or at the
// latest `markShippedInTx`), `completed` when every shipment is delivered (`markDeliveredInTx`). Only
// `cancelled` is an explicit call. Each move happens in the transaction of its trigger, with its outbox row.
import type { Queryable, ScopedClient } from '@platform/db';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError, conflict, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { paymentProvider } from '../../lib/payment-seam';
import { releaseForOrder } from '../inventory';
import { loadOrder, loadOrderLines, renderAdminOrder } from './read-model';
import { assertNotHeldByFraud, isHeldByFraud } from './fraud-flag';
import { CancelRefundRefused, currentCancelRefunder } from './cancel-refund';
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
    // an order held by a fraud review stays pending until the review is cleared (#231)
    if (field === 'status' && to === 'confirmed' && from !== to)
      assertNotHeldByFraud(before.metadata, to);
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
  // #887: one audit row per order mutation, in this transaction (a rollback leaves none). Who: the actor as given —
  // `staff` with its id, `customer` / `system` named as such. What: the status fields that moved (before → after),
  // the changed field NAMES, and what the caller adds (line ids and quantities). Never PII.
  const moved = FIELDS.filter((f) => changed.includes(f));
  await writeAudit(tx, {
    organizationId: after.organization_id,
    storeId: after.store_id,
    actor: change.actor,
    action:
      change.audit?.action ??
      (change.status === 'cancelled'
        ? 'order.cancel'
        : moved.length > 0
          ? 'order.status_change'
          : 'order.update'),
    entityType: 'order',
    entityId: after.id,
    before: Object.fromEntries(moved.map((f) => [f, before[f]])),
    after: {
      ...Object.fromEntries(moved.map((f) => [f, after[f]])),
      ...(change.status === 'cancelled' ? { reason: after.cancel_reason } : {}),
      changed_fields: [...new Set([...changed, ...extra])].sort(),
      ...(change.audit?.after ?? {}),
    },
  });
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

/**
 * `pending → confirmed` by hand. Since #350 the core confirms automatically when the payment is authorised, so
 * this is normally a no-op; it stays for an operator and for the tests. A fraud hold still refuses it (409).
 */
export const confirmOrder = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'status', 'confirmed', actor);

/**
 * The automatic confirmation (#350): `pending → confirmed` as soon as the payment is authorised (or captured),
 * unless a fraud review holds the order (#231 — the hold is lifted by `resolveOrderReview('cleared')`, which
 * calls this again). Idempotent: an order that is not pending, or not paid, is left alone. Called inside the
 * transaction of whatever authorised the payment: the placement, a payment_status move, a cleared review.
 */
export async function confirmOnAuthorizationInTx(
  tx: Queryable,
  orderId: string,
  actor: Actor,
): Promise<boolean> {
  const o = await loadOrder(tx, orderId, true);
  if (o.status !== 'pending') return false;
  if (o.payment_status !== 'authorized' && o.payment_status !== 'captured') return false;
  if (isHeldByFraud(o.metadata)) return false;
  await transition(tx, orderId, { status: 'confirmed', actor });
  return true;
}

/** A payment_status move that may confirm the order (authorized / captured), on the caller's transaction. */
async function movePaymentIn(
  tx: Queryable,
  orderId: string,
  to: PaymentStatus,
  actor: Actor,
): Promise<void> {
  await moveFieldInTx(tx, orderId, 'payment_status', to, actor);
  if (to === 'authorized' || to === 'captured')
    await confirmOnAuthorizationInTx(tx, orderId, actor);
}

const movePayment = (client: ScopedClient, orderId: string, to: PaymentStatus, actor: Actor) =>
  client.transaction(async (tx) => {
    await movePaymentIn(tx, orderId, to, actor);
    return renderAdminOrder(tx, orderId);
  });

/** Window 7: the payment is authorised — and the order confirms with it (#350). */
export const markPaymentAuthorized = (client: ScopedClient, orderId: string, actor: Actor) =>
  movePayment(client, orderId, 'authorized', actor);
/** Window 7: captured — confirms a still-pending order too (a capture implies the authorisation). */
export const markPaymentCaptured = (client: ScopedClient, orderId: string, actor: Actor) =>
  movePayment(client, orderId, 'captured', actor);
/** Payment failure changes only `payment_status`; cancelling stays an explicit call. */
export const markPaymentFailed = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'payment_status', 'failed', actor);
export const markPaymentPartiallyRefunded = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'payment_status', 'partially_refunded', actor);
export const markPaymentRefunded = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'payment_status', 'refunded', actor);

/**
 * Window 8: the first shipment LEAVES planned (picking, packed, a label, shipped — anything but `pending`) →
 * `confirmed → processing` (#350). Idempotent; 409 from `pending` (a held order). `markShippedInTx` applies the
 * same move on its own, so an order whose shipping never reports the pick still reaches `processing` on
 * despatch.
 */
export const markShipmentStarted = (client: ScopedClient, orderId: string, actor: Actor) =>
  moveField(client, orderId, 'status', 'processing', actor);

/**
 * Window 8: a shipment was PLANNED for the order. Since #350 planning moves nothing — `processing` waits for the
 * first shipment to leave planned (`markShipmentStarted`). Kept for the callers; answers the order unchanged.
 */
export const markShipmentCreated = (client: ScopedClient, orderId: string, _actor: Actor) =>
  client.transaction((tx) => renderAdminOrder(tx, orderId));

// ---- tx-taking twins (window 8, #191): same semantics on the caller's transaction ----
export const confirmOrderInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'status', 'confirmed', actor);
export const markPaymentAuthorizedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  movePaymentIn(tx, orderId, 'authorized', actor);
export const markPaymentCapturedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  movePaymentIn(tx, orderId, 'captured', actor);
export const markPaymentFailedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'payment_status', 'failed', actor);
export const markPaymentPartiallyRefundedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'payment_status', 'partially_refunded', actor);
export const markPaymentRefundedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'payment_status', 'refunded', actor);
export const markShipmentStartedInTx = (tx: Queryable, orderId: string, actor: Actor) =>
  moveFieldInTx(tx, orderId, 'status', 'processing', actor);
/** Planning moves nothing since #350 (see `markShipmentCreated`); kept so window 8's call keeps compiling. */
export const markShipmentCreatedInTx = async (
  tx: Queryable,
  orderId: string,
  _actor: Actor,
): Promise<void> => {
  await loadOrder(tx, orderId, false); // 404 for an unknown order, as before
};

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
  if (shipped.length === 0)
    throw validationError('nothing shipped', { shipped: 'at least one line' });
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
  // Goods left the warehouse, so the first shipment has certainly left planned: `confirmed → processing` rides
  // in the same transition (one event) when shipping did not report the pick itself (#350). A held (pending)
  // order keeps its status — the fulfilment facts are recorded all the same.
  const startsProcessing = current.status === 'confirmed';
  // #887: one audit row per shipment, whether or not a status moves (a second partial shipment changes only the
  // lines' fulfilled quantities) — through the transition when there is one, directly otherwise.
  const audit = { action: 'order.ship', after: { lines: quantitiesOf(shipped) } };
  if (current.fulfillment_status !== next || startsProcessing) {
    await transition(tx, orderId, {
      ...(startsProcessing ? { status: 'processing' as const } : {}),
      ...(current.fulfillment_status !== next ? { fulfillment_status: next } : {}),
      actor,
      changed_fields: ['line_items'],
      audit,
    });
  } else {
    await auditOrder(tx, current, actor, audit.action, {
      ...audit.after,
      changed_fields: ['line_items'],
    });
  }
}

/** Ids and quantities of a shipment or a return, for its audit row (#887). */
function quantitiesOf(lines: readonly LineQuantity[]) {
  return lines.map((l) => ({ line_item_id: l.lineItemId, quantity: l.quantity }));
}

/** An order audit row for a mutation that moves no status (#887; `transition()` writes its own). */
async function auditOrder(
  tx: Queryable,
  order: OrderRow,
  actor: Actor,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    organizationId: order.organization_id,
    storeId: order.store_id,
    actor,
    action,
    entityType: 'order',
    entityId: order.id,
    before: {},
    after,
  });
}

/**
 * Window 8: a shipment was delivered → `completed` once EVERY shipment of the order is delivered (cancelled
 * ones do not count) and the order is fulfilled (#350). Until then it is a no-op — the next delivery asks again.
 */
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
export async function markDeliveredInTx(
  tx: Queryable,
  orderId: string,
  actor: Actor,
): Promise<void> {
  const o = await loadOrder(tx, orderId, true);
  if (o.status === 'completed' || o.status === 'cancelled') return;
  if (o.fulfillment_status !== 'fulfilled') return;
  // Every shipment the order still has must have arrived (window 8 updates the row before it calls this).
  const open = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM shipment WHERE order_id = $1 AND status NOT IN ('delivered', 'cancelled')`,
    [orderId],
  );
  if (Number(open.rows[0]!.n) > 0) return;
  // `pending` (held by a fraud review) never completes; `confirmed` passes through `processing` first.
  if (o.status === 'pending') return;
  if (o.status === 'confirmed') await transition(tx, orderId, { status: 'processing', actor });
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
  // #887: one audit row per received return, whether or not the fulfilment status moves
  const audit = { action: 'order.return', after: { lines: quantitiesOf(returned) } };
  if (current.fulfillment_status !== next) {
    await transition(tx, orderId, {
      fulfillment_status: next,
      actor,
      changed_fields: ['line_items'],
      audit,
    });
  } else {
    await auditOrder(tx, current, actor, audit.action, {
      ...audit.after,
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

/** #191's shape of the same port (`setFulfillmentStatus({ tx, orderId, status, actor })`); the positional twin stays for window 8's current adapter. */
export async function setFulfillmentStatus(input: {
  tx: Queryable;
  orderId: string;
  status: FulfillmentStatus;
  actor: Actor;
}): Promise<void> {
  return setFulfillmentStatusIn(input.tx, input.orderId, input.status, input.actor);
}

/**
 * Merges keys into `order.metadata` on the caller's transaction (the returns module's exchange link, the fraud flag).
 * No event: metadata is storefront/ops-owned. No audit row either (#887): its callers audit — the fraud flag through
 * the `transition()` that follows it, the exchange link with its own `order.exchange_link` row.
 */
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
  await movePaymentIn(tx, orderId, to, actor);
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
 * `cancelled` on the payment row. A CAPTURED payment (also partly refunded) is refunded for what is still captured
 * (captured − already refunded) through the `CancelRefunder` seam (#905: window 7's `createRefundIn`, reason
 * `cancellation`, key `<payment idempotency_key>:cancel-refund`): the refund row and `refund.issued` commit with the
 * cancel or not at all — a provider refusal leaves the order uncancelled (402 `payment_failed`, as a refused void);
 * an unknown outcome (outage, timeout) throws and commits nothing, and a retry sends the SAME provider key, so the
 * PSP answers the refund it already made instead of making a second one. Nothing consumes `order.cancelled` to
 * refund. Reservations release through the inventory public API. Idempotent: an already-cancelled order is
 * returned as is (no second refund).
 */
export async function cancelOrder(
  client: ScopedClient,
  orderId: string,
  input: { reason: string; actor: Actor },
): Promise<AdminOrder> {
  try {
    return await client.transaction(async (tx) => {
      await cancelOrderInTx(tx, orderId, input);
      return renderAdminOrder(tx, orderId);
    });
  } catch (err) {
    // #918: the cancel rolled back; the provider's refusal is recorded in its OWN transaction (a failed refund row +
    // `refund.failed`), so the next cancel derives a NEW provider key instead of replaying the saved refusal. An
    // unknown outcome (anything but this) records nothing: the next cancel reuses its key.
    if (err instanceof CancelRefundRefused) {
      await currentCancelRefunder()?.recordFailedAttempt(client, err.attempt);
    }
    throw err;
  }
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
  // #905: a captured payment is refunded for what is still captured, in THIS transaction — BEFORE the reservations
  // are released (#918, as the void above): the provider call happens while this transaction holds as few locks as
  // possible (the order row, not every pool row of the order's stock). If anything later throws, the rollback leaves
  // no row; a retry derives the same attempt key (nothing was recorded), so the PSP returns the refund it made.
  const refundIds = await refundCapturedForCancel(tx, o, input.actor);
  // Reservations are released here, through the orders module's own cancel — never from window 8's side.
  await releaseForOrder(tx, orderId);
  // #466: an authorisation the cancel released reads `voided` — as its OWN transition, so `order.updated`
  // (changed_fields ['payment_status']) is written before `order.cancelled`; one combined transition would emit
  // only `order.cancelled`. awaiting / failed have nothing to release; a captured payment was refunded above, and
  // `createRefundIn` moved `payment_status` to `refunded` (or kept `captured` while a PSP refund is pending).
  if (o.payment_status === 'authorized') {
    await transition(tx, orderId, { payment_status: 'voided', actor: input.actor });
  }
  await transition(tx, orderId, {
    status: 'cancelled',
    reason: input.reason,
    actor: input.actor,
    // #887: the cancel's audit row links the refund(s) the cancel made (#905)
    ...(refundIds.length > 0 ? { audit: { after: { refund_ids: refundIds } } } : {}),
  });
}

async function refundCapturedForCancel(
  tx: Queryable,
  o: OrderRow,
  actor: Actor,
): Promise<string[]> {
  const captured = await tx.query<{ id: string; provider: string; idempotency_key: string }>(
    `SELECT id, provider, idempotency_key FROM payment
     WHERE order_id = $1 AND status = 'captured' ORDER BY created_at, id`,
    [o.id],
  );
  if (captured.rows.length === 0) return [];
  const refunder = currentCancelRefunder();
  if (!refunder) {
    // Fail closed: never cancel a charged order without its refund.
    throw new AppError(
      'internal',
      'the cancel refund is not available (no CancelRefunder registered)',
      undefined,
      503,
    );
  }
  const refundIds: string[] = [];
  for (const p of captured.rows) {
    const out = await refunder.refundRemaining(tx, {
      orderId: o.id,
      paymentId: p.id,
      paymentKey: p.idempotency_key,
      actor,
    });
    if (out.status === 'failed') {
      throw new CancelRefundRefused(
        {
          orderId: o.id,
          paymentId: p.id,
          amountMinor: out.amountMinor,
          idempotencyKey: out.idempotencyKey ?? '',
          failureReason: out.failureReason ?? 'payment could not be refunded',
          actor,
        },
        p.provider,
      );
    }
    if (out.refundId) refundIds.push(out.refundId);
  }
  return refundIds;
}

/**
 * #918: a refund the PSP accepted, then FAILED, on an order that is already cancelled — the order keeps the customer's
 * money and nobody would notice. `order.metadata.refund_attention = { refund_id, reason, at }`, one `order.updated`
 * (`changed_fields: ['metadata']`) and one audit row (`order.refund_attention`), on the caller's transaction.
 * Idempotent per refund. Window 7's webhook calls it.
 */
export async function setRefundAttentionInTx(
  tx: Queryable,
  orderId: string,
  attention: { refundId: string; reason: string },
  actor: Actor,
): Promise<void> {
  const o = await loadOrder(tx, orderId, true);
  const current = o.metadata.refund_attention as { refund_id?: string } | undefined;
  if (current?.refund_id === attention.refundId) return;
  const flag = {
    refund_id: attention.refundId,
    reason: attention.reason,
    at: new Date().toISOString(),
  };
  await mergeOrderMetadataIn(tx, orderId, { refund_attention: flag });
  await transition(tx, orderId, {
    changed_fields: ['metadata'],
    actor,
    audit: { action: 'order.refund_attention', after: { refund_attention: flag } },
  });
}

/**
 * #918: clears `refund_attention` when a later refund of the order succeeds (else the flag lies) — one
 * `order.updated` + one audit row (`order.refund_attention_cleared`, the refund that settled it). A no-op without
 * a flag. Window 7 calls it wherever a refund becomes `succeeded`.
 */
export async function clearRefundAttentionInTx(
  tx: Queryable,
  orderId: string,
  settledBy: { refundId: string },
  actor: Actor,
): Promise<void> {
  const o = await loadOrder(tx, orderId, true);
  const current = o.metadata.refund_attention as { refund_id?: string } | undefined;
  if (!current) return;
  const { refund_attention: _cleared, ...rest } = o.metadata;
  await tx.query(`UPDATE "order" SET metadata = $2::jsonb, updated_at = now() WHERE id = $1`, [
    orderId,
    JSON.stringify(rest),
  ]);
  await transition(tx, orderId, {
    changed_fields: ['metadata'],
    actor,
    audit: {
      action: 'order.refund_attention_cleared',
      after: {
        failed_refund_id: current.refund_id ?? null,
        settled_by_refund_id: settledBy.refundId,
      },
    },
  });
}

export type { PaymentStatus };
