// Algolia credentials per store from the environment (Vault-injected env in deployed environments, ADR 0006).
// Store-specific variables win over the global pair so a brand can live in its own Algolia application.
// Nothing here is ever logged or embedded in an error.

export interface AlgoliaCredentials {
  appId: string;
  apiKey: string;
  /** Which variables supplied them (for logs: names only, never values). */
  source: 'store' | 'global';
}

/** `brand-a` → `BRAND_A` (env variable suffix). */
export function envSuffix(storeCode: string): string {
  return storeCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * `ALGOLIA_APP_ID_<CODE>` + `ALGOLIA_ADMIN_API_KEY_<CODE>` for the store, else `ALGOLIA_APP_ID` +
 * `ALGOLIA_ADMIN_API_KEY`; null when neither pair is complete (callers skip the store or run the fake client).
 */
export function algoliaCredentialsFor(
  storeCode: string,
  env: NodeJS.ProcessEnv = process.env,
): AlgoliaCredentials | null {
  const suffix = envSuffix(storeCode);
  const storeApp = env[`ALGOLIA_APP_ID_${suffix}`];
  const storeKey = env[`ALGOLIA_ADMIN_API_KEY_${suffix}`];
  if (storeApp && storeKey) return { appId: storeApp, apiKey: storeKey, source: 'store' };
  const app = env.ALGOLIA_APP_ID;
  const key = env.ALGOLIA_ADMIN_API_KEY;
  if (app && key) return { appId: app, apiKey: key, source: 'global' };
  return null;
}
