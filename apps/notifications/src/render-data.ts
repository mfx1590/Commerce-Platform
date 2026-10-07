// What an email is rendered FROM: the database rows, read at send time (#360).
//
// The outbox payload is never the record source — the same rule as the search sync. `order.placed` carries
// `email_hash`, not the address, and the line items as they were at placement; the `"order"` row carries the
// address, the locale and the display number, and is what the customer sees in their account. The event only
// tells the worker WHICH order to confirm.
import type { Queryable } from '@platform/db';
import type { Address, NotificationData, NotificationKind } from './types.js';

export interface Loaded<K extends NotificationKind> {
  /** The recipient. Goes to the transport and nowhere else. */
  to: string;
  /** `"order".locale` as checkout stored it; `pickLocale` decides what that means for a template. */
  locale: string;
  data: NotificationData[K];
}

interface OrderRow {
  display_id: number;
  email: string;
  locale: string;
  currency: string;
  placed_at: Date;
  shipping_address: Address | null;
  shipping_method: { name?: unknown; carrier?: unknown } | null;
  promotion_codes: string[] | null;
  subtotal_minor: string;
  discount_minor: string;
  shipping_minor: string;
  tax_minor: string;
  total_minor: string;
}

interface LineRow {
  title: string;
  variant_title: string;
  sku: string;
  quantity: number;
  unit_price_minor: string;
  total_minor: string;
}

function shippingMethodOf(
  raw: OrderRow['shipping_method'],
): { name: string; carrier: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const carrier = typeof raw.carrier === 'string' ? raw.carrier : '';
  return name === '' ? null : { name, carrier };
}

export async function loadOrderConfirmation(
  db: Queryable,
  storeId: string,
  orderId: string,
): Promise<Loaded<'order_confirmation'> | null> {
  const order = await db.query<OrderRow>(
    `SELECT display_id::int AS display_id, email, locale, currency, placed_at, shipping_address, shipping_method,
            promotion_codes, subtotal_minor::text, discount_minor::text, shipping_minor::text, tax_minor::text,
            total_minor::text
       FROM "order" WHERE id = $1 AND store_id = $2`,
    [orderId, storeId],
  );
  const o = order.rows[0];
  if (!o) return null;
  const lines = await db.query<LineRow>(
    `SELECT title, variant_title, sku, quantity, unit_price_minor::text, total_minor::text
       FROM order_line_item WHERE order_id = $1 AND store_id = $2
      ORDER BY created_at, id`,
    [orderId, storeId],
  );
  return {
    to: o.email,
    locale: o.locale,
    data: {
      displayId: o.display_id,
      placedAt: o.placed_at.toISOString(),
      currency: o.currency,
      shippingAddress: o.shipping_address ?? {},
      lines: lines.rows.map((l) => ({
        title: l.title,
        variantTitle: l.variant_title,
        sku: l.sku,
        quantity: l.quantity,
        unitPriceMinor: Number(l.unit_price_minor),
        totalMinor: Number(l.total_minor),
      })),
      totals: {
        subtotalMinor: Number(o.subtotal_minor),
        discountMinor: Number(o.discount_minor),
        shippingMinor: Number(o.shipping_minor),
        taxMinor: Number(o.tax_minor),
        totalMinor: Number(o.total_minor),
      },
      shippingMethod: shippingMethodOf(o.shipping_method),
      promotionCodes: o.promotion_codes ?? [],
    },
  };
}

interface ShipmentRow {
  carrier: string;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: Date | null;
  display_id: number;
  email: string;
  locale: string;
  shipping_address: Address | null;
}

interface ShipmentItemRow {
  quantity: number;
  title: string;
  variant_title: string;
}

export async function loadShipmentShipped(
  db: Queryable,
  storeId: string,
  shipmentId: string,
): Promise<Loaded<'shipment_shipped'> | null> {
  const shipment = await db.query<ShipmentRow>(
    `SELECT s.carrier, s.service, s.tracking_number, s.tracking_url, s.shipped_at,
            o.display_id::int AS display_id, o.email, o.locale, o.shipping_address
       FROM shipment s JOIN "order" o ON o.id = s.order_id
      WHERE s.id = $1 AND s.store_id = $2`,
    [shipmentId, storeId],
  );
  const sh = shipment.rows[0];
  if (!sh) return null;
  const items = await db.query<ShipmentItemRow>(
    `SELECT si.quantity, li.title, li.variant_title
       FROM shipment_item si JOIN order_line_item li ON li.id = si.order_line_item_id
      WHERE si.shipment_id = $1 AND si.store_id = $2
      ORDER BY li.created_at, li.id`,
    [shipmentId, storeId],
  );
  return {
    to: sh.email,
    locale: sh.locale,
    data: {
      displayId: sh.display_id,
      shippedAt: (sh.shipped_at ?? new Date()).toISOString(),
      carrier: sh.carrier,
      service: sh.service,
      trackingNumber: sh.tracking_number,
      trackingUrl: sh.tracking_url,
      items: items.rows.map((i) => ({
        title: i.title,
        variantTitle: i.variant_title,
        quantity: i.quantity,
      })),
      shippingAddress: sh.shipping_address ?? {},
    },
  };
}
