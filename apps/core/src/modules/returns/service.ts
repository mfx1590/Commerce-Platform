// Returns module (issue #107): `"return"` + `return_item` lifecycle requested → approved → received → refunded |
// rejected (received is reachable from requested: receiving implies approval). Same shape as orders: one
// `transitionReturn()` per status move (row lock, table, exactly one event where the contract has one), 409
// `{ field, from, to }` otherwise. Receiving a return, in ONE transaction: return row → items' condition → the
// order's returned quantities (orders module) → restock of resellable items (inventory module, `return`
// movements) → `return.received` → the refund through the RefundRequester seam (idempotent per return).
import type { Queryable, ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError, conflict, notFound, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { moveStock } from '../inventory';
import {
  loadOrder,
  loadOrderLines,
  markReturnedIn,
  mergeOrderMetadataIn,
  movePaymentStatusIn,
  type OrderLineRow,
} from '../orders';
import { renderReturn } from './read-model';
import { currentRefundRequester, refundKeyFor } from './refund-seam';
import type {
  AdminReturn,
  ReceiveReturnInput,
  RequestReturnInput,
  ReturnItemRow,
  ReturnRow,
  ReturnStatus,
} from './types';

export const RETURN_TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  requested: ['approved', 'received', 'rejected'],
  approved: ['received', 'rejected'],
  received: ['refunded'],
  refunded: [],
  rejected: [],
};

const RETURN_COLS = `id, organization_id, store_id, order_id, status, reason, warehouse_id, refund_id, requested_at,
  received_at, metadata`;

