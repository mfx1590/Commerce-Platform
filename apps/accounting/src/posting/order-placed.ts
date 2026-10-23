// order.placed → the sale is RECOGNISED AS A LIABILITY, not as revenue (manager decision 2026-10-23, item 3: revenue at
// shipment). The customer owes the gross total; we owe the goods and the shipping (contract liability) and the VAT.
//
//   Dr 1200 Accounts receivable        totals.total_minor
//   Cr 2300 Contract liability goods   Σ line (total_minor − tax_minor)
//   Cr 2310 Contract liability shipping  totals.total_minor − totals.tax_minor − Σ line net
//   Cr 2200 VAT payable                totals.tax_minor
//
// Line net = total − tax holds in both price modes (exclusive: total = sub − disc + tax; inclusive: total = sub − disc
// with the tax inside), and the shipping line is defined as the remainder, so the entry balances by construction and
// a rounding difference between the lines and the totals can only ever land in 2310 — never unbalance the books.
import type { EventEnvelope } from '@platform/events';
import { ACCOUNT } from '../chart.js';
import { dateOf, finalizeEntry, line, sum } from './balance.js';
import type { OrderProjection, PostingResult } from './types.js';

export function postOrderPlaced(e: EventEnvelope<'order.placed'>): PostingResult {
  const p = e.payload;
  const storeId = e.store_id;
  if (!storeId) throw new TypeError(`order.placed ${e.event_id} has no store_id`);
  const lines = p.line_items.map((l) => ({
    order_line_item_id: l.order_line_item_id,
    quantity: l.quantity,
    net_minor: l.total_minor - l.tax_minor,
    shipped_quantity: 0,
    released_minor: 0,
  }));
  const goodsNet = sum(lines.map((l) => l.net_minor));
  const shippingNet = p.totals.total_minor - p.totals.tax_minor - goodsNet;
  const cur = p.currency;

  const entry = finalizeEntry({
    journal: 'sales',
    entry_date: dateOf(p.placed_at),
    legal_entity_id: p.legal_entity_id,
    store_id: storeId,
    source_event_id: e.event_id,
    source_topic: e.topic,
    reference_type: 'order',
    reference_id: p.order_id,
    lines: [
      line(ACCOUNT.RECEIVABLE, cur, p.totals.total_minor, 'debit'),
      line(ACCOUNT.CONTRACT_LIABILITY_GOODS, cur, goodsNet, 'credit'),
      line(ACCOUNT.CONTRACT_LIABILITY_SHIPPING, cur, shippingNet, 'credit'),
      line(ACCOUNT.VAT_PAYABLE, cur, p.totals.tax_minor, 'credit'),
    ],
  });

  const order: OrderProjection = {
    order_id: p.order_id,
    organization_id: e.organization_id,
    store_id: storeId,
    legal_entity_id: p.legal_entity_id,
    display_id: p.display_id,
    currency: cur,
    total_minor: p.totals.total_minor,
    tax_minor: p.totals.tax_minor,
    goods_net_minor: goodsNet,
    shipping_net_minor: shippingNet,
    goods_released_minor: 0,
    shipping_released: false,
    status: 'placed',
    placed_at: p.placed_at,
    cancelled_at: null,
    source_event_id: e.event_id,
    lines,
  };
  return { entries: [entry], order };
}
