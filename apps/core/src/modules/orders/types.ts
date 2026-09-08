import type { Queryable } from '@platform/db';
import type { AdminComponents, StoreComponents } from '@platform/contracts';
import type { Actor } from '../../lib/audit';

// ---- contract shapes ----
export type AdminOrderSummary = AdminComponents['schemas']['OrderSummary'];
export type AdminOrder = AdminComponents['schemas']['Order'];
export type AdminLineItem = AdminComponents['schemas']['LineItem'];
export type AdminPayment = AdminComponents['schemas']['Payment'];
export type AdminRefund = AdminComponents['schemas']['Refund'];
export type AdminShipment = AdminComponents['schemas']['Shipment'];
export type AdminReturn = AdminComponents['schemas']['Return'];
export type StoreOrder = StoreComponents['schemas']['Order'];
export type Address = StoreComponents['schemas']['Address'];
export type Money = StoreComponents['schemas']['Money'];

export type OrderStatus = AdminOrderSummary['status'];
export type PaymentStatus = AdminOrderSummary['payment_status'];
export type FulfillmentStatus = AdminOrderSummary['fulfillment_status'];

/** Admin API 0.3.0 `listOrders` `sort` values; `order` is ignored unless `sort` is present. */
export const ORDER_SORT_FIELDS = ['placed_at', 'display_id', 'total', 'status'] as const;
export type OrderSortField = (typeof ORDER_SORT_FIELDS)[number];
export const ORDER_STATUSES: readonly OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'completed',
  'cancelled',
];
export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'awaiting',
  'authorized',
  'captured',
  'partially_refunded',
  'refunded',
  'failed',
];
export const FULFILLMENT_STATUSES: readonly FulfillmentStatus[] = [
  'unfulfilled',
  'partially_fulfilled',
  'fulfilled',
  'partially_returned',
  'returned',
];

export interface ListOrdersQuery {
  status?: OrderStatus | undefined;
  payment_status?: PaymentStatus | undefined;
  fulfillment_status?: FulfillmentStatus | undefined;
  /** display_id (exact) or email (substring, case-insensitive). */
  q?: string | undefined;
  placed_from?: Date | undefined;
  placed_to?: Date | undefined;
  sort?: OrderSortField | undefined;
  order?: 'asc' | 'desc' | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface Page<T> {
  page: number;
  limit: number;
  total: number;
  items: T[];
}

/** Who is asking for an order on the Store API: a verified customer of the store, a guest with the email, or nobody. */
export interface OrderAccess {
  customerId?: string | null | undefined;
  email?: string | null | undefined;
}

// ---- transition ----

export type StatusField = 'status' | 'payment_status' | 'fulfillment_status';

export interface TransitionHooks {
  /** Test seams: run inside the transaction after the given step; a throw must roll everything back. */
  afterUpdate?: ((tx: Queryable) => Promise<void>) | undefined;
  afterEvents?: ((tx: Queryable) => Promise<void>) | undefined;
}

export interface TransitionChange {
  status?: OrderStatus | undefined;
  payment_status?: PaymentStatus | undefined;
  fulfillment_status?: FulfillmentStatus | undefined;
  /** `cancel_reason` when cancelling. */
  reason?: string | null | undefined;
  /** Extra `changed_fields` for `order.updated` (order edits: `line_items`, totals…). */
  changed_fields?: readonly string[] | undefined;
  actor: Actor;
  occurredAt?: Date | undefined;
  hooks?: TransitionHooks | undefined;
}

export interface LineQuantity {
  lineItemId: string;
  quantity: number;
}

// ---- rows ----

export interface OrderRow {
  id: string;
  organization_id: string;
  store_id: string;
  display_id: string;
  sales_channel_id: string;
  cart_id: string | null;
  customer_id: string | null;
  email: string;
  currency: string;
  locale: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  fulfillment_status: FulfillmentStatus;
  shipping_address: Address;
  billing_address: Address;
  shipping_option_id: string | null;
  shipping_method: { code: string; name: string; carrier: string; price_minor: number };
  promotion_codes: string[];
  subtotal_minor: string;
  discount_minor: string;
  shipping_minor: string;
  tax_minor: string;
  total_minor: string;
  placed_at: Date;
  cancelled_at: Date | null;
  completed_at: Date | null;
  cancel_reason: string | null;
  metadata: Record<string, unknown>;
}

export interface OrderLineRow {
  id: string;
  variant_id: string | null;
  product_id: string | null;
  category_id: string | null;
  sku: string;
  title: string;
  variant_title: string;
  thumbnail_url: string | null;
  quantity: number;
  unit_price_minor: string;
  discount_minor: string;
  tax_rate_bp: number;
  tax_minor: string;
  total_minor: string;
  fulfilled_quantity: number;
  returned_quantity: number;
}