export async function loadReturn(
  tx: Queryable,
  returnId: string,
  lock: boolean,
): Promise<ReturnRow> {
  const r = await tx.query<ReturnRow>(
    `SELECT ${RETURN_COLS} FROM "return" WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [returnId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('return', returnId);
  return row;
}

export async function loadReturnItems(tx: Queryable, returnId: string): Promise<ReturnItemRow[]> {
  const r = await tx.query<ReturnItemRow>(
    `SELECT id, order_line_item_id, quantity, condition FROM return_item WHERE return_id = $1 ORDER BY created_at, id`,
    [returnId],
  );
  return r.rows;
}

/** The one status mutation: validates against RETURN_TRANSITIONS and applies; the caller writes the event. */
export async function transitionReturn(
  tx: Queryable,
  returnId: string,
  to: ReturnStatus,
  extra: {
    warehouseId?: string | undefined;
    refundId?: string | null | undefined;
    receivedAt?: Date | undefined;
  } = {},
): Promise<ReturnRow> {
  const before = await loadReturn(tx, returnId, true);
  if (!RETURN_TRANSITIONS[before.status].includes(to)) {
    throw conflict(`return cannot go from ${before.status} to ${to}`, {
      field: 'status',
      from: before.status,
      to,
    });
  }
  await tx.query(
    `UPDATE "return" SET status = $2,
       warehouse_id = COALESCE($3, warehouse_id),
       refund_id = COALESCE($4, refund_id),
       received_at = COALESCE($5, received_at),
       updated_at = now()
     WHERE id = $1`,
    [returnId, to, extra.warehouseId ?? null, extra.refundId ?? null, extra.receivedAt ?? null],
  );
  return loadReturn(tx, returnId, false);
}

/** Quantity of a line that can still be requested: shipped − returned − open (requested/approved) returns. */
async function returnableQuantities(
  tx: Queryable,
  orderId: string,
  lines: OrderLineRow[],
): Promise<Map<string, number>> {
  const open = await tx.query<{ order_line_item_id: string; quantity: string }>(
    `SELECT ri.order_line_item_id, sum(ri.quantity)::text AS quantity
     FROM return_item ri JOIN "return" r ON r.id = ri.return_id
     WHERE r.order_id = $1 AND r.status IN ('requested', 'approved')
     GROUP BY ri.order_line_item_id`,
    [orderId],
  );
  const openBy = new Map(open.rows.map((r) => [r.order_line_item_id, Number(r.quantity)]));
  return new Map(
    lines.map((l) => [l.id, l.fulfilled_quantity - l.returned_quantity - (openBy.get(l.id) ?? 0)]),
  );
}

/**
 * `POST /admin/stores/{storeId}/orders/{orderId}/returns` (support): a return request for shipped quantities.
 * Over the returnable quantity → 409 `conflict` `{ order_line_item_id, returnable }`; an unshipped order → 409.
 */
export async function requestReturn(
  client: ScopedClient,
  orderId: string,
  input: RequestReturnInput,
): Promise<AdminReturn> {
  if (input.items.length === 0)
    throw validationError('items must not be empty', { items: 'at least one' });
  return client.transaction(async (tx) => {
    const order = await loadOrder(tx, orderId, true);
    if (order.fulfillment_status === 'unfulfilled') {
      throw conflict('nothing has shipped yet; cancel the order instead', {
        field: 'fulfillment_status',
        from: order.fulfillment_status,
        to: 'partially_fulfilled | fulfilled',
      });
    }
    const lines = await loadOrderLines(tx, orderId);
    const returnable = await returnableQuantities(tx, orderId, lines);
    const merged = new Map<string, number>();
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw validationError('quantity must be a positive integer', {
          order_line_item_id: item.order_line_item_id,
        });
      }
      if (!returnable.has(item.order_line_item_id)) {
        throw notFound('line item', item.order_line_item_id);
      }
      merged.set(
        item.order_line_item_id,
        (merged.get(item.order_line_item_id) ?? 0) + item.quantity,
      );
    }
    for (const [lineId, quantity] of merged) {
      const max = returnable.get(lineId)!;
      if (quantity > max) {
        throw conflict('return exceeds the shipped, not yet returned quantity', {
          order_line_item_id: lineId,
          requested: quantity,
          returnable: Math.max(0, max),
        });
      }
    }
    const created = await tx.query<{ id: string; requested_at: Date }>(
      `INSERT INTO "return" (organization_id, store_id, order_id, status, reason)
       VALUES ($1, $2, $3, 'requested', $4) RETURNING id, requested_at`,
      [order.organization_id, order.store_id, orderId, input.reason ?? null],
    );
    const ret = created.rows[0]!;
    for (const [lineId, quantity] of merged) {
      await tx.query(
        `INSERT INTO return_item (organization_id, store_id, return_id, order_line_item_id, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.organization_id, order.store_id, ret.id, lineId, quantity],
      );
    }
    await withEvents(tx, [
      await buildEvent({
        topic: 'return.requested',
        organizationId: order.organization_id,
        storeId: order.store_id,
        aggregateType: 'return',
        aggregateId: ret.id,
        actor: eventActor(input.actor),
        payload: {
          return_id: ret.id,
          order_id: orderId,
          reason: input.reason ?? null,
          items: [...merged].map(([order_line_item_id, quantity]) => ({
            order_line_item_id,
            quantity,
          })),
          requested_at: ret.requested_at.toISOString(),
        },
      }),
    ]);
    return renderReturn(tx, ret.id);
  });
}

/** Support flows (window 16): approve / reject a requested return. No contract event for either. */
export async function approveReturn(client: ScopedClient, returnId: string): Promise<AdminReturn> {
  return client.transaction(async (tx) => {
    await transitionReturn(tx, returnId, 'approved');
    return renderReturn(tx, returnId);
  });
}
export async function rejectReturn(client: ScopedClient, returnId: string): Promise<AdminReturn> {
  return client.transaction(async (tx) => {
    await transitionReturn(tx, returnId, 'rejected');
    return renderReturn(tx, returnId);
  });
}

/**
 * Refund amount for received items, shipping excluded. A line's total is allocated over its units by cumulative
 * floor — `floor(total × (before + qty) / quantity) − floor(total × before / quantity)`, `before` being the line's
 * `returned_quantity` before this receipt — so separate partial returns of one line sum to the line total exactly:
 * the rounding remainder lands on the last unit returned (100 over 3 units → 33, 33, 34), never on the merchant.
 */
