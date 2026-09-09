import { MOCK_URLS } from '@platform/contracts';
import type { StoreApiConfig } from './client';

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
    // Phase 1 runs against the Prism mock (`pnpm mock`); Phase 2 sets STORE_API_URL to the core.
    baseUrl: env.STORE_API_URL ?? env.MOCK_API_URL ?? MOCK_URLS.store,
    // The mock accepts any value; a brand app sets its own key per environment.
    publishableKey: env.STORE_PUBLISHABLE_KEY ?? 'pk_test_storefront_starter',
  };
}
