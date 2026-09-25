/**
 * One timeline from an order's payments, refunds, shipments and returns.
 *
 * The contract stores each of those as its own list with its own timestamps; the screen wants one
 * story in time order. Pure: a list of entries with a time, a kind and a label, sorted oldest
 * first, undated entries last (a planned shipment has no `shipped_at` yet but still belongs on the
 * timeline).
 */

import type { AdminComponents } from '../api/admin-client';

type Order = AdminComponents['Order'];

export type TimelineKind = 'order' | 'payment' | 'refund' | 'shipment' | 'return';

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  at: string | null;
  title: string;
  /** Short detail line, e.g. the amount or the carrier. Money is pre-formatted by the caller. */
  detail?: string;
  /** Contract status value, for the pill. */
  status?: string;
}

export function orderTimeline(
  order: Order,
  money: (amountMinor: number, currency: string) => string,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      id: `order-${order.id}`,
      kind: 'order',
      at: order.placed_at,
      title: `Order #${order.display_id} placed`,
      detail: money(order.total.amount_minor, order.total.currency),
      status: order.status,
    },
  ];

  for (const payment of order.payments) {
    entries.push({
      id: `payment-${payment.id}`,
      kind: 'payment',
      at: payment.captured_at,
      title: payment.status === 'captured' ? 'Payment captured' : `Payment ${payment.status}`,
      detail: `${money(payment.amount.amount_minor, payment.amount.currency)} · ${payment.provider}`,
      status: payment.status,
    });
  }

  for (const refund of order.refunds) {
    entries.push({
      id: `refund-${refund.id}`,
      kind: 'refund',
      at: refund.created_at,
      title: `Refund ${refund.status}`,
      detail: `${money(refund.amount.amount_minor, refund.amount.currency)} · ${refund.reason}`,
      status: refund.status,
    });
  }

  for (const shipment of order.shipments) {
    const units = shipment.items.reduce((sum, item) => sum + item.quantity, 0);
    entries.push({
      id: `shipment-${shipment.id}`,
      kind: 'shipment',
      at: shipment.delivered_at ?? shipment.shipped_at,
      title: `Shipment ${shipment.status}`,
      detail: `${units} unit${units === 1 ? '' : 's'} · ${shipment.carrier}${
        shipment.tracking_number === null ? '' : ` · ${shipment.tracking_number}`
      }`,
      status: shipment.status,
    });
  }

  for (const ret of order.returns) {
    const units = ret.items.reduce((sum, item) => sum + item.quantity, 0);
    entries.push({
      id: `return-${ret.id}`,
      kind: 'return',
      at: ret.received_at ?? ret.requested_at,
      title: `Return ${ret.status}`,
      detail: `${units} unit${units === 1 ? '' : 's'}${ret.reason === null ? '' : ` · ${ret.reason}`}`,
      status: ret.status,
    });
  }

  if (order.cancel_reason !== null) {
    entries.push({
      id: `cancelled-${order.id}`,
      kind: 'order',
      at: null,
      title: 'Order cancelled',
      detail: order.cancel_reason,
      status: 'cancelled',
    });
  }

  return entries.sort(byTime);
}

function byTime(a: TimelineEntry, b: TimelineEntry): number {
  if (a.at === null && b.at === null) return 0;
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}
