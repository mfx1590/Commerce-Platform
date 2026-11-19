// order.cancelled → whatever of the placed entry has NOT been released yet is reversed (manager decision item 3:
// "reverses an unshipped order's placed entry"; a partially shipped order keeps the revenue of what left).
//
//   sales (order currency, reference = order)
//     Dr 2300 Contract liability goods     goods net − goods released
//     Dr 2310 Contract liability shipping  shipping net                      unless already released
//     Dr 2200 VAT payable                  round-half-up(tax × unreleased / (goods net + shipping net)) − O tax
//     Cr 4090 Refunds and allowances       O net                                                  (#919)
//     Cr 1200 Accounts receivable          the rest (the unreleased total − O)
//
// O (#919) = the part of the order's earlier refunds (return / goodwill / chargeback, as posted to 4090 and 2200) that
// exceeds the value of what had shipped: a refund the cancellation now covers. Those refunds already reversed that
// VAT and booked that amount as an allowance; without O the cancel reversed the VAT a second time and credited the
// receivable for money the customer already had back (1200 ended at −refund). O's VAT is the refunds' own VAT in
// proportion (exact when every refund is covered); a refund of shipped goods (O = 0) is a real allowance and stays.
//
// Amounts come from the projection; the event's `totals` are not used (an edited order's totals describe the order,
// the projection describes what the ledger holds). A second cancel of a cancelled order posts nothing. The projection
// keeps the amounts actually released (it does NOT mark everything released): a shipment that happened BEFORE the
// cancellation but arrives after it (the topics are separate partitions) is recognised by shipment-shipped.ts from
// those numbers.
import type { EventEnvelope } from '@platform/events';
import { ACCOUNT } from '../chart.js';
import { OrderProjectionMissingError } from '../errors.js';
import { dateOf, finalizeEntry, line, roundShare } from './balance.js';
import type { OrderProjection, PostingResult } from './types.js';

/**
 * The VAT a cancellation reverses for a given unreleased remainder: the order's tax in that proportion. With a zero
 * base (every net 0, tax > 0) there is no proportion: the tax is reversed when nothing has shipped and kept once
 * anything has. `shipped` defaults to the projection's state (the first shipment sets `shipping_released`); the late
 * shipment passes `true` for the after-state, so both arrival orders net the same VAT (#589 nit).
 */
export function cancellationVat(
  order: OrderProjection,
  remaining: number,
  shipped: boolean = order.shipping_released,
): number {
  const base = order.goods_net_minor + order.shipping_net_minor;
  if (base > 0) return roundShare(order.tax_minor, remaining, base);
  return shipped ? 0 : order.tax_minor;
}

/** The part of the placed entry not yet released: goods and shipping net, and their VAT (#919 helper). */
export function unreleasedOf(
  order: OrderProjection,
  shipped: boolean = order.shipping_released,
): { goods: number; shipping: number; net: number; tax: number; total: number } {
  const goods = order.goods_net_minor - order.goods_released_minor;
  const shipping = order.shipping_released ? 0 : order.shipping_net_minor;
  const tax = cancellationVat(order, goods + shipping, shipped);
  return { goods, shipping, net: goods + shipping, tax, total: goods + shipping + tax };
}

/** The value of what has shipped, VAT included: the order total minus the unreleased part. */
export function shippedValueOf(order: OrderProjection): number {
  return Math.max(order.total_minor - unreleasedOf(order).total, 0);
}

/**
 * #919: the part O of the order's earlier refunds that the cancellation covers — what they reversed beyond the shipped
 * value, capped at the unreleased total — with its VAT (the refunds' own VAT in proportion) and its net.
 */
export function refundOverlapOf(order: OrderProjection): {
  total: number;
  tax: number;
  net: number;
} {
  const refunded = order.refunded_net_minor + order.refunded_tax_minor;
  if (refunded <= 0) return { total: 0, tax: 0, net: 0 };
  const u = unreleasedOf(order);
  const total = Math.min(Math.max(refunded - shippedValueOf(order), 0), u.total);
  const tax = Math.min(roundShare(order.refunded_tax_minor, total, refunded), u.tax, total);
  return { total, tax, net: total - tax };
}

export function postOrderCancelled(
  e: EventEnvelope<'order.cancelled'>,
  order: OrderProjection | null,
): PostingResult {
  const p = e.payload;
  if (!order) throw new OrderProjectionMissingError(p.order_id, e.topic);
  if (order.status === 'cancelled') return { entries: [], order };

  const u = unreleasedOf(order);
  const o = refundOverlapOf(order);
  const cur = order.currency;

  const entry = finalizeEntry({
    journal: 'sales',
    entry_date: dateOf(p.cancelled_at),
    legal_entity_id: order.legal_entity_id,
    store_id: e.store_id ?? order.store_id,
    source_event_id: e.event_id,
    source_topic: e.topic,
    reference_type: 'order',
    reference_id: p.order_id,
    lines: [
      line(ACCOUNT.CONTRACT_LIABILITY_GOODS, cur, u.goods, 'debit'),
      line(ACCOUNT.CONTRACT_LIABILITY_SHIPPING, cur, u.shipping, 'debit'),
      line(ACCOUNT.VAT_PAYABLE, cur, u.tax - o.tax, 'debit'),
      line(ACCOUNT.REFUNDS, cur, o.net, 'credit'),
      line(ACCOUNT.RECEIVABLE, cur, u.total - o.total, 'credit'),
    ],
  });
  return {
    entries: [entry],
    order: { ...order, status: 'cancelled', cancelled_at: p.cancelled_at },
  };
}
