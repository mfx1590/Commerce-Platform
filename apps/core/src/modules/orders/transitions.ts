// The order state machine's source of truth (issue #105): one map of allowed transitions per status field. The
// README table is rendered from these maps by hand and a test asserts the two agree. `transition()` in
// service.ts consults nothing else. Events per transition: `status` → order.confirmed / order.cancelled /
// order.completed (processing has no event of its own → order.updated); payment_status / fulfillment_status →
// order.updated with `changed_fields`.
import type { FulfillmentStatus, OrderStatus, PaymentStatus } from './types';

export const STATUS_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  awaiting: ['authorized', 'failed'],
  authorized: ['captured', 'failed'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['refunded'],
  refunded: [],
  failed: ['authorized'],
};

export const FULFILLMENT_TRANSITIONS: Readonly<
  Record<FulfillmentStatus, readonly FulfillmentStatus[]>
> = {
  unfulfilled: ['partially_fulfilled', 'fulfilled'],
  partially_fulfilled: ['fulfilled', 'partially_returned'],
  fulfilled: ['partially_returned', 'returned'],
  partially_returned: ['returned'],
  returned: [],
};

export type StatusField = 'status' | 'payment_status' | 'fulfillment_status';

export function allowed(field: StatusField, from: string, to: string): boolean {
  const table =
    field === 'status'
      ? STATUS_TRANSITIONS
      : field === 'payment_status'
        ? PAYMENT_TRANSITIONS
        : FULFILLMENT_TRANSITIONS;
  return ((table as Record<string, readonly string[]>)[from] ?? []).includes(to);
}

/** Markdown rows of a table, in map order — what the README shows (asserted equal in orders.test.ts). */
export function transitionTableMarkdown(
  table: Readonly<Record<string, readonly string[]>>,
): string[] {
  return Object.entries(table).map(
    ([from, tos]) =>
      `| \`${from}\` | ${tos.length ? tos.map((t) => `\`${t}\``).join(', ') : '— (terminal)'} |`,
  );
}
