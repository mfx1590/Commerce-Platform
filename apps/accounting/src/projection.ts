// The ledger's own projections (accounting_order, accounting_order_line, accounting_payment, accounting_refund) on a
// scoped transaction. Loads lock the order row (FOR UPDATE): two events of one order never interleave their reads.
import type { Queryable } from '@platform/db';
import type { EventEnvelopeV1Base } from '@platform/events';
import type {
  OrderProjection,
  OrderProjectionLine,
  PaymentProjection,
  RefundProjection,
} from './posting/types.js';

interface OrderRow {
  order_id: string;
  organization_id: string;
  store_id: string;
  legal_entity_id: string;
  display_id: number;
  currency: string;
  total_minor: string;
  tax_minor: string;
  goods_net_minor: string;
  shipping_net_minor: string;
  goods_released_minor: string;
  shipping_released: boolean;
  status: 'placed' | 'cancelled';
  placed_at: Date;
  cancelled_at: Date | null;
  source_event_id: string;
}

interface LineRow {
  order_line_item_id: string;
  quantity: number;
  net_minor: string;
  shipped_quantity: number;
  released_minor: string;
}

export async function loadOrderProjection(
  tx: Queryable,
  orderId: string,
): Promise<OrderProjection | null> {
  const r = await tx.query<OrderRow>(
    `SELECT order_id, organization_id, store_id, legal_entity_id, display_id, currency,
            total_minor::text, tax_minor::text, goods_net_minor::text, shipping_net_minor::text,
            goods_released_minor::text, shipping_released, status, placed_at, cancelled_at, source_event_id
       FROM accounting_order WHERE order_id = $1 FOR UPDATE`,
    [orderId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const lines = await tx.query<LineRow>(
    `SELECT order_line_item_id, quantity, net_minor::text, shipped_quantity, released_minor::text
       FROM accounting_order_line WHERE order_id = $1 ORDER BY order_line_item_id`,
    [orderId],
  );
  return {
    order_id: row.order_id,
    organization_id: row.organization_id,
    store_id: row.store_id,
    legal_entity_id: row.legal_entity_id,
    display_id: row.display_id,
    currency: row.currency,
    total_minor: Number(row.total_minor),
    tax_minor: Number(row.tax_minor),
    goods_net_minor: Number(row.goods_net_minor),
    shipping_net_minor: Number(row.shipping_net_minor),
    goods_released_minor: Number(row.goods_released_minor),
    shipping_released: row.shipping_released,
    status: row.status,
    placed_at: row.placed_at.toISOString(),
    cancelled_at: row.cancelled_at ? row.cancelled_at.toISOString() : null,
    source_event_id: row.source_event_id,
    lines: lines.rows.map((l): OrderProjectionLine => ({
      order_line_item_id: l.order_line_item_id,
      quantity: l.quantity,
      net_minor: Number(l.net_minor),
      shipped_quantity: l.shipped_quantity,
      released_minor: Number(l.released_minor),
    })),
  };
}

/** Insert on first sight (order.placed), update the moving parts afterwards. */
export async function saveOrderProjection(tx: Queryable, o: OrderProjection): Promise<void> {
  await tx.query(
    `INSERT INTO accounting_order (order_id, organization_id, store_id, legal_entity_id, display_id, currency,
       total_minor, tax_minor, goods_net_minor, shipping_net_minor, goods_released_minor, shipping_released,
       status, placed_at, cancelled_at, source_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (order_id) DO UPDATE SET
       goods_released_minor = EXCLUDED.goods_released_minor,
       shipping_released = EXCLUDED.shipping_released,
       status = EXCLUDED.status,
       cancelled_at = EXCLUDED.cancelled_at`,
    [
      o.order_id,
      o.organization_id,
      o.store_id,
      o.legal_entity_id,
      o.display_id,
      o.currency,
      o.total_minor,
      o.tax_minor,
      o.goods_net_minor,
      o.shipping_net_minor,
      o.goods_released_minor,
      o.shipping_released,
      o.status,
      o.placed_at,
      o.cancelled_at,
      o.source_event_id,
    ],
  );
  if (o.lines.length === 0) return;
  await tx.query(
    `INSERT INTO accounting_order_line (order_line_item_id, order_id, organization_id, store_id, quantity, net_minor,
       shipped_quantity, released_minor)
     SELECT id, $1, $2, $3, q, n, s, r
       FROM unnest($4::uuid[], $5::int[], $6::bigint[], $7::int[], $8::bigint[]) AS t(id, q, n, s, r)
     ON CONFLICT (order_line_item_id) DO UPDATE SET
       shipped_quantity = EXCLUDED.shipped_quantity,
       released_minor = EXCLUDED.released_minor`,
    [
      o.order_id,
      o.organization_id,
      o.store_id,
      o.lines.map((l) => l.order_line_item_id),
      o.lines.map((l) => l.quantity),
      o.lines.map((l) => l.net_minor),
      o.lines.map((l) => l.shipped_quantity),
      o.lines.map((l) => l.released_minor),
    ],
  );
}

export async function savePaymentProjection(tx: Queryable, p: PaymentProjection): Promise<void> {
  await tx.query(
    `INSERT INTO accounting_payment (payment_id, order_id, organization_id, store_id, legal_entity_id, provider,
       provider_payment_id, amount_minor, fee_minor, currency, captured_at, source_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (payment_id) DO NOTHING`,
    [
      p.payment_id,
      p.order_id,
      p.organization_id,
      p.store_id,
      p.legal_entity_id,
      p.provider,
      p.provider_payment_id,
      p.amount_minor,
      p.fee_minor,
      p.currency,
      p.captured_at,
      p.source_event_id,
    ],
  );
}

export async function saveRefundProjection(tx: Queryable, r: RefundProjection): Promise<void> {
  await tx.query(
    `INSERT INTO accounting_refund (refund_id, payment_id, order_id, organization_id, store_id, legal_entity_id,
       provider_refund_id, amount_minor, currency, reason, issued_at, source_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (refund_id) DO NOTHING`,
    [
      r.refund_id,
      r.payment_id,
      r.order_id,
      r.organization_id,
      r.store_id,
      r.legal_entity_id,
      r.provider_refund_id,
      r.amount_minor,
      r.currency,
      r.reason,
      r.issued_at,
      r.source_event_id,
    ],
  );
}

// ---- parked events -----------------------------------------------------------------------------------------
// A shipment / refund / cancel that arrived before its order.placed waits here (with its processed mark) until the
// order's handler applies it. Rows are the event as published: ids, amounts, hashes — never PII.

export interface ParkedEvent {
  outbox_id: string;
  envelope: EventEnvelopeV1Base;
  occurred_at: string;
}

export async function parkEvent(
  tx: Queryable,
  envelope: EventEnvelopeV1Base,
  outboxId: string,
  orderId: string,
): Promise<void> {
  if (!envelope.store_id)
    throw new TypeError(`${envelope.topic} ${envelope.event_id} has no store_id`);
  await tx.query(
    `INSERT INTO accounting_parked_event (outbox_id, organization_id, store_id, topic, version, order_id, occurred_at, envelope)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (outbox_id) DO NOTHING`,
    [
      outboxId,
      envelope.organization_id,
      envelope.store_id,
      envelope.topic,
      envelope.version,
      orderId,
      envelope.occurred_at,
      JSON.stringify(envelope),
    ],
  );
}

/** The order's parked events in the order the facts happened (ties by arrival), locked for this transaction. */
export async function loadParkedEvents(tx: Queryable, orderId: string): Promise<ParkedEvent[]> {
  const r = await tx.query<{ outbox_id: string; envelope: EventEnvelopeV1Base; occurred_at: Date }>(
    `SELECT outbox_id, envelope, occurred_at FROM accounting_parked_event
      WHERE order_id = $1 ORDER BY occurred_at, parked_at, outbox_id FOR UPDATE`,
    [orderId],
  );
  return r.rows.map((row) => ({
    outbox_id: row.outbox_id,
    envelope: row.envelope,
    occurred_at: row.occurred_at.toISOString(),
  }));
}

export async function deleteParkedEvents(tx: Queryable, orderId: string): Promise<number> {
  const r = await tx.query('DELETE FROM accounting_parked_event WHERE order_id = $1', [orderId]);
  return r.rowCount ?? 0;
}
