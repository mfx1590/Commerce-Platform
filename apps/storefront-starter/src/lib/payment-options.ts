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
 * `card` when the store has a Stripe key, `invoice` from its `settings.payment.invoice_allowed`).
 * When the core returns it, it decides: Card needs `card` there **and** a publishable key here;
 * Invoice needs `invoice`. When the property is absent (a core or mock before 0.5.4) the interim
 * switch decides instead: Card on the key alone, Invoice on `STOREFRONT_ALLOW_INVOICE=1` (default
 * off; the e2e server turns it on so the mock run, which has no Stripe key, can still check out).
 * The switch goes in a follow-up once the core serves the property everywhere (#350/#354).
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

/** The interim switch — consulted only when the store does not say (see above). */
export function invoiceFlag(env: Env = process.env): boolean {
  return env[INVOICE_FLAG] === '1';
}

/**
 * The part of `GET /store` this reads. `payment` is Store API 0.5.4 (contracts 0.4.11); typed here
 * until the contract's `Store` carries it, and read defensively because an older core omits it.
 */
export interface StorePaymentFacts {
  code: string;
  payment?: { methods?: readonly string[] } | null;
}

/** `Store.payment.methods` when the store says, else null (the property is absent). */
export function storeMethods(store: StorePaymentFacts | null): readonly string[] | null {
  const methods = store?.payment?.methods;
  return Array.isArray(methods) ? methods : null;
}

export function paymentOptions(
  store: StorePaymentFacts | null,
  env: Env = process.env,
): PaymentOptions {
  const key = stripePublishableKey(store?.code ?? null, env);
  const methods = storeMethods(store);
  if (methods === null) return { stripePublishableKey: key, invoice: invoiceFlag(env) };
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
