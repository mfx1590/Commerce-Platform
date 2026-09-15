import { StoreApiClient } from './client';
import { storeApiConfigFromEnv } from './config';

export { StoreApiClient, allowsCustomerToken, buildUrl } from './client';
export type { RequestOptions, StoreApiConfig } from './client';
export { StoreApiError, isNotFound, isStoreApiError } from './errors';
export { storeApiConfigFromEnv } from './config';
export * from './types';

let client: StoreApiClient | undefined;

/** The app's Store API client, built once from the environment. */
export function storeApi(): StoreApiClient {
  client ??= new StoreApiClient(storeApiConfigFromEnv());
  return client;
}

/** Cache tag names, so a webhook (Phase 2) can revalidate exactly what changed. */
export const cacheTags = {
  store: 'store',
  categories: 'categories',
  products: 'products',
  product: (handle: string) => `product:${handle}`,
} as const;
