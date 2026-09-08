// Order read models: the Store API `Order` (customer / guest, 200 or 404 only) and the Admin API `Order` +
// `OrderSummary` list. Reads only; RLS (store-scoped client) decides visibility. Moved here from the checkout
// module in task 2.3.
import type { Queryable, ScopedClient } from '@platform/db';
import { notFound } from '../../lib/errors';
import type {
  AdminLineItem,
  AdminOrder,
  AdminOrderSummary,
  AdminPayment,
  AdminRefund,
  AdminReturn,
  AdminShipment,
  ListOrdersQuery,
  Money,
  OrderAccess,
  OrderLineRow,
  OrderRow,
  Page,
  StoreOrder,
} from './types';

export const ORDER_COLS = `id, organization_id, store_id, display_id::text, sales_channel_id, cart_id, customer_id, email,
  currency, locale, status, payment_status, fulfillment_status, shipping_address, billing_address,
  shipping_option_id, shipping_method, promotion_codes, subtotal_minor::text, discount_minor::text,
  shipping_minor::text, tax_minor::text, total_minor::text, placed_at, cancelled_at, completed_at, cancel_reason,
  metadata`;

/** `ORDER_COLS` qualified with the `o` alias (list query joins nothing, but the alias keeps the filters readable). */
const ORDER_COLS_O = ORDER_COLS.split(',')
  .map((col) => `o.${col.trim()}`)
  .join(', ');

const LINE_COLS = `li.id, li.variant_id, v.product_id, p.category_id, li.sku, li.title, li.variant_title, li.thumbnail_url,
  li.quantity, li.unit_price_minor::text, li.discount_minor::text, li.tax_rate_bp, li.tax_minor::text,
  li.total_minor::text, li.fulfilled_quantity, li.returned_quantity`;

const money = (amount: string | number, currency: string): Money => ({
  amount_minor: Number(amount),
  currency,
});
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const NIL_UUID = '00000000-0000-4000-8000-000000000000';

