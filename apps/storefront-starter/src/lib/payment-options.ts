/**
 * Which payment methods the checkout offers (#358). Server-only: it reads the environment at
 * request time, so one image serves every store and every environment (#302).
 *
 * - **Card** (Stripe Payment Element, hosted fields — card data never reaches our servers) when the
 *   store has a Stripe **publishable** key: `STRIPE_PUBLISHABLE_KEY_<STORE CODE>`, else
 *   `STRIPE_PUBLISHABLE_KEY` — the same naming as the core's per-store secrets
 *   (`apps/core/src/modules/payments/credentials.ts`, `envSuffix`). A publishable key is public by
 *   design; it is handed to the browser. Only a `pk_test_` / `pk_live_` value counts — a secret key
 *   put in the wrong variable must never be sent to a browser.
 * - **Pay on invoice** (the core's `manual` provider) only where it is allowed:
 *   `STOREFRONT_ALLOW_INVOICE=1`, default off. An interim switch until the store carries the
 *   setting itself (manager decision on #358; a `Store` contract field would replace it). The e2e
 *   server turns it on, so the mock run — which has no Stripe key — can still check out.
 */

export const INVOICE_FLAG = 'STOREFRONT_ALLOW_INVOICE';

export type PaymentProviderId = 'stripe' | 'manual';

export interface PaymentOptions {
  /** The Stripe publishable key, or null when the store takes no cards. */
  stripePublishableKey: string | null;
  invoice: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `brand-a` → `BRAND_A`, exactly as the core names the store's variables. */
export function envSuffix(storeCode: string): string {
  return storeCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

const PUBLISHABLE = /^pk_(test|live)_[A-Za-z0-9]+$/;

export function stripePublishableKey(
  storeCode: string | null,
  env: Env = process.env,
): string | null {
  const candidates = [
    ...(storeCode === null ? [] : [env[`STRIPE_PUBLISHABLE_KEY_${envSuffix(storeCode)}`]]),
    env.STRIPE_PUBLISHABLE_KEY,
  ];
  const value = candidates.find((candidate) => candidate !== undefined && candidate !== '');
  if (value === undefined) return null;
  // Never hand anything else to the browser — above all not a secret key in the wrong variable.
  return PUBLISHABLE.test(value) ? value : null;
}

export function invoiceAllowed(env: Env = process.env): boolean {
  return env[INVOICE_FLAG] === '1';
}

export function paymentOptions(storeCode: string | null, env: Env = process.env): PaymentOptions {
  return {
    stripePublishableKey: stripePublishableKey(storeCode, env),
    invoice: invoiceAllowed(env),
  };
}

/** Is this provider one the store offers right now? Checked again on the server for every submit. */
export function offers(options: PaymentOptions, provider: string): provider is PaymentProviderId {
  if (provider === 'stripe') return options.stripePublishableKey !== null;
  if (provider === 'manual') return options.invoice;
  return false;
}