export function refundAmountFor(
  lines: readonly Pick<OrderLineRow, 'id' | 'quantity' | 'total_minor' | 'returned_quantity'>[],
  received: readonly { order_line_item_id: string; quantity: number }[],
): number {
  let total = 0;
  const allocated = new Map<string, number>(); // units of this receipt already counted per line
  for (const r of received) {
    const line = lines.find((l) => l.id === r.order_line_item_id);
    if (!line || line.quantity === 0 || r.quantity <= 0) continue;
    const lineTotal = Number(line.total_minor);
    const before = line.returned_quantity + (allocated.get(line.id) ?? 0);
    const after = Math.min(before + r.quantity, line.quantity);
    total +=
      Math.floor((lineTotal * after) / line.quantity) -
      Math.floor((lineTotal * before) / line.quantity);
    allocated.set(line.id, after - line.returned_quantity);
  }
  return total;
}

type RefundOutcome = Awaited<ReturnType<ReturnType<typeof currentRefundRequester>['request']>>;

/** A thrown error as a stored failure reason: name + message, capped; never the stack, never request data. */
function thrownReason(error: unknown): string {
  const e = error as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  const message = typeof e?.message === 'string' ? e.message : String(error);
  return `requester threw: ${name}: ${message}`.slice(0, 200);
}

interface CapturedPayment {
  id: string;
  provider: string;
  provider_payment_id: string | null;
  amount_minor: string;
  currency: string;
}

/**
 * `POST /admin/stores/{storeId}/returns/{returnId}/receive` (operations): the warehouse has the goods. One
 * transaction: items' condition + quantities (≤ requested, 409 otherwise) → `received` → the order's returned
 * quantities and fulfillment_status (orders module) → restock of resellable items into `warehouseId` (inventory
 * `moveStock`, reason `return`, one `stock.moved` each; damaged goods are not restocked) → `return.received` →
 * refund through the RefundRequester (idempotent per return: a recorded outcome is never re-requested) →
 * `refunded` + the order's payment_status when the requester succeeded. A requester that throws (provider
 * timeout) does not undo the receipt: its work is rolled back to a savepoint and a failed outcome is recorded.
 */
export async function receiveReturn(
  client: ScopedClient,
  returnId: string,
  input: ReceiveReturnInput,
): Promise<AdminReturn> {
  if (input.items.length === 0)
    throw validationError('items must not be empty', { items: 'at least one' });
  return client.transaction(async (tx) => {
    const ret = await loadReturn(tx, returnId, true);
    if (ret.status !== 'requested' && ret.status !== 'approved') {
      throw conflict(`return is ${ret.status}`, {
        field: 'status',
        from: ret.status,
        to: 'received',
      });
    }
    const items = await loadReturnItems(tx, returnId);
    const requestedBy = new Map(items.map((i) => [i.order_line_item_id, i]));
    const received: {
      order_line_item_id: string;
      quantity: number;
      condition: 'resellable' | 'damaged';
    }[] = [];
    for (const item of input.items) {
      const requested = requestedBy.get(item.order_line_item_id);
      if (!requested) throw notFound('return item', item.order_line_item_id);
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > requested.quantity
      ) {
        throw conflict('received quantity exceeds the requested quantity', {
          order_line_item_id: item.order_line_item_id,
          requested: requested.quantity,
          received: item.quantity,
        });
      }
      await tx.query(
        `UPDATE return_item SET quantity = $2, condition = $3, updated_at = now() WHERE id = $1`,
        [requested.id, item.quantity, item.condition],
      );
      received.push({
        order_line_item_id: item.order_line_item_id,
        quantity: item.quantity,
        condition: item.condition,
      });
    }
    // items requested but not received are dropped from the return (they were never sent back)
    for (const i of items) {
      if (!received.some((r) => r.order_line_item_id === i.order_line_item_id)) {
        await tx.query(`DELETE FROM return_item WHERE id = $1`, [i.id]);
      }
    }
    const now = new Date();
    await transitionReturn(tx, returnId, 'received', {
      warehouseId: input.warehouseId,
      receivedAt: now,
    });

    const order = await loadOrder(tx, ret.order_id, false);
    const lines = await loadOrderLines(tx, ret.order_id);
    // the order side: returned quantities + fulfillment_status (one order.updated), through the orders module
    await markReturnedIn(
      tx,
      ret.order_id,
      received.map((r) => ({ lineItemId: r.order_line_item_id, quantity: r.quantity })),
      input.actor,
    );
    // restock resellable goods through the inventory module (append-only ledger + stock.moved each)
    for (const r of received) {
      if (r.condition !== 'resellable') continue;
      const line = lines.find((l) => l.id === r.order_line_item_id);
      if (!line?.variant_id) continue; // variant deleted since: nothing to put back on a shelf
      await moveStock(tx, {
        organizationId: order.organization_id,
        storeId: order.store_id,
        variantId: line.variant_id,
        warehouseId: input.warehouseId,
        delta: r.quantity,
        reason: 'return',
        referenceType: 'return',
        referenceId: returnId,
        actor: input.actor,
      });
    }
    await withEvents(tx, [
      await buildEvent({
        topic: 'return.received',
        organizationId: order.organization_id,
        storeId: order.store_id,
        aggregateType: 'return',
        aggregateId: returnId,
        actor: eventActor(input.actor),
        payload: {
          return_id: returnId,
          order_id: ret.order_id,
          warehouse_id: input.warehouseId,
          items: received,
          received_at: now.toISOString(),
        },
      }),
    ]);
    if (input.hooks?.afterEvents) await input.hooks.afterEvents(tx);

    // ---- refund through the seam, idempotent per return ----
    await requestRefundFor(tx, returnId, refundAmountFor(lines, received), input.actor);
    return renderReturn(tx, returnId);
  });
}

