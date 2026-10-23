// Assembling the support context from what the Admin API answered (#556).
//
// The normalisation is pure, so every shape the contract allows is a unit test: `total` arrives as a number or
// a bigint string depending on the route, timestamps may be null, and the embedded payment/shipment arrays may
// be absent on an older response. None of that should reach an agent as `undefined` or `NaN`.
//
// A partial answer is NEVER silently partial: an order whose detail could not be read still appears, from its
// summary, with a note saying what is missing. An agent told "3 orders" when there are 4 would give a customer
// wrong information, which is worse than a visible gap.

import type { RawCustomer, RawOrderDetail, RawOrderSummary, SupportReader } from './admin-api.js';
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

/** `total` is a number on one route and a bigint string on another; both are integer minor units. */
function minor(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return 0;
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

function paymentsOf(raw: unknown[] | undefined): SupportPayment[] {
  return (raw ?? []).map((p) => {
    const r = p as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      provider: String(r.provider ?? ''),
      status: String(r.status ?? ''),
      amount_minor: minor(r.amount_minor ?? r.amount),
      currency: String(r.currency ?? ''),
    };
  });
}

function refundsOf(raw: unknown[] | undefined): SupportRefund[] {
  return (raw ?? []).map((p) => {
    const r = p as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      status: String(r.status ?? ''),
      amount_minor: minor(r.amount_minor ?? r.amount),
      currency: String(r.currency ?? ''),
      reason: str(r.reason),
    };
  });
}

function shipmentsOf(raw: unknown[] | undefined): SupportShipment[] {
  return (raw ?? []).map((p) => {
    const r = p as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      status: String(r.status ?? ''),
      carrier: str(r.carrier),
      // The one place a tracking number is legitimate: it is what the customer is asking about.
      tracking_number: str(r.tracking_number),
      shipped_at: str(r.shipped_at),
      delivered_at: str(r.delivered_at),
    };
  });
}

function returnsOf(raw: unknown[] | undefined): SupportReturn[] {
  return (raw ?? []).map((p) => {
    const r = p as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      status: String(r.status ?? ''),
      requested_at: str(r.requested_at),
    };
  });
}

function orderOf(summary: RawOrderSummary, detail: RawOrderDetail | null): SupportOrder {
  const d = detail ?? summary;
  return {
    id: d.id,
    display_id: typeof d.display_id === 'number' ? d.display_id : 0,
    status: String(d.status ?? ''),
    payment_status: String(d.payment_status ?? ''),
    fulfillment_status: String(d.fulfillment_status ?? ''),
    total_minor: minor(d.total_minor ?? d.total),
    currency: String(d.currency ?? summary.currency ?? ''),
    placed_at: str(d.placed_at),
    payments: paymentsOf((detail as RawOrderDetail | null)?.payments),
    refunds: refundsOf((detail as RawOrderDetail | null)?.refunds),
    shipments: shipmentsOf((detail as RawOrderDetail | null)?.shipments),
    returns: returnsOf((detail as RawOrderDetail | null)?.returns),
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
 * The whole answer. Throws `SupportError(404)` when the customer is not in this store — which is also the
 * answer for a customer of another store, so the API cannot be used to discover that an id exists elsewhere.
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
