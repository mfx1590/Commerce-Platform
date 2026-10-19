import type { Store } from './store-api';

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
 * - **Pay on invoice** (the core's `manual` provider) only where the store allows it.
 *
 * **What the store allows comes from the store** (manager ruling on #358): `Store.payment.methods`
 * (`'card' | 'invoice'`, Store API 0.5.4, an optional property on `GET /store`, derived by the core —
 * `card` when the store has a Stripe key, `invoice` from its `settings.payment.invoice_allowed`, true
 * in the seed and false by default in production). Card needs `card` there **and** a publishable key
 * here; Invoice needs `invoice`. When the property is absent
 * (a core before 0.5.4) the storefront's own default applies: Card on the key alone, no invoice. The
 * interim `STOREFRONT_ALLOW_INVOICE` switch is gone (#372) now that the core returns the property.
 */

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

/** The part of `GET /store` this reads (`Store.payment`: Store API 0.5.4, contracts 0.4.11). */
export type StorePaymentFacts = Pick<Store, 'code' | 'payment'>;

/** `Store.payment.methods` when the store says, else null (the property is absent). */
export function storeMethods(store: StorePaymentFacts | null): readonly string[] | null {
  return store?.payment?.methods ?? null;
}

export function paymentOptions(
  store: StorePaymentFacts | null,
  env: Env = process.env,
): PaymentOptions {
  const key = stripePublishableKey(store?.code ?? null, env);
  const methods = storeMethods(store);
  if (methods === null) return { stripePublishableKey: key, invoice: false };
  return {
    stripePublishableKey: methods.includes('card') ? key : null,
    invoice: methods.includes('invoice'),
  };
}

/** Is this provider one the store offers right now? Checked again on the server for every submit. */
export function offers(options: PaymentOptions, provider: string): provider is PaymentProviderId {
  if (provider === 'stripe') return options.stripePublishableKey !== null;
  if (provider === 'manual') return options.invoice;
  return false;
}
