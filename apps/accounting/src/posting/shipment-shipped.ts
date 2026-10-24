// shipment.shipped → the goods left: the contract liability of the shipped lines becomes revenue, the shipping
// liability becomes revenue with the FIRST shipment of the order, and the carrier's cost is an expense.
//
//   sales (order currency, reference = shipment)
//     Dr 2300 Contract liability goods     Σ release          release of a line = floor(net × shipped_total / qty) − released so far
//     Cr 4000 Revenue goods                Σ release          (the remainder of the division lands on the last units shipped)
//     Dr 2310 Contract liability shipping  shipping net       first shipment only
//     Cr 4010 Revenue shipping             shipping net
//   shipping (shipment currency, reference = shipment)
//     Dr 6000 Shipping cost                cost_minor         when cost_minor is set and > 0
//     Cr 2100 Carrier payable              cost_minor
//
// A shipment that happened BEFORE the order's cancellation but arrives AFTER it (the topics are separate partitions,
// so a later order.cancelled can be consumed first): the cancellation reversed the whole unreleased remainder, so the
// contract liability is already cleared; what the customer owes for the shipped goods is recognised against the
// receivable instead, and the VAT the cancellation reversed too much is charged back —
//     Dr 1200 Accounts receivable          release + shipping net + VAT delta
//     Cr 4000 Revenue goods                release
//     Cr 4010 Revenue shipping             shipping net (first shipment)
//     Cr 2200 VAT payable                  VAT delta = VAT the cancel reversed − VAT it would have reversed knowing this shipment
// — the same ledger as if the two events had arrived in fact order. A shipment dated AT or AFTER the cancellation is a
// producer defect (ShipmentOfCancelledOrder), as are a line shipped beyond its quantity and an unknown line.
//
// Amounts come from the ledger's own projection of the order (ADR 0003 item 6), never from core tables. Without a
// projection this function throws OrderProjectionMissing — the handler never lets that happen: it PARKS such an event
// (accounting_parked_event) and applies it when the order.placed arrives.
import type { EventEnvelope } from '@platform/events';
import { ACCOUNT } from '../chart.js';
import {
  OrderProjectionMissingError,
  ShipmentExceedsOrderError,
  ShipmentOfCancelledOrderError,
  UnknownOrderLineError,
} from '../errors.js';
import { dateOf, finalizeEntry, instantOf, line, proportion } from './balance.js';
import { cancellationVat } from './order-cancelled.js';
import type { JournalEntry, JournalLine, OrderProjection, PostingResult } from './types.js';

export function postShipmentShipped(
  e: EventEnvelope<'shipment.shipped'>,
  order: OrderProjection | null,
): PostingResult {
  const p = e.payload;
  if (!order) throw new OrderProjectionMissingError(p.order_id, e.topic);
  const afterCancel = order.status === 'cancelled';
  if (
    afterCancel &&
    (order.cancelled_at === null || instantOf(p.shipped_at) >= instantOf(order.cancelled_at))
  )
    throw new ShipmentOfCancelledOrderError(order.order_id, p.shipment_id);
  const storeId = e.store_id ?? order.store_id;

  const lines = order.lines.map((l) => ({ ...l }));
  let release = 0;
  for (const item of p.items) {
    const l = lines.find((x) => x.order_line_item_id === item.order_line_item_id);
    if (!l) throw new UnknownOrderLineError(order.order_id, item.order_line_item_id);
    const shipped = l.shipped_quantity + item.quantity;
    if (shipped > l.quantity)
      throw new ShipmentExceedsOrderError(l.order_line_item_id, shipped, l.quantity);
    const cumulative = proportion(l.net_minor, shipped, l.quantity);
    release += cumulative - l.released_minor;
    l.shipped_quantity = shipped;
    l.released_minor = cumulative;
  }
  const releaseShipping = !order.shipping_released;
  const shippingNet = releaseShipping ? order.shipping_net_minor : 0;
  const cur = order.currency;

  let salesLines: (JournalLine | null)[];
  if (!afterCancel) {
    salesLines = [
      line(ACCOUNT.CONTRACT_LIABILITY_GOODS, cur, release, 'debit'),
      line(ACCOUNT.REVENUE_GOODS, cur, release, 'credit'),
      line(ACCOUNT.CONTRACT_LIABILITY_SHIPPING, cur, shippingNet, 'debit'),
      line(ACCOUNT.REVENUE_SHIPPING, cur, shippingNet, 'credit'),
    ];
  } else {
    // the cancel cleared the liability for the then-unreleased remainder; recognise the shipped part against the
    // receivable and give back the VAT the cancel reversed for it
    const remainingBefore =
      order.goods_net_minor -
      order.goods_released_minor +
      (order.shipping_released ? 0 : order.shipping_net_minor);
    const remainingAfter = remainingBefore - release - shippingNet;
    const vatDelta =
      cancellationVat(order, remainingBefore) - cancellationVat(order, remainingAfter, true);
    salesLines = [
      line(ACCOUNT.RECEIVABLE, cur, release + shippingNet + vatDelta, 'debit'),
      line(ACCOUNT.REVENUE_GOODS, cur, release, 'credit'),
      line(ACCOUNT.REVENUE_SHIPPING, cur, shippingNet, 'credit'),
      line(ACCOUNT.VAT_PAYABLE, cur, vatDelta, 'credit'),
    ];
  }

  const base = {
    entry_date: dateOf(p.shipped_at),
    legal_entity_id: order.legal_entity_id,
    store_id: storeId,
    source_event_id: e.event_id,
    source_topic: e.topic,
    reference_type: 'shipment' as const,
    reference_id: p.shipment_id,
  };
  const entries: JournalEntry[] = [finalizeEntry({ ...base, journal: 'sales', lines: salesLines })];
  const cost = p.cost_minor ?? 0;
  if (cost > 0) {
    entries.push(
      finalizeEntry({
        ...base,
        journal: 'shipping',
        lines: [
          line(ACCOUNT.SHIPPING_COST, p.currency, cost, 'debit'),
          line(ACCOUNT.CARRIER_PAYABLE, p.currency, cost, 'credit'),
        ],
      }),
    );
  }

  return {
    entries,
    order: {
      ...order,
      lines,
      goods_released_minor: order.goods_released_minor + release,
      shipping_released: true,
    },
  };
}
