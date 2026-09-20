// The PaymentProvider seam of the core (moved from src/modules/checkout in task 2.5 to break the checkout ↔ orders
// module cycle; the checkout module re-exports everything here, so window 7 keeps `setPaymentProvider` from
// '../checkout'). Types + a process-wide registry + the built-in `manual` provider. Card data never reaches this
// process (hosted fields, ADR 0004): providers exchange ids and amounts only.
import { randomUUID } from 'node:crypto';
import type { Queryable } from '@platform/db';
import type { StoreComponents } from '@platform/contracts';

export type StorePaymentSession = StoreComponents['schemas']['PaymentSession'];
export type PaymentProviderName = StorePaymentSession['provider'];
export type PaymentSessionStatus = StorePaymentSession['status'];

// ---- PaymentProvider (window 7 implements `stripe` against it, #127) ----

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
  /** The store the payment belongs to: per-store PSP credentials are resolved from it. */
  organizationId: string;
  storeId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  reason: string;
}

export interface RefundResult {
  /**
   * `pending`: the provider accepted the refund but settles it asynchronously (its webhook reports the final
   * state). Callers must treat it as "asked, not done": never ask again under the same idempotency key, never
   * mark anything refunded yet.
   */
  status: 'succeeded' | 'pending' | 'failed';
  providerRefundId: string | null;
  failureReason?: string | undefined;
}

export interface VoidInput {
  /**
   * The placement transaction, when there still is one. On the placement failure path the transaction is being
   * rolled back (it may already be aborted): providers must NOT run queries on it there — the store fields below
   * are what a void needs (per-store PSP credentials), never the database.
   */
  tx: Queryable;
  organizationId: string;
  storeId: string;
  /** The cart being placed (failure path) — for provider-side logging/idempotency only. */
  cartId?: string | undefined;
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

// ---- registry + manual provider ----

/** Authorises every amount at once; ids are `man_<uuid>` so they are recognisable in `payment` rows. */
export const manualPaymentProvider: PaymentProvider = {
  name: 'manual',
  async createSession() {
    return { sessionId: `man_${randomUUID()}`, clientSecret: null, status: 'pending' };
  },
  async authorize({ session }) {
    return { status: 'authorized', providerPaymentId: `manpay_${session.session_id}` };
  },
  // Nothing was ever captured for a manual payment: voiding is a no-op that always succeeds.
  async void() {
    return { status: 'voided' };
  },
  async refund({ providerPaymentId }) {
    return { status: 'succeeded', providerRefundId: `manref_${providerPaymentId}` };
  },
};

const providers = new Map<PaymentProviderName, PaymentProvider>([
  ['manual', manualPaymentProvider],
]);

/** Registers (or replaces) a provider under its contract name. Returns the previous one so tests can restore it. */
export function setPaymentProvider(provider: PaymentProvider): PaymentProvider | undefined {
  const previous = providers.get(provider.name);
  providers.set(provider.name, provider);
  return previous;
}

/** The provider registered under `name`, or undefined (the route answers 400 `validation_error`). */
export function paymentProvider(name: string): PaymentProvider | undefined {
  return providers.get(name as PaymentProviderName);
}

export function registeredPaymentProviders(): PaymentProviderName[] {
  return [...providers.keys()];
}
