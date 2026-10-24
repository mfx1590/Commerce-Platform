// order.cancelled → whatever of the placed entry has NOT been released yet is reversed (manager decision item 3:
// "reverses an unshipped order's placed entry"; a partially shipped order keeps the revenue of what left).
//
//   sales (order currency, reference = order)
//     Dr 2300 Contract liability goods     goods net − goods released
//     Dr 2310 Contract liability shipping  shipping net                      unless already released
//     Dr 2200 VAT payable                  round-half-up(tax × unreleased / (goods net + shipping net))   (= tax when nothing shipped)
//     Cr 1200 Accounts receivable          the sum
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

/** The VAT a cancellation reverses for a given unreleased remainder: the order's tax in that proportion. */
export function cancellationVat(order: OrderProjection, remaining: number): number {
  const base = order.goods_net_minor + order.shipping_net_minor;
  if (base > 0) return roundShare(order.tax_minor, remaining, base);
  return remaining === 0 && (order.goods_released_minor > 0 || order.shipping_released)
    ? 0
    : order.tax_minor;
}

export function postOrderCancelled(
  e: EventEnvelope<'order.cancelled'>,
  order: OrderProjection | null,
): PostingResult {
  const p = e.payload;
  if (!order) throw new OrderProjectionMissingError(p.order_id, e.topic);
  if (order.status === 'cancelled') return { entries: [], order };

  const goodsRemaining = order.goods_net_minor - order.goods_released_minor;
  const shippingRemaining = order.shipping_released ? 0 : order.shipping_net_minor;
  const vat = cancellationVat(order, goodsRemaining + shippingRemaining);
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
      line(ACCOUNT.CONTRACT_LIABILITY_GOODS, cur, goodsRemaining, 'debit'),
      line(ACCOUNT.CONTRACT_LIABILITY_SHIPPING, cur, shippingRemaining, 'debit'),
      line(ACCOUNT.VAT_PAYABLE, cur, vat, 'debit'),
      line(ACCOUNT.RECEIVABLE, cur, goodsRemaining + shippingRemaining + vat, 'credit'),
    ],
  });
  return {
    entries: [entry],
    order: { ...order, status: 'cancelled', cancelled_at: p.cancelled_at },
  };
}
