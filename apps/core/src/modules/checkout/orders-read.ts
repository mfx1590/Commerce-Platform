// Store API order read (`GET /store/orders/{orderId}`). Lives here until task 2.3 creates the orders module.
// Access rule (contract: only 200 or 404): a verified customer of the store sees their own orders (by
// `customer_id`, or by the checkout email matching the customer's), a guest sees an order when the `?email=`
// matches the checkout email (trimmed, case-insensitive). Anything else — no credentials, wrong email, another
// store's order — is the same 404, so an order id can never be confirmed by probing. No log line here ever
// carries the email or the query string.
import type { Queryable, ScopedClient } from '@platform/db';
import { notFound } from '../../lib/errors';
import type { OrderAccess, OrderLineRow, OrderRow, ShipmentRow, StoreOrder } from './types';

const ORDER_COLS = `id, organization_id, store_id, display_id::text, sales_channel_id, cart_id, customer_id, email,
  currency, locale, status, payment_status, fulfillment_status, shipping_address, billing_address,
  shipping_option_id, shipping_method, promotion_codes, subtotal_minor::text, discount_minor::text,
  shipping_minor::text, tax_minor::text, total_minor::text, placed_at, metadata`;

const money = (amount: string | number, currency: string) => ({
  amount_minor: Number(amount),
  currency,
});

/** The contract `Order` for an order id visible to the client (404 otherwise). */
export async function renderOrder(tx: Queryable, orderId: string): Promise<StoreOrder> {
  const r = await tx.query<OrderRow>(`SELECT ${ORDER_COLS} FROM "order" WHERE id = $1`, [orderId]);
  const o = r.rows[0];
  if (!o) throw notFound('order', orderId);
  // Sequential on purpose: two concurrent queries on one pg client trigger its deprecation warning.
  const lines = await tx.query<OrderLineRow>(
    `SELECT id, variant_id, sku, title, variant_title, thumbnail_url, quantity, unit_price_minor::text,
              discount_minor::text, tax_rate_bp, tax_minor::text, total_minor::text
       FROM order_line_item WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const shipments = await tx.query<ShipmentRow>(
    `SELECT id, status, carrier, tracking_number, tracking_url, shipped_at FROM shipment
       WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const c = o.currency;
  return {
    id: o.id,
    display_id: Number(o.display_id),
    status: o.status,
    payment_status: o.payment_status,
    fulfillment_status: o.fulfillment_status,
    total: money(o.total_minor, c),
    placed_at: o.placed_at.toISOString(),
    metadata: o.metadata,
    email: o.email,
    currency: c,
    items: lines.rows.map((l) => {
      const subtotal = l.quantity * Number(l.unit_price_minor);
      return {
        id: l.id,
        // NULL only after a variant was deleted (ON DELETE SET NULL); the contract's uuid is kept as-is otherwise.
        variant_id: l.variant_id ?? '00000000-0000-4000-8000-000000000000',
        sku: l.sku,
        title: l.title,
        variant_title: l.variant_title,
        thumbnail_url: l.thumbnail_url,
        quantity: l.quantity,
        unit_price: money(l.unit_price_minor, c),
        subtotal: money(subtotal, c),
        discount: money(l.discount_minor, c),
        tax: money(l.tax_minor, c),
        total: money(l.total_minor, c),
      };
    }),
    shipping_address: o.shipping_address,
    billing_address: o.billing_address,
    shipping_method: {
      id: o.shipping_option_id ?? '00000000-0000-4000-8000-000000000000',
      code: o.shipping_method.code,
      name: o.shipping_method.name,
      carrier: o.shipping_method.carrier,
      price: money(o.shipping_minor, c),
    },
    totals: {
      subtotal: money(o.subtotal_minor, c),
      discount: money(o.discount_minor, c),
      shipping: money(o.shipping_minor, c),
      tax: money(o.tax_minor, c),
      total: money(o.total_minor, c),
    },
    shipments: shipments.rows.map((s) => ({
      id: s.id,
      status: s.status,
      carrier: s.carrier,
      tracking_number: s.tracking_number,
      tracking_url: s.tracking_url,
      shipped_at: s.shipped_at ? s.shipped_at.toISOString() : null,
    })),
  };
}

/**
 * `GET /store/orders/{orderId}` with the access rule above. `access.customerId` is a `customer.id` of the store
 * (resolved by the route from a verified customers-realm token); `access.email` the guest's `?email=`.
 */
export async function getStoreOrder(
  client: ScopedClient,
  orderId: string,
  access: OrderAccess,
): Promise<StoreOrder> {
  const email = access.email?.trim().toLowerCase() || null;
  const customerId = access.customerId ?? null;
  if (!email && !customerId) throw notFound('order', orderId);
  return client.transaction(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `SELECT o.id FROM "order" o
       WHERE o.id = $1
         AND (
           ($2::text IS NOT NULL AND lower(o.email) = $2)
           OR ($3::uuid IS NOT NULL AND (
                 o.customer_id = $3
                 OR lower(o.email) = (SELECT lower(c.email) FROM customer c WHERE c.id = $3)
               ))
         )`,
      [orderId, email, customerId],
    );
    if (!r.rows[0]) throw notFound('order', orderId);
    return renderOrder(tx, orderId);
  });
}

/** `customer.id` for a verified customers-realm subject in this store, or null (the route treats null as no access). */
export async function customerIdForSubject(
  client: ScopedClient,
  storeId: string,
  subject: string,
): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM customer WHERE store_id = $1 AND keycloak_subject = $2 AND status <> 'erased'`,
    [storeId, subject],
  );
  return r.rows[0]?.id ?? null;
}
