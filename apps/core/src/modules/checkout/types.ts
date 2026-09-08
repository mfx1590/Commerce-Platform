import type { Queryable } from '@platform/db';
import type { StoreComponents } from '@platform/contracts';
import type { Actor } from '../../lib/audit';

export type StoreOrder = StoreComponents['schemas']['Order'];
export type StoreOrderSummary = StoreComponents['schemas']['OrderSummary'];
export type StoreShippingOption = StoreComponents['schemas']['ShippingOption'];
export type StorePaymentSession = StoreComponents['schemas']['PaymentSession'];
export type PaymentProviderName = StorePaymentSession['provider'];
export type PaymentSessionStatus = StorePaymentSession['status'];
export type Address = StoreComponents['schemas']['Address'];
export type Money = StoreComponents['schemas']['Money'];

// ---- PaymentProvider (public API; window 7 implements `stripe` against it, #127) ----

/** What a provider learns about the cart: ids and money, never card data (hosted fields, ADR 0004). */
export interface PaymentCartRef {
  cartId: string;
  organizationId: string;
  storeId: string;
  currency: string;
  /** Cart total at the time of the call, integer minor units. */
  amountMinor: number;
  /** Lowercased checkout email, or null before the customer entered one. */
  email: string | null;
}

export interface CreatePaymentSessionInput {
  tx: Queryable;
  cart: PaymentCartRef;
}

export interface PaymentSessionResult {
  sessionId: string;
  /** For hosted fields; null for providers without a client-side step (`manual`). */
  clientSecret: string | null;
  status: PaymentSessionStatus;
}

export interface AuthorizeInput {
  tx: Queryable;
  cart: PaymentCartRef;
  /** The session previously created for this cart (as stored on `cart.payment_session`). */
  session: StorePaymentSession;
  /** `Idempotency-Key` of the placement request; providers pass it through for their own de-duplication. */
  idempotencyKey: string;
}

export interface AuthorizeResult {
  status: 'authorized' | 'failed';
  /** Provider-side payment id (`payment.provider_payment_id`); required when authorized. */
  providerPaymentId: string | null;
  failureReason?: string | undefined;
}

export interface RefundInput {
  tx: Queryable;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  reason: string;
}

export interface RefundResult {
  status: 'succeeded' | 'failed';
  providerRefundId: string | null;
  failureReason?: string | undefined;
}

/**
 * A payment service provider seen from the checkout. `createSession` runs on `POST …/payment-session`,
 * `authorize` inside the placement transaction (a `failed` result aborts the placement with 402
 * `payment_failed`), `refund` from task 2.5's returns. Implementations must be idempotent on `idempotencyKey`.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createSession(input: CreatePaymentSessionInput): Promise<PaymentSessionResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  refund(input: RefundInput): Promise<RefundResult>;
}

// ---- use-case inputs ----

export interface CompleteCartInput {
  cartId: string;
  /** Contract header `Idempotency-Key` (min 8 chars, validated by the route). */
  idempotencyKey: string;
  actor: Actor;
  /** Test seams: run inside the placement transaction after the given step (a throw must roll everything back). */
  hooks?: {
    afterEvents?: ((tx: Queryable) => Promise<void>) | undefined;
  };
}

export interface CompleteCartResult {
  order: StoreOrder;
  /** True when the `Idempotency-Key` had already placed this cart: the stored order, no provider call. */
  replayed: boolean;
}

/** Who is asking for an order: a verified customer of the store, a guest with the checkout email, or nobody. */
export interface OrderAccess {
  customerId?: string | null | undefined;
  email?: string | null | undefined;
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
  status: StoreOrderSummary['status'];
  payment_status: StoreOrderSummary['payment_status'];
  fulfillment_status: StoreOrderSummary['fulfillment_status'];
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
  metadata: Record<string, unknown>;
}

export interface OrderLineRow {
  id: string;
  variant_id: string | null;
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
}

export interface ShipmentRow {
  id: string;
  status: StoreOrder['shipments'][number]['status'];
  carrier: string;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: Date | null;
}
