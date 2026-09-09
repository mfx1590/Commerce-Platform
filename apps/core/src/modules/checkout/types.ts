import type { Queryable } from '@platform/db';
import type { StoreComponents } from '@platform/contracts';
import type { Actor } from '../../lib/audit';
import type { StoreOrder } from '../orders';

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

export interface VoidInput {
  tx: Queryable;
  /** The authorised, not yet captured payment (`payment.provider_payment_id`). */
  providerPaymentId: string;
  idempotencyKey: string;
  reason: string;
}

export interface VoidResult {
  status: 'voided' | 'failed';
  failureReason?: string | undefined;
}

/**
 * A payment service provider seen from the checkout. `createSession` runs on `POST …/payment-session`,
 * `authorize` inside the placement transaction (a `failed` result aborts the placement with 402
 * `payment_failed`), `void` when an order with an authorised, uncaptured payment is cancelled (orders module,
 * 2.3), `refund` from task 2.5's returns. Implementations must be idempotent on `idempotencyKey`.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createSession(input: CreatePaymentSessionInput): Promise<PaymentSessionResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  void(input: VoidInput): Promise<VoidResult>;
  refund(input: RefundInput): Promise<RefundResult>;
}

// ---- use-case inputs ----
// (the order read types moved to src/modules/orders in 2.3)

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
