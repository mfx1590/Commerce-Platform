// What a reply draft is allowed to know (#610).
//
// THE WHOLE POINT OF THIS FILE: the support context (#556) carries an e-mail, a first and last name, and
// every order's tracking number. None of that may reach the AI gateway, and the gateway's denylist is a KEY
// guard — it would catch `email` but not a name smuggled inside some other field. So the draft is built from
// a separate, minimal projection whose TYPE cannot carry a denied field, rather than from the context with
// the sensitive parts remembered-and-removed at the call site.
//
// What is left out, and why each one:
//   * the e-mail, the name, any address or phone — a draft does not need them (the agent types the greeting),
//     and they are denylisted anyway;
//   * the TRACKING NUMBER — it identifies a parcel at a carrier. "Shipped with DHL on the 3rd" is the useful
//     part, and an agent can paste the number themselves. Same reasoning as the CDP's (#554).
//   * every UUID (customer id, order id, payment id) — nothing in a reply needs one, and they are the join
//     keys to everything else we hold;
//   * the context's `notes` — they are about OUR read failures, not about the customer;
//   * `ordersCount` / `lastOrderAt` — tone only, dropped on the manager's decision (2026-11-01) to keep what
//     is sent to the minimum. Tone comes from the brand voice.
//
// Money is FORMATTED here rather than sent as minor units: a model given `1299` and `EUR` has to divide by a
// hundred to write a sentence, and it has no way to know that JPY does not work that way. `Intl` knows, this
// is deterministic, and a customer-facing draft is the wrong place to let a model do arithmetic.

import type { SupportContext, SupportOrder } from './types.js';

/**
 * Exactly the variables `support-reply-draft@1` declares (REQUEST #667). All strings: a template variable is
 * text, and an absent fact is the empty string rather than `null`, so a missing value drops the claim
 * instead of rendering as "null".
 */
export interface DraftVariables {
  question: string;
  storeCode: string;
  brandVoice: string;
  locale: string;
  orderRef: string;
  orderStatus: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  placedAt: string;
  shippedAt: string;
  deliveredAt: string;
  carrier: string;
  total: string;
  refundStatus: string;
  refunded: string;
  returnStatus: string;
  returnRequestedAt: string;
}

export interface DraftContextOptions {
  context: SupportContext;
  /** The customer's message, as the agent has it. UNTRUSTED text: the gateway redacts it, the template treats it as data. */
  question: string;
  /** Which order the question is about. Default: the most recent one. */
  orderId?: string | undefined;
  /** The language the draft must be written in. */
  locale: string;
  brandVoice: string;
}

/** A date as a plain day, which is what a reply says ("shipped on 2026-11-01"), never a timestamp. */
function day(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * Minor units to the words a human writes. `Intl` supplies the currency's own number of decimals, so JPY
 * (zero) and EUR (two) both come out right without a table of our own.
 */
export function formatMoney(minor: number, currency: string, locale: string): string {
  if (!Number.isFinite(minor) || !currency) return '';
  try {
    const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minor / 10 ** digits);
  } catch {
    // An unknown locale or currency must not break a draft: fall back to the plainest true statement.
    return `${minor} ${currency} (minor units)`;
  }
}

/** The order the question is about: the one asked for, else the most recent. */
export function pickOrder(
  orders: readonly SupportOrder[],
  orderId?: string | undefined,
): SupportOrder | null {
  if (orders.length === 0) return null;
  if (orderId) return orders.find((o) => o.id === orderId) ?? null;
  const sorted = [...orders].sort((a, b) => (b.placed_at ?? '').localeCompare(a.placed_at ?? ''));
  return sorted[0] ?? null;
}

/**
 * The support context plus the agent's question, reduced to what a draft may know. Returns `null` when the
 * question is about an order we cannot find: a draft with no order facts would be the model guessing, and an
 * agent is better served by "no" than by a plausible paragraph.
 */
export function toDraftVariables(opts: DraftContextOptions): DraftVariables | null {
  const order = pickOrder(opts.context.orders, opts.orderId);
  if (!order) return null;

  // The newest of each, which is what a customer is asking about.
  const shipment = [...order.shipments].sort((a, b) =>
    (b.shipped_at ?? '').localeCompare(a.shipped_at ?? ''),
  )[0];
  const refund = [...order.refunds].sort((a, b) => b.amount_minor - a.amount_minor)[0];
  const ret = [...order.returns].sort((a, b) =>
    (b.requested_at ?? '').localeCompare(a.requested_at ?? ''),
  )[0];

  return {
    question: opts.question,
    storeCode: opts.context.store_code,
    brandVoice: opts.brandVoice,
    locale: opts.locale,
    orderRef: String(order.display_id),
    orderStatus: order.status,
    paymentStatus: order.payment_status,
    fulfillmentStatus: order.fulfillment_status,
    placedAt: day(order.placed_at),
    shippedAt: day(shipment?.shipped_at),
    deliveredAt: day(shipment?.delivered_at),
    carrier: shipment?.carrier ?? '',
    total: formatMoney(order.total_minor, order.currency, opts.locale),
    refundStatus: refund?.status ?? '',
    refunded: refund ? formatMoney(refund.amount_minor, refund.currency, opts.locale) : '',
    returnStatus: ret?.status ?? '',
    returnRequestedAt: day(ret?.requested_at),
  };
}
