/**
 * Bulk capture (#870 wave 1 item 2, the money part — its own PR). Pure: which payment of an order
 * is captured, for how much, and the per-currency totals the preview shows. No React, no `next/*`.
 *
 * Rules (manager decisions 11-13 / 11-18):
 * - ticked rows only, at most `BULK_CAPTURE_CAP`; never "all matching";
 * - the order's ONE authorised payment; anything else is not captured here (said per row);
 * - the amount is the order's CURRENT total, capped at the authorisation — an order edited down
 *   after placement captures only what it now costs (a partial capture); no amount override;
 * - only a Stripe authorisation is captured (any other provider has nothing to capture);
 * - every amount the person confirmed is re-checked on the server just before the call: a row
 *   whose amount changed since the preview is not captured.
 */

import type { AdminComponents } from '../api/admin-client';
import { formatMoney } from '../forms/money';

type Order = AdminComponents['Order'];

/** The most orders one bulk capture takes. */
export const BULK_CAPTURE_CAP = 100;

export type CapturePlan =
  | {
      capturable: true;
      paymentId: string;
      /** What will be captured, in minor units of `currency`. */
      amountMinor: number;
      currency: string;
      authorizedMinor: number;
      /** Less than the authorisation (the order total is lower now). The amount is always sent. */
      partial: boolean;
    }
  | { capturable: false; alreadyCaptured: boolean; reason: string };

export function planCapture(
  order: Pick<Order, 'payments' | 'total' | 'payment_status'>,
  locale = 'en-GB',
): CapturePlan {
  const authorized = order.payments.filter((payment) => payment.status === 'authorized');
  if (authorized.length === 0) {
    const captured = order.payments.some((payment) => payment.status === 'captured');
    return captured
      ? { capturable: false, alreadyCaptured: true, reason: 'Already captured.' }
      : {
          capturable: false,
          alreadyCaptured: false,
          reason: `No authorised payment to capture (payment ${order.payment_status}).`,
        };
  }
  if (authorized.length > 1) {
    return {
      capturable: false,
      alreadyCaptured: false,
      reason: `${authorized.length} authorised payments: capture them one by one on the order page.`,
    };
  }
  const payment = authorized[0]!;
  // Only a Stripe authorisation has anything to capture (#913 review): the core answers 422 for any
  // other provider, so it is said here and left out of the totals rather than sent.
  if (payment.provider !== 'stripe') {
    return {
      capturable: false,
      alreadyCaptured: false,
      reason: `Paid through the ${payment.provider} provider: there is nothing to capture here.`,
    };
  }
  const authorizedMinor = payment.amount.amount_minor;
  if (payment.amount.currency !== order.total.currency) {
    return {
      capturable: false,
      alreadyCaptured: false,
      reason: `The payment is in ${payment.amount.currency} and the order in ${order.total.currency}: capture it on the order page.`,
    };
  }
  const totalMinor = order.total.amount_minor;
  if (totalMinor < 1) {
    return {
      capturable: false,
      alreadyCaptured: false,
      reason: `Nothing to capture: the order total is ${formatMoney(totalMinor, order.total.currency, locale)}.`,
    };
  }
  const amountMinor = Math.min(totalMinor, authorizedMinor);
  return {
    capturable: true,
    paymentId: payment.id,
    amountMinor,
    currency: payment.amount.currency,
    authorizedMinor,
    partial: amountMinor < authorizedMinor,
  };
}

/** Minor units per currency, never summed across currencies. */
export function totalsByCurrency(
  rows: readonly { amountMinor: number; currency: string }[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.currency] = (totals[row.currency] ?? 0) + row.amountMinor;
  return totals;
}

/** "¥120,000 · €45.50", currencies in alphabetical order, each formatted with its own decimals. */
export function describeTotals(totals: Readonly<Record<string, number>>, locale = 'en-GB'): string {
  return Object.keys(totals)
    .sort()
    .map((currency) => formatMoney(totals[currency]!, currency, locale))
    .join(' · ');
}

/** What a capture's row says: the amount, and why it is partial when it is. */
export function capturedMessage(
  plan: Extract<CapturePlan, { capturable: true }>,
  locale = 'en-GB',
): string {
  const amount = formatMoney(plan.amountMinor, plan.currency, locale);
  return plan.partial
    ? `Captured ${amount} of the ${formatMoney(plan.authorizedMinor, plan.currency, locale)} authorised (the order total is lower now).`
    : `Captured ${amount}.`;
}