/**
 * Asks the RefundRequester once per return: a succeeded or pending outcome recorded in `metadata.refund`
 * short-circuits a retry; a failed one is retried under the same `return:<id>` key. On success the return goes
 * `refunded` (with the requester's refund id when given) and the order's payment_status follows
 * (partially_refunded | refunded against the captured amount). A failed or pending outcome leaves the return
 * `received`; window 7 finishes it with `markReturnRefunded`. A requester that throws is treated as failed: its
 * writes are rolled back to a savepoint (the transaction stays usable), the reason is recorded, nothing else is lost.
 */
export async function requestRefundFor(
  tx: Queryable,
  returnId: string,
  amountMinor: number,
  actor: Actor,
): Promise<void> {
  const ret = await loadReturn(tx, returnId, true);
  const recorded = ret.metadata.refund as { status?: string } | undefined;
  if (recorded?.status === 'succeeded' || recorded?.status === 'pending') return; // never twice
  if (amountMinor <= 0) return;
  const captured = await tx.query<CapturedPayment>(
    `SELECT id, provider, provider_payment_id, amount_minor::text, currency FROM payment
     WHERE order_id = $1 AND status = 'captured' ORDER BY captured_at NULLS LAST, created_at LIMIT 1`,
    [ret.order_id],
  );
  const payment = captured.rows[0];
  if (!payment || !payment.provider_payment_id) {
    throw new AppError('conflict', 'no captured payment to refund against (capture first)', {
      order_id: ret.order_id,
      return_id: returnId,
    });
  }
  const idempotencyKey = refundKeyFor(returnId);
  await tx.query('SAVEPOINT refund_request');
  let response: RefundOutcome;
  try {
    response = await currentRefundRequester().request({
      tx,
      organizationId: ret.organization_id,
      storeId: ret.store_id,
      orderId: ret.order_id,
      returnId,
      paymentId: payment.id,
      provider: payment.provider,
      providerPaymentId: payment.provider_payment_id,
      amountMinor,
      currency: payment.currency,
      reason: 'return',
      idempotencyKey,
      actor,
    });
    await tx.query('RELEASE SAVEPOINT refund_request');
  } catch (error) {
    // provider timeout / requester crash: drop whatever it wrote, keep the receipt + restock, record and move on —
    // the next requestRefundFor retries under the same key (the provider de-duplicates on it)
    await tx.query('ROLLBACK TO SAVEPOINT refund_request');
    response = { status: 'failed', refundId: null, failureReason: thrownReason(error) };
  }
  await tx.query(`UPDATE "return" SET metadata = $2::jsonb, updated_at = now() WHERE id = $1`, [
    returnId,
    JSON.stringify({
      ...ret.metadata,
      refund: {
        status: response.status,
        amount_minor: amountMinor,
        currency: payment.currency,
        payment_id: payment.id,
        refund_id: response.refundId,
        idempotency_key: idempotencyKey,
        failure_reason: response.failureReason ?? null,
        at: new Date().toISOString(),
      },
    }),
  ]);
  if (response.status === 'succeeded') {
    await finishRefund(
      tx,
      returnId,
      response.refundId,
      amountMinor,
      Number(payment.amount_minor),
      actor,
    );
  }
}

