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

/** A per-store secret and the variable that supplied it (names are loggable, values never are). */
export interface StoreSecret {
  value: string;
  /** The environment variable that supplied the value. */
  variable: string;
  source: 'store' | 'global';
}

/**
 * THE per-store credential loader shared by payments, tax and fraud (task 2.5, #128; ADR 0006): for a secret
 * named `NAME`, `NAME_<STORE_CODE>` wins over the global `NAME`. Deployed, both are injected from
 * `<env>/stores/<store_code>/<provider>` by External Secrets; locally they come from `.env`. Read on EVERY call —
 * a rotated value is picked up without a restart — and never cached, logged or embedded in an error.
 * Returns null when neither variable is set; `requireStoreSecret` is the fail-closed form.
 */
export function storeSecretFor(
  storeCode: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): StoreSecret | null {
  const storeVariable = `${name}_${envSuffix(storeCode)}`;
  const storeValue = env[storeVariable];
  if (storeValue) return { value: storeValue, variable: storeVariable, source: 'store' };
  const globalValue = env[name];
  if (globalValue) return { value: globalValue, variable: name, source: 'global' };
  return null;
}

/**
 * Fails closed at first use: a missing secret throws an error that names BOTH variables and the secret-store
 * path — never a value — so the operator knows exactly what to set.
 */
export function requireStoreSecret(
  storeCode: string,
  name: string,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): StoreSecret {
  const secret = storeSecretFor(storeCode, name, env);
  if (!secret) {
    throw new Error(
      `${provider} is not configured for store ${storeCode}: set ${name}_${envSuffix(storeCode)} or ${name} ` +
        `(locally in .env; deployed via <env>/stores/${storeCode}/${provider}, ADR 0006)`,
    );
  }
  return secret;
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
  const secret = requireStoreSecret(storeCode, 'STRIPE_SECRET_KEY', 'stripe', env);
  const secretKey = secret.value;
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) {
    throw new Error(
      `${secret.variable} is a LIVE-mode key: Phase 2 is Stripe test mode only (sk_test_…); refusing to use it`,
    );
  }
  const storeKey = secret.source === 'store';
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
  return stripeWebhookSecretsFor(storeCode, env)[0] ?? null;
}

/**
 * Current secret first, then the previous one during a roll (`STRIPE_WEBHOOK_SECRET_<CODE>_PREVIOUS`, else
 * `STRIPE_WEBHOOK_SECRET_PREVIOUS`). Signatures and stored-extract seals verify against any of them; new seals
 * always use the current one. Remove the `_PREVIOUS` value once every event sealed with it is settled.
 */
export function stripeWebhookSecretsFor(
  storeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const current = storeSecretFor(storeCode, 'STRIPE_WEBHOOK_SECRET', env)?.value ?? null;
  // `_PREVIOUS` keeps its historical name order: STRIPE_WEBHOOK_SECRET_<CODE>_PREVIOUS, else the global one.
  const suffix = envSuffix(storeCode);
  const previous =
    env[`STRIPE_WEBHOOK_SECRET_${suffix}_PREVIOUS`] || env.STRIPE_WEBHOOK_SECRET_PREVIOUS || null;
  const out: string[] = [];
  if (current) out.push(current);
  if (previous && previous !== current) out.push(previous);
  return out;
}
