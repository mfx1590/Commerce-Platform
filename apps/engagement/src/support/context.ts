// Assembling the support context from what the Admin API answered (#556).
//
// The normalisation reads the CONTRACT's shapes (`admin-api.ts` types them from `@platform/contracts/admin`),
// so this file deals in `Money { amount_minor, currency }` rather than guessed scalars. The first version
// guessed, and read `total` as a number and `currency` off the top level of an `OrderSummary` that has
// neither — against the real core every order would have shown 0 and an empty currency (#573 review).
//
// It stays pure, so every shape the contract allows is a unit test.
//
// A partial answer is NEVER silently partial: an order whose detail could not be read still appears, from its
// summary, with a note saying what is missing. An agent told "3 orders" when there are 4 would give a customer
// wrong information, which is worse than a visible gap.

import type {
  RawCustomer,
  RawMoney,
  RawOrderDetail,
  RawOrderSummary,
  SupportReader,
} from './admin-api.js';
import { SupportError } from './types.js';
import type {
  SupportContext,
  SupportCustomer,
  SupportOrder,
  SupportPayment,
  SupportRefund,
  SupportReturn,
  SupportShipment,
} from './types.js';

/** `Money.amount_minor` is an integer by contract; be defensive about a string anyway (bigint columns). */
function amountOf(money: RawMoney | undefined | null): { minor: number; currency: string } {
  if (!money) return { minor: 0, currency: '' };
  const raw = money.amount_minor as unknown;
  const minor =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.trunc(raw)
      : typeof raw === 'string' && Number.isFinite(Number.parseInt(raw, 10))
        ? Number.parseInt(raw, 10)
        : 0;
  return { minor, currency: typeof money.currency === 'string' ? money.currency : '' };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function customerOf(raw: RawCustomer): SupportCustomer {
  return {
    id: raw.id,
    email: raw.email,
    first_name: raw.first_name ?? null,
    last_name: raw.last_name ?? null,
    status: raw.status,
    created_at: str(raw.created_at),
  };
}

function paymentsOf(raw: RawOrderDetail['payments'] | undefined): SupportPayment[] {
  return (raw ?? []).map((p) => {
    const amount = amountOf(p.amount);
    return {
      id: p.id,
      provider: p.provider,
      status: p.status,
      amount_minor: amount.minor,
      currency: amount.currency,
    };
  });
}

function refundsOf(raw: RawOrderDetail['refunds'] | undefined): SupportRefund[] {
  return (raw ?? []).map((r) => {
    const amount = amountOf(r.amount);
    return {
      id: r.id,
      status: r.status,
      amount_minor: amount.minor,
      currency: amount.currency,
      reason: str(r.reason),
    };
  });
}

function shipmentsOf(raw: RawOrderDetail['shipments'] | undefined): SupportShipment[] {
  return (raw ?? []).map((s) => ({
    id: s.id,
    status: s.status,
    carrier: str(s.carrier),
    // The one place a tracking number is legitimate: it is what the customer is asking about.
    tracking_number: str(s.tracking_number),
    shipped_at: str(s.shipped_at),
    delivered_at: str(s.delivered_at),
  }));
}

function returnsOf(raw: RawOrderDetail['returns'] | undefined): SupportReturn[] {
  return (raw ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    requested_at: str(r.requested_at),
  }));
}

/**
 * One order. `total` is `Money` on both the summary and the detail (the detail inherits it), so the amount and
 * the currency come from there; the detail's own top-level `currency` is the fallback.
 */
function orderOf(summary: RawOrderSummary, detail: RawOrderDetail | null): SupportOrder {
  const d = detail ?? summary;
  const total = amountOf(d.total ?? summary.total);
  const detailCurrency = detail ? str((detail as { currency?: string }).currency) : null;
  return {
    id: d.id,
    display_id: typeof d.display_id === 'number' ? d.display_id : 0,
    status: d.status,
    payment_status: d.payment_status,
    fulfillment_status: d.fulfillment_status,
    total_minor: total.minor,
    currency: total.currency || detailCurrency || '',
    placed_at: str(d.placed_at),
    payments: paymentsOf(detail?.payments),
    refunds: refundsOf(detail?.refunds),
    shipments: shipmentsOf(detail?.shipments),
    returns: returnsOf(detail?.returns),
  };
}

const COUNTS = (status: string): boolean => status !== 'cancelled';

/** The glance summary. Same currency rule as the CRM rollup: the store's own, others flagged not summed. */
export function summarise(
  orders: readonly SupportOrder[],
  defaultCurrency: string,
): SupportContext['summary'] {
  const counting = orders.filter((o) => COUNTS(o.status));
  const home = counting.filter((o) => o.currency === defaultCurrency);
  const gross = home.reduce((n, o) => n + o.total_minor, 0);
  const refunded = home.reduce(
    (n, o) =>
      n + o.refunds.filter((r) => r.status === 'succeeded').reduce((m, r) => m + r.amount_minor, 0),
    0,
  );
  const last = counting
    .map((o) => o.placed_at)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);

  return {
    orders_count: counting.length,
    open_orders: counting.filter((o) => o.status !== 'completed').length,
    cancelled_orders: orders.length - counting.length,
    currency: defaultCurrency,
    gross_minor: gross,
    refunded_minor: refunded,
    last_order_at: last ?? null,
    mixed_currency: counting.some((o) => o.currency !== '' && o.currency !== defaultCurrency),
  };
}

export interface BuildContextOptions {
  reader: SupportReader;
  storeId: string;
  storeCode: string;
  defaultCurrency: string;
  customerId: string;
  /** The agent's own header, forwarded to every read. */
  authorization: string;
}

/**
 * The whole answer. Throws `SupportError(404)` when the customer is not in this store — which is also what a
 * core 403 for a foreign customer becomes, so the API cannot be used to discover that an id exists elsewhere.
 */
export async function buildContext(opts: BuildContextOptions): Promise<SupportContext> {
  const raw = await opts.reader.getCustomer(opts.storeId, opts.customerId, opts.authorization);
  if (!raw) throw new SupportError(404, 'not_found', 'No such customer in this store');

  const summaries = await opts.reader.listOrders(opts.storeId, opts.customerId, opts.authorization);
  const notes: string[] = [];
  const orders: SupportOrder[] = [];

  for (const summary of summaries) {
    let detail: RawOrderDetail | null = null;
    try {
      detail = await opts.reader.getOrder(opts.storeId, summary.id, opts.authorization);
    } catch (err) {
      // One unreadable order must not cost the agent the whole history — but it is never silent.
      if (err instanceof SupportError && (err.status === 401 || err.status === 403)) throw err;
      notes.push(`order ${summary.display_id}: details could not be read`);
    }
    if (detail === null && notes.at(-1)?.startsWith(`order ${summary.display_id}:`) !== true) {
      notes.push(`order ${summary.display_id}: details are no longer available`);
    }
    orders.push(orderOf(summary, detail));
  }

  return {
    store_code: opts.storeCode,
    customer: customerOf(raw),
    orders,
    summary: summarise(orders, opts.defaultCurrency),
    notes,
  };
}
