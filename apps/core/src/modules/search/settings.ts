// Index naming and settings. One primary index per store plus three standard replicas for the Store API sort
// orders (`price_asc`, `price_desc`, `newest`); `relevance` is the primary index (merchandising rules land on it
// in task 2.2). Price replicas rank on the store's default currency.
import type { IndexSettings, StoreIndexTarget } from './types';

export const REPLICA_SORTS = ['price_asc', 'price_desc', 'newest'] as const;
export type ReplicaSort = (typeof REPLICA_SORTS)[number];

/** `store.search_index` when the registry set one, else `products_<code>`. */
export function indexNameFor(store: Pick<StoreIndexTarget, 'code' | 'search_index'>): string {
  return store.search_index?.trim() || `products_${store.code}`;
}

export function replicaNameFor(indexName: string, sort: ReplicaSort): string {
  return `${indexName}_${sort}`;
}

/** Cursor key inside `settings.userData`. */
export const CURSOR_KEY = 'outbox_cursor';

const BASE_RANKING = [
  'typo',
  'geo',
  'words',
  'filters',
  'proximity',
  'attribute',
  'exact',
  'custom',
];

/** Settings shared by the primary and every replica (everything except ranking, replicas, userData). */
export function sharedSettings(): IndexSettings {
  return {
    searchableAttributes: [
      'title',
      'unordered(handle)',
      'brand_name',
      'unordered(tags)',
      'unordered(variants.sku)',
      'category_name',
      'unordered(category_path)',
      'unordered(description)',
    ],
    attributesForFaceting: [
      'filterOnly(store_id)',
      'filterOnly(category_id)',
      'searchable(category_path)',
      'searchable(tags)',
      'searchable(brand_name)',
      'in_stock',
      'filterOnly(currencies)',
      'filterOnly(variants.sku)',
    ],
    attributesToRetrieve: [
      'objectID',
      'handle',
      'title',
      'subtitle',
      'brand_name',
      'tags',
      'category_id',
      'category_handle',
      'category_path',
      'thumbnail_url',
      'published_at',
      'price_minor',
      'price_max_minor',
      'compare_at_minor',
      'currencies',
      'in_stock',
      'variants',
    ],
    unretrievableAttributes: ['store_id'],
  };
}

/** Primary index settings for a store: relevance ranking, replicas declared. */
export function primarySettings(
  store: Pick<StoreIndexTarget, 'code' | 'search_index' | 'default_currency'>,
): IndexSettings {
  const name = indexNameFor(store);
  return {
    ...sharedSettings(),
    ranking: BASE_RANKING,
    customRanking: ['desc(published_at_ts)'],
    replicas: REPLICA_SORTS.map((s) => replicaNameFor(name, s)),
  };
}

/** Ranking of one replica: the sort first, then the usual relevance signals as tie-breaker. */
export function replicaSettings(
  store: Pick<StoreIndexTarget, 'default_currency'>,
  sort: ReplicaSort,
): IndexSettings {
  const currency = store.default_currency.toUpperCase();
  const first =
    sort === 'price_asc'
      ? `asc(price_minor.${currency})`
      : sort === 'price_desc'
        ? `desc(price_minor.${currency})`
        : 'desc(published_at_ts)';
  return { ...sharedSettings(), ranking: [first, ...BASE_RANKING], customRanking: [] };
}
