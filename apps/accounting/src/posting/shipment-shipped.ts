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
// Amounts come from the ledger's own projection of the order (ADR 0003 item 6), never from core tables. Without a
// projection the event is retried (OrderProjectionMissing) and dead-lettered after the SDK's retries; a shipment of
// more than was ordered, of an unknown line, or of a cancelled order is a producer defect and dead-letters at once.
import type { EventEnvelope } from '@platform/events';
import { ACCOUNT } from '../chart.js';
import {
  OrderProjectionMissingError,
  ShipmentExceedsOrderError,
  ShipmentOfCancelledOrderError,
  UnknownOrderLineError,
} from '../errors.js';
import { dateOf, finalizeEntry, line, proportion } from './balance.js';
import type { JournalEntry, OrderProjection, PostingResult } from './types.js';

export function postShipmentShipped(
  e: EventEnvelope<'shipment.shipped'>,
  order: OrderProjection | null,
): PostingResult {
  const p = e.payload;
  if (!order) throw new OrderProjectionMissingError(p.order_id, e.topic);
  if (order.status === 'cancelled')
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

  const base = {
    entry_date: dateOf(p.shipped_at),
    legal_entity_id: order.legal_entity_id,
    store_id: storeId,
    source_event_id: e.event_id,
    source_topic: e.topic,
    reference_type: 'shipment' as const,
    reference_id: p.shipment_id,
  };
  const entries: JournalEntry[] = [
    finalizeEntry({
      ...base,
      journal: 'sales',
      lines: [
        line(ACCOUNT.CONTRACT_LIABILITY_GOODS, order.currency, release, 'debit'),
        line(ACCOUNT.REVENUE_GOODS, order.currency, release, 'credit'),
        line(ACCOUNT.CONTRACT_LIABILITY_SHIPPING, order.currency, shippingNet, 'debit'),
        line(ACCOUNT.REVENUE_SHIPPING, order.currency, shippingNet, 'credit'),
      ],
    }),
  ];
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
