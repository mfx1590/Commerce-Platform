import { cache } from 'react';
import { cacheTags, storeApi, type Store } from './store-api';

/**
 * `GET /store` resolves the store, its locales, currencies and theme from the publishable key.
 * Wrapped in `cache()` so the root layout and a page share one request per render.
 */
export const getStore = cache(async (): Promise<Store> =>
  storeApi().getStore({ tags: [cacheTags.store], revalidate: 300 }),
);

/**
 * The same, but never throws. The root layout uses it so that an API outage renders a readable page
 * with default tokens instead of a stack trace — and so `next build` works without the mock running.
 */
export const getStoreOrNull = cache(async (): Promise<Store | null> => {
  try {
    return await getStore();
  } catch (error) {
    console.warn('[storefront] GET /store failed, falling back to default theme:', error);
    return null;
  }
});
