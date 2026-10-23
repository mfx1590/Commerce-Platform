// The order/LTV rollup per customer per store (#555). PURE, so every combination of placed, cancelled and
// refunded is a unit test with no database.
//
// WHY IT IS RECOMPUTED, NOT ACCUMULATED. The obvious shape would be "+1 order, +total on order.placed, -amount
// on refund.issued" against a stored counter. That is wrong here for one reason that outweighs its
// convenience: it is not idempotent. The bus is at-least-once and replayable (ADR 0003), so a redelivery, a
// DLQ replay or a consumer rebuilt from the beginning would double-count, and nothing in a counter can tell a
// second delivery from a second order. Recomputing from the customer's own rows makes the sync idempotent BY
// CONSTRUCTION: the same event handled twice produces the same contact, and a replay of the whole topic
// converges instead of drifting. It also means this service owns no state, which is the #553 rule.
//
// So the consumer reads the customer's orders and refunds (one bounded read per event) and this function turns
// them into the contact's numbers.

/** One order row, as `read.ts` selects it. Money is integer minor units; never a float, never divided. */
export interface RollupOrder {
  id: string;
  status: string;
  total_minor: number | string;
  currency: string;
  placed_at: string | Date | null;
}

/** One refund row. Only `succeeded` refunds reduce revenue — see the function body. */
export interface RollupRefund {
  order_id: string;
  status: string;
  amount_minor: number | string;
  currency: string;
}

export interface CurrencyTotals {
  /** Orders that count: placed and not cancelled. */
  orders: number;
  /** Gross of those orders, minor units. */
  gross_minor: number;
  /** Succeeded refunds against those orders, minor units. */
  refunded_minor: number;
  /** `gross_minor - refunded_minor`, floored at 0 (see the body). */
  net_minor: number;
}

export interface Rollup {
  /** Orders that count, across every currency. */
  orders_count: number;
  /** The store's default currency, and the totals in it — what the CRM contact carries. */
  currency: string;
  net_revenue_minor: number;
  gross_revenue_minor: number;
  refunded_minor: number;
  /** RFC-3339, the newest counting order's `placed_at`; null when there is none. */
  last_order_at: string | null;
  /** Every currency seen, so a store that ever took a second one is visible rather than silently summed. */
  by_currency: Record<string, CurrencyTotals>;
  /** True when orders exist in a currency other than the store's default: the headline is then partial. */
  mixed_currency: boolean;
}

/** `bigint` columns arrive as strings from node-postgres; a total is an integer either way. */
function minor(value: number | string): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (!Number.isFinite(n))
    throw new Error(`rollup: non-numeric minor amount ${JSON.stringify(value)}`);
  return n;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * A cancelled order is not revenue and is not counted — not even as an order. The alternative (count it, net
 * it to zero) would make "orders: 3" mean something different from what anyone reading a CRM contact expects.
 *
 * A refund only counts when the PSP said `succeeded`: a `pending` one may never happen and a `failed` one did
 * not. Window 7 owns that table, and `refund.failed` is an ops alert (#553), not a revenue event.
 *
 * `net_minor` is floored at 0. A refund larger than the order's total should not exist, but goodwill refunds
 * and order edits make it reachable, and a CRM contact showing negative lifetime revenue is worse than one
 * showing zero. The unclamped figures stay in `gross_minor` and `refunded_minor`, so nothing is hidden.
 */
export function computeRollup(
  orders: readonly RollupOrder[],
  refunds: readonly RollupRefund[],
  opts: { defaultCurrency: string },
): Rollup {
  const counting = orders.filter((o) => o.status !== 'cancelled');
  const countingIds = new Set(counting.map((o) => o.id));

  const by: Record<string, CurrencyTotals> = {};
  const bucket = (currency: string): CurrencyTotals =>
    (by[currency] ??= { orders: 0, gross_minor: 0, refunded_minor: 0, net_minor: 0 });

  for (const o of counting) {
    const b = bucket(o.currency);
    b.orders += 1;
    b.gross_minor += minor(o.total_minor);
  }
  for (const r of refunds) {
    // A refund against a cancelled order is not subtracted: that order's revenue was never counted.
    if (r.status !== 'succeeded' || !countingIds.has(r.order_id)) continue;
    bucket(r.currency).refunded_minor += minor(r.amount_minor);
  }
  for (const b of Object.values(by)) {
    b.net_minor = Math.max(0, b.gross_minor - b.refunded_minor);
  }

  const last = counting
    .map((o) => iso(o.placed_at))
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);

  const head = by[opts.defaultCurrency] ?? {
    orders: 0,
    gross_minor: 0,
    refunded_minor: 0,
    net_minor: 0,
  };

  return {
    orders_count: counting.length,
    currency: opts.defaultCurrency,
    net_revenue_minor: head.net_minor,
    gross_revenue_minor: head.gross_minor,
    refunded_minor: head.refunded_minor,
    last_order_at: last ?? null,
    by_currency: by,
    mixed_currency: Object.keys(by).some((c) => c !== opts.defaultCurrency),
  };
}
