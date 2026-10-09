import type { StoreApiConfig } from './client';

/**
 * The core's Store API. Since core 2.2 it answers the whole journey — catalogue, cart, checkout and
 * the order read — so it, not the mock, is what an unconfigured starter should talk to.
 */
export const DEFAULT_STORE_API_URL = 'http://localhost:9000';

/**
 * Server-side configuration. The publishable key is not a secret (it identifies the store and sales
 * channel, and the core scopes every answer to it), but it still has no business in the browser
 * bundle: pages fetch on the server and pass typed data down.
 */
export function storeApiConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): StoreApiConfig {
  if (typeof window !== 'undefined') {
    throw new Error(
      'The Store API client is server-only; call it from a server component or action',
    );
  }

  return {
    // Phase 2 default: the core. `STORE_API_URL` still wins for a deployment that names it
    // explicitly, and `MOCK_API_URL` selects the Prism mock — which is how Playwright and the
    // offline `next build` keep running against contract examples without the stack.
    baseUrl: env.STORE_API_URL ?? env.MOCK_API_URL ?? DEFAULT_STORE_API_URL,
    // The mock accepts any value; a brand app sets its own key per environment.
    publishableKey: env.STORE_PUBLISHABLE_KEY ?? 'pk_test_storefront_starter',
  };
}