async function finishRefund(
  tx: Queryable,
  returnId: string,
  refundId: string | null,
  amountMinor: number,
  capturedMinor: number,
  actor: Actor,
): Promise<void> {
  const ret = await transitionReturn(tx, returnId, 'refunded', { refundId });
  const refundedSoFar = await tx.query<{ n: string }>(
    `SELECT coalesce(sum((metadata->'refund'->>'amount_minor')::bigint), 0)::text AS n
     FROM "return" WHERE order_id = $1 AND status = 'refunded'`,
    [ret.order_id],
  );
  const total = Number(refundedSoFar.rows[0]!.n) || amountMinor;
  await movePaymentStatusIn(
    tx,
    ret.order_id,
    total >= capturedMinor ? 'refunded' : 'partially_refunded',
    actor,
  );
}

/** Window 7: a pending refund settled (webhook) → the return goes `refunded` with the refund id. */
export async function markReturnRefunded(
  client: ScopedClient,
  returnId: string,
  refundId: string | null,
  actor: Actor,
): Promise<AdminReturn> {
  return client.transaction(async (tx) => {
    const ret = await loadReturn(tx, returnId, true);
    if (ret.status === 'refunded') return renderReturn(tx, returnId);
    const recorded = ret.metadata.refund as
      { amount_minor?: number; payment_id?: string } | undefined;
    const captured = recorded?.payment_id
      ? await tx.query<{ amount_minor: string }>(
          `SELECT amount_minor::text FROM payment WHERE id = $1`,
          [recorded.payment_id],
        )
      : { rows: [] as { amount_minor: string }[] };
    await tx.query(`UPDATE "return" SET metadata = $2::jsonb, updated_at = now() WHERE id = $1`, [
      returnId,
      JSON.stringify({
        ...ret.metadata,
        refund: { ...(recorded ?? {}), status: 'succeeded', refund_id: refundId },
      }),
    ]);
    await finishRefund(
      tx,
      returnId,
      refundId,
      recorded?.amount_minor ?? 0,
      Number(captured.rows[0]?.amount_minor ?? Number.MAX_SAFE_INTEGER),
      actor,
    );
    return renderReturn(tx, returnId);
  });
}

/**
 * Exchange = this return + a new order, linked both ways in metadata; no money coupling in Phase 2 (the return
 * refunds, the new order charges). Module function only — the contract has no exchange operation.
 */
export async function linkExchange(
  client: ScopedClient,
  returnId: string,
  newOrderId: string,
): Promise<AdminReturn> {
  return client.transaction(async (tx) => {
    const ret = await loadReturn(tx, returnId, true);
    const order = await loadOrder(tx, newOrderId, true);
    if (order.id === ret.order_id) {
      throw validationError('the exchange order must be a different order', {
        order_id: 'same as the returned order',
      });
    }
    await tx.query(`UPDATE "return" SET metadata = $2::jsonb, updated_at = now() WHERE id = $1`, [
      returnId,
      JSON.stringify({ ...ret.metadata, exchange: { order_id: newOrderId } }),
    ]);
    await mergeOrderMetadataIn(tx, newOrderId, {
      exchange_for: { return_id: returnId, order_id: ret.order_id },
    });
    return renderReturn(tx, returnId);
  });
}