/** The order row (404 when invisible); `lock = true` takes `FOR UPDATE` for a transition. */
export async function loadOrder(tx: Queryable, orderId: string, lock: boolean): Promise<OrderRow> {
  const r = await tx.query<OrderRow>(
    `SELECT ${ORDER_COLS} FROM "order" WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [orderId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('order', orderId);
  return row;
}

export async function loadOrderLines(tx: Queryable, orderId: string): Promise<OrderLineRow[]> {
  const r = await tx.query<OrderLineRow>(
    `SELECT ${LINE_COLS} FROM order_line_item li
     LEFT JOIN product_variant v ON v.id = li.variant_id
     LEFT JOIN product p ON p.id = v.product_id
     WHERE li.order_id = $1 ORDER BY li.created_at, li.id`,
    [orderId],
  );
  return r.rows;
}

interface ShipmentRow {
  id: string;
  order_id: string;
  warehouse_id: string;
  carrier: string;
  service: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  label_url: string | null;
  cost_minor: string | null;
  currency: string;
  status: AdminShipment['status'];
  shipped_at: Date | null;
  delivered_at: Date | null;
}

async function loadShipments(tx: Queryable, orderId: string): Promise<AdminShipment[]> {
  const r = await tx.query<ShipmentRow>(
    `SELECT id, order_id, warehouse_id, carrier, service, tracking_number, tracking_url, label_url,
            cost_minor::text, currency, status, shipped_at, delivered_at
     FROM shipment WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const out: AdminShipment[] = [];
  for (const s of r.rows) {
    const items = await tx.query<{ order_line_item_id: string; quantity: number }>(
      `SELECT order_line_item_id, quantity FROM shipment_item WHERE shipment_id = $1 ORDER BY created_at, id`,
      [s.id],
    );
    out.push({
      id: s.id,
      order_id: s.order_id,
      warehouse_id: s.warehouse_id,
      carrier: s.carrier,
      service: s.service,
      tracking_number: s.tracking_number,
      tracking_url: s.tracking_url,
      label_url: s.label_url,
      cost: s.cost_minor === null ? null : money(s.cost_minor, s.currency),
      status: s.status,
      items: items.rows,
      shipped_at: iso(s.shipped_at),
      delivered_at: iso(s.delivered_at),
    } as AdminShipment);
  }
  return out;
}

// ---- Store API ----

/** The Store API `Order` for an id visible to the client (404 otherwise). */
export async function renderStoreOrder(tx: Queryable, orderId: string): Promise<StoreOrder> {
  const o = await loadOrder(tx, orderId, false);
  const lines = await loadOrderLines(tx, orderId);
  const shipments = await loadShipments(tx, orderId);
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
    items: lines.map((l) => {
      const subtotal = l.quantity * Number(l.unit_price_minor);
      return {
        id: l.id,
        // NULL only after a variant was deleted (ON DELETE SET NULL); the Store contract wants a uuid.
        variant_id: l.variant_id ?? NIL_UUID,
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
      id: o.shipping_option_id ?? NIL_UUID,
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
    shipments: shipments.map((s) => ({
      id: s.id,
      status: s.status,
      carrier: s.carrier,
      tracking_number: s.tracking_number,
      tracking_url: s.tracking_url,
      shipped_at: s.shipped_at,
    })),
  };
}

/**
 * `GET /store/orders/{orderId}` (contract: only 200 or 404). `access.customerId` is a `customer.id` of the store
 * (resolved by the route from a verified customers-realm token); `access.email` the guest's `?email=`, compared
 * trimmed and case-insensitively. No credentials, a mismatch, another store's order → the same 404.
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
    return renderStoreOrder(tx, orderId);
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

// ---- Admin API ----

export function toAdminSummary(o: OrderRow): AdminOrderSummary {
  return {
    id: o.id,
    display_id: Number(o.display_id),
    email: o.email,
    customer_id: o.customer_id,
    status: o.status,
    payment_status: o.payment_status,
    fulfillment_status: o.fulfillment_status,
    total: money(o.total_minor, o.currency),
    placed_at: o.placed_at.toISOString(),
  };
}

function toAdminLine(l: OrderLineRow, currency: string): AdminLineItem {
  return {
    id: l.id,
    variant_id: l.variant_id,
    sku: l.sku,
    title: l.title,
    variant_title: l.variant_title,
    thumbnail_url: l.thumbnail_url,
    quantity: l.quantity,
    unit_price: money(l.unit_price_minor, currency),
    discount: money(l.discount_minor, currency),
    tax_rate_bp: l.tax_rate_bp,
    tax: money(l.tax_minor, currency),
    total: money(l.total_minor, currency),
    fulfilled_quantity: l.fulfilled_quantity,
    returned_quantity: l.returned_quantity,
  };
}

interface PaymentRow {
  id: string;
  provider: string;
  provider_payment_id: string | null;
  amount_minor: string;
  currency: string;
  status: AdminPayment['status'];
  fee_minor: string | null;
  captured_at: Date | null;
}
interface RefundRow {
  id: string;
  order_id: string;
  payment_id: string;
  return_id: string | null;
  amount_minor: string;
  currency: string;
  reason: AdminRefund['reason'];
  status: AdminRefund['status'];
  provider_refund_id: string | null;
  created_at: Date;
}
interface ReturnRow {
  id: string;
  order_id: string;
  status: AdminReturn['status'];
  reason: string | null;
  warehouse_id: string | null;
  refund_id: string | null;
  requested_at: Date;
  received_at: Date | null;
}

/** The Admin API `Order` (payments, refunds, shipments, returns included) for an id visible to the client. */
export async function renderAdminOrder(tx: Queryable, orderId: string): Promise<AdminOrder> {
  const o = await loadOrder(tx, orderId, false);
  const c = o.currency;
  const lines = await loadOrderLines(tx, orderId);
  const payments = await tx.query<PaymentRow>(
    `SELECT id, provider, provider_payment_id, amount_minor::text, currency, status, fee_minor::text, captured_at
     FROM payment WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const refunds = await tx.query<RefundRow>(
    `SELECT id, order_id, payment_id, return_id, amount_minor::text, currency, reason, status, provider_refund_id, created_at
     FROM refund WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const shipments = await loadShipments(tx, orderId);
  const returns = await tx.query<ReturnRow>(
    `SELECT id, order_id, status, reason, warehouse_id, refund_id, requested_at, received_at
     FROM "return" WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const returnItems: AdminReturn[] = [];
  for (const r of returns.rows) {
    const items = await tx.query<{
      order_line_item_id: string;
      quantity: number;
      condition: 'resellable' | 'damaged' | null;
    }>(
      `SELECT order_line_item_id, quantity, condition FROM return_item WHERE return_id = $1 ORDER BY created_at, id`,
      [r.id],
    );
    returnItems.push({
      id: r.id,
      order_id: r.order_id,
      status: r.status,
      reason: r.reason,
      warehouse_id: r.warehouse_id,
      refund_id: r.refund_id,
      items: items.rows,
      requested_at: r.requested_at.toISOString(),
      received_at: iso(r.received_at),
    });
  }
  return {
    ...toAdminSummary(o),
    sales_channel_id: o.sales_channel_id,
    currency: c,
    locale: o.locale,
    items: lines.map((l) => toAdminLine(l, c)),
    shipping_address: o.shipping_address,
    billing_address: o.billing_address,
    shipping_method: {
      code: o.shipping_method.code,
      name: o.shipping_method.name,
      carrier: o.shipping_method.carrier,
      price: money(o.shipping_minor, c),
    },
    promotion_codes: o.promotion_codes,
    totals: {
      subtotal: money(o.subtotal_minor, c),
      discount: money(o.discount_minor, c),
      shipping: money(o.shipping_minor, c),
      tax: money(o.tax_minor, c),
      total: money(o.total_minor, c),
    },
    payments: payments.rows.map((p) => ({
      id: p.id,
      provider: p.provider,
      provider_payment_id: p.provider_payment_id,
      amount: money(p.amount_minor, p.currency),
      status: p.status,
      fee_minor: p.fee_minor === null ? null : Number(p.fee_minor),
      captured_at: iso(p.captured_at),
    })),
    refunds: refunds.rows.map((r) => ({
      id: r.id,
      order_id: r.order_id,
      payment_id: r.payment_id,
      return_id: r.return_id,
      amount: money(r.amount_minor, r.currency),
      reason: r.reason,
      status: r.status,
      provider_refund_id: r.provider_refund_id,
      created_at: r.created_at.toISOString(),
    })),
    shipments,
    returns: returnItems,
    cancel_reason: o.cancel_reason,
    metadata: o.metadata,
  };
}

/** `GET /admin/stores/{storeId}/orders/{orderId}` (404 outside the client's scope). */
export async function getAdminOrder(client: ScopedClient, orderId: string): Promise<AdminOrder> {
  return client.transaction((tx) => renderAdminOrder(tx, orderId));
}

const SORT_SQL: Record<NonNullable<ListOrdersQuery['sort']>, string> = {
  placed_at: 'o.placed_at',
  display_id: 'o.display_id',
  total: 'o.total_minor',
  status: 'o.status',
};

/** `GET /admin/stores/{storeId}/orders`: filters, `q` (display_id or email), sort/order (0.2.0), pagination. */
export async function listAdminOrders(
  client: ScopedClient,
  storeId: string,
  q: ListOrdersQuery = {},
): Promise<Page<AdminOrderSummary>> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  const where: string[] = ['o.store_id = $1'];
  const params: unknown[] = [storeId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (q.status) add('o.status = ?', q.status);
  if (q.payment_status) add('o.payment_status = ?', q.payment_status);
  if (q.fulfillment_status) add('o.fulfillment_status = ?', q.fulfillment_status);
  if (q.placed_from) add('o.placed_at >= ?', q.placed_from);
  if (q.placed_to) add('o.placed_at <= ?', q.placed_to);
  const term = q.q?.trim();
  if (term) {
    if (/^#?\d+$/.test(term)) add('o.display_id = ?', Number(term.replace('#', '')));
    else add('o.email ILIKE ?', `%${term}%`);
  }
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = q.sort
    ? `${SORT_SQL[q.sort]} ${dir}, o.display_id ${dir}`
    : 'o.placed_at DESC, o.display_id DESC';
  const clause = where.join(' AND ');
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "order" o WHERE ${clause}`,
      params,
    );
    const rows = await tx.query<OrderRow>(
      `SELECT ${ORDER_COLS_O} FROM "order" o WHERE ${clause}
       ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    return {
      page,
      limit,
      total: Number(total.rows[0]?.n ?? 0),
      items: rows.rows.map(toAdminSummary),
    };
  });
}
