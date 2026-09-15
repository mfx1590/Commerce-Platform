// Stripe credentials per store from the environment (Vault-injected env in deployed environments: the chart's
// `externalSecrets.remoteKeys` name `<env>/stores/<store_code>/stripe`, ADR 0006; locally `.env`). Store-suffixed
// variables win over the global pair, each independently. Nothing here is ever logged or embedded in an error —
// errors name VARIABLES, never values. Phase 2 is TEST MODE ONLY: live-mode secret keys are refused outright.

export interface StripeCredentials {
  secretKey: string;
  /** For the 2.2 webhook receiver; providers never need it. */
  webhookSecret: string | null;
  /** Which variable supplied the secret key (for logs: names only, never values). */
  source: 'store' | 'global';
}

/** `brand-a` → `BRAND_A` (env variable suffix; same convention as the search module's Algolia loader). */
export function envSuffix(storeCode: string): string {
  return storeCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * `STRIPE_SECRET_KEY_<CODE>` (else `STRIPE_SECRET_KEY`) + `STRIPE_WEBHOOK_SECRET_<CODE>` (else
 * `STRIPE_WEBHOOK_SECRET`). Fails closed: no secret key → an error naming both variables; a live-mode key
 * (`sk_live_` / `rk_live_`) → refused (Phase 2 is test mode only, decisions.md #10). Read on every call, so a
 * rotated env value is picked up without a restart.
 */
export function stripeCredentialsFor(
  storeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): StripeCredentials {
  const suffix = envSuffix(storeCode);
  const storeVar = `STRIPE_SECRET_KEY_${suffix}`;
  const storeKey = env[storeVar];
  const globalKey = env.STRIPE_SECRET_KEY;
  const secretKey = storeKey || globalKey;
  if (!secretKey) {
    throw new Error(
      `stripe is not configured for store ${storeCode}: set ${storeVar} or STRIPE_SECRET_KEY ` +
        `(locally in .env; deployed via <env>/stores/${storeCode}/stripe, ADR 0006)`,
    );
  }
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) {
    throw new Error(
      `${storeKey ? storeVar : 'STRIPE_SECRET_KEY'} is a LIVE-mode key: Phase 2 is Stripe test mode only ` +
        `(sk_test_…); refusing to use it`,
    );
  }
  const webhookSecret = stripeWebhookSecretFor(storeCode, env);
  return { secretKey, webhookSecret, source: storeKey ? 'store' : 'global' };
}

/**
 * The webhook endpoint secret alone (`STRIPE_WEBHOOK_SECRET_<CODE>`, else `STRIPE_WEBHOOK_SECRET`), for the
 * 2.2 receiver — which must verify a signature without needing (or touching) the secret key. Null when unset:
 * the receiver fails closed with an error naming the variables.
 */
export function stripeWebhookSecretFor(
  storeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const suffix = envSuffix(storeCode);
  return env[`STRIPE_WEBHOOK_SECRET_${suffix}`] || env.STRIPE_WEBHOOK_SECRET || null;
}
