// Return read model: the Admin API `Return` shape, and a pure projection for replay (issue #107).
import type { Queryable, ScopedClient } from '@platform/db';
import { notFound } from '../../lib/errors';
import type { AdminReturn, ReturnItemRow, ReturnRow, ReturnStatus } from './types';

export async function renderReturn(tx: Queryable, returnId: string): Promise<AdminReturn> {
  const r = await tx.query<ReturnRow>(
    `SELECT id, organization_id, store_id, order_id, status, reason, warehouse_id, refund_id, requested_at,
            received_at, metadata FROM "return" WHERE id = $1`,
    [returnId],
  );
  const ret = r.rows[0];
  if (!ret) throw notFound('return', returnId);
  const items = await tx.query<ReturnItemRow>(
    `SELECT id, order_line_item_id, quantity, condition FROM return_item WHERE return_id = $1 ORDER BY created_at, id`,
    [returnId],
  );
  return {
    id: ret.id,
    order_id: ret.order_id,
    status: ret.status,
    reason: ret.reason,
    warehouse_id: ret.warehouse_id,
    refund_id: ret.refund_id,
    items: items.rows.map((i) => ({
      order_line_item_id: i.order_line_item_id,
      quantity: i.quantity,
      condition: i.condition,
    })),
    requested_at: ret.requested_at.toISOString(),
    received_at: ret.received_at ? ret.received_at.toISOString() : null,
  };
}

export async function getReturn(client: ScopedClient, returnId: string): Promise<AdminReturn> {
  return client.transaction((tx) => renderReturn(tx, returnId));
}

// ---- projection (pure) ----

export interface ReturnProjection {
  return_id: string;
  order_id: string;
  status: ReturnStatus;
  warehouse_id: string | null;
  refund_id: string | null;
  items: { order_line_item_id: string; quantity: number; condition: string | null }[];
  applied: string[];
}

export interface ProjectedEvent {
  topic: string;
  payload: Record<string, unknown>;
}

/**
 * Folds `return.requested` → `return.received` → (`refund.issued` with this `return_id`, window 7's event) into
 * the state the `"return"` row must show. `approved` / `rejected` have no contract event and are not replayable
 * (documented); a `refund.issued` for another return is ignored.
 */
export function applyReturnEvent(
  state: ReturnProjection | null,
  event: ProjectedEvent,
): ReturnProjection | null {
  const p = event.payload;
  if (event.topic === 'return.requested') {
    return {
      return_id: String(p.return_id),
      order_id: String(p.order_id),
      status: 'requested',
      warehouse_id: null,
      refund_id: null,
      items: (p.items as { order_line_item_id: string; quantity: number }[]).map((i) => ({
        ...i,
        condition: null,
      })),
      applied: ['return.requested'],
    };
  }
  if (!state) return state;
  if (event.topic === 'return.received' && p.return_id === state.return_id) {
    return {
      ...state,
      status: 'received',
      warehouse_id: String(p.warehouse_id),
      items: p.items as ReturnProjection['items'],
      applied: [...state.applied, event.topic],
    };
  }
  if (event.topic === 'refund.issued' && p.return_id === state.return_id) {
    return {
      ...state,
      status: 'refunded',
      refund_id: String(p.refund_id),
      applied: [...state.applied, event.topic],
    };
  }
  return state;
}

export function projectReturn(events: readonly ProjectedEvent[]): ReturnProjection | null {
  return events.reduce<ReturnProjection | null>(applyReturnEvent, null);
}
