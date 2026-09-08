// Pure projection of an order from its outbox stream (issue #105, reused by 2.5 returns and 2.6's whole-lifecycle
// replay suite): fold `order.placed`, `order.confirmed`, `order.updated`, `order.cancelled`, `order.completed`
// (later `return.*`) into the state the `"order"` row must show. No I/O, no clock: what the events say is all
// there is, which is exactly what makes the replay test meaningful.
import type { FulfillmentStatus, OrderStatus, PaymentStatus } from './types';

export interface OrderProjection {
  order_id: string;
  display_id: number;
  status: OrderStatus;
  payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus;
  totals: {
    subtotal_minor: number;
    discount_minor: number;
    shipping_minor: number;
    tax_minor: number;
    total_minor: number;
  };
  placed_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  cancel_reason: string | null;
  /** Every event applied, in order (topic only) — handy in test failures. */
  applied: string[];
}

/** The subset of an outbox envelope the projection reads. */
export interface ProjectedEvent {
  topic: string;
  payload: Record<string, unknown>;
}

type Totals = OrderProjection['totals'];

function totalsOf(p: Record<string, unknown>, fallback: Totals): Totals {
  const t = p.totals as Partial<Totals> | undefined;
  if (!t) return fallback;
  return {
    subtotal_minor: t.subtotal_minor ?? fallback.subtotal_minor,
    discount_minor: t.discount_minor ?? fallback.discount_minor,
    shipping_minor: t.shipping_minor ?? fallback.shipping_minor,
    tax_minor: t.tax_minor ?? fallback.tax_minor,
    total_minor: t.total_minor ?? fallback.total_minor,
  };
}

/**
 * Applies one event to the state (`null` before `order.placed`). Unknown topics for the aggregate are ignored
 * (a `return.*` event will be handled by 2.5's extension); an event before `order.placed` throws — a stream that
 * starts elsewhere is a bug in the writer, not something to paper over.
 */
export function applyOrderEvent(
  state: OrderProjection | null,
  event: ProjectedEvent,
): OrderProjection | null {
  const p = event.payload;
  if (event.topic === 'order.placed') {
    return {
      order_id: String(p.order_id),
      display_id: Number(p.display_id),
      status: 'pending',
      payment_status: 'authorized',
      fulfillment_status: 'unfulfilled',
      totals: totalsOf(p, {
        subtotal_minor: 0,
        discount_minor: 0,
        shipping_minor: 0,
        tax_minor: 0,
        total_minor: 0,
      }),
      placed_at: String(p.placed_at),
      cancelled_at: null,
      completed_at: null,
      cancel_reason: null,
      applied: ['order.placed'],
    };
  }
  if (!event.topic.startsWith('order.')) return state;
  if (!state) throw new Error(`${event.topic} before order.placed in the stream`);
  const next: OrderProjection = { ...state, applied: [...state.applied, event.topic] };
  switch (event.topic) {
    case 'order.confirmed':
      next.status = 'confirmed';
      return next;
    case 'order.completed':
      next.status = 'completed';
      next.completed_at = String(p.completed_at);
      return next;
    case 'order.cancelled':
      next.status = 'cancelled';
      next.cancelled_at = String(p.cancelled_at);
      next.cancel_reason = (p.reason as string | null) ?? null;
      next.totals = totalsOf(p, state.totals);
      return next;
    case 'order.updated':
      next.status = p.status as OrderStatus;
      next.payment_status = p.payment_status as PaymentStatus;
      next.fulfillment_status = p.fulfillment_status as FulfillmentStatus;
      next.totals = totalsOf(p, state.totals);
      return next;
    default:
      return state;
  }
}

/** Folds a whole stream (already ordered by occurrence) from nothing. */
export function projectOrder(events: readonly ProjectedEvent[]): OrderProjection | null {
  return events.reduce<OrderProjection | null>(applyOrderEvent, null);
}
