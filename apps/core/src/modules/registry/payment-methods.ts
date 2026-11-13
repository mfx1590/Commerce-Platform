// What the checkout can offer a store (Store API 0.5.4 `Store.payment.methods`, #350 / #358) — and, since #839
// (Admin API 0.4.29), an activation prerequisite (`payment_method`). One rule for both, here in the registry: the
// Store API's `GET /store` and the readiness check call the same function, so they cannot disagree.
import { storeSecretFor } from '../payments';

export type PaymentMethod = 'card' | 'invoice';

/**
 * `card` when the store has a Stripe secret key configured (`STRIPE_SECRET_KEY_<CODE>`, else `STRIPE_SECRET_KEY`;
 * the payments module's per-store loader, read on every call so a rotated or added key shows without a restart),
 * `invoice` (the `manual` provider) when `settings.payment.invoice_allowed` is exactly `true` — absent means false,
 * so a production store offers invoice only when someone set it; the seed sets it. Derived, never stored.
 */
export function paymentMethodsOf(
  storeCode: string,
  settings: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): PaymentMethod[] {
  const methods: PaymentMethod[] = [];
  if (storeSecretFor(storeCode, 'STRIPE_SECRET_KEY', env) !== null) methods.push('card');
  const payment = settings.payment as { invoice_allowed?: unknown } | undefined;
  if (payment?.invoice_allowed === true) methods.push('invoice');
  return methods;
}
