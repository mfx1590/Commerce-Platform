// Types of the search module (window 9). One Algolia index per store ("brand"), records built from the catalog
// tables, an `IndexClient` abstraction so every piece of sync logic is unit-tested against an in-memory fake
// (`FakeIndexClient`) and the real client (`AlgoliaIndexClient`) is only exercised by the live test.

/** A variant as stored inside a product record (no prices — prices are aggregated per currency on the product). */
export interface SearchVariant {
  id: string;
  sku: string;
  title: string;
  options: Record<string, string>;
  in_stock: boolean;
}

/**
 * One record per published product. `objectID` = product id so upserts are idempotent. Money is integer minor
 * units keyed by currency (`price_minor.EUR`), which is what the price-sort replicas rank on.
 */
export interface SearchRecord {
  objectID: string;
  store_id: string;
  handle: string;
  title: string;
  subtitle: string | null;
  /** Truncated to DESCRIPTION_MAX_CHARS (Algolia records must stay small). */
  description: string | null;
  brand_name: string | null;
  tags: string[];
  category_id: string | null;
  category_handle: string | null;
  category_name: string | null;
  /** Category handles from the root down to the product's category (hierarchical faceting). */
  category_path: string[];
  thumbnail_url: string | null;
  published_at: string | null;
  /** Unix seconds; the `newest` replica ranks on it. */
  published_at_ts: number;
  attributes: Record<string, unknown>;
  variants: SearchVariant[];
  /** Lowest default-list price per enabled currency. */
  price_minor: Record<string, number>;
  /** Highest default-list price per enabled currency. */
  price_max_minor: Record<string, number>;
  /** Strike-through price of the cheapest variant per currency, when it has one. */
  compare_at_minor: Record<string, number>;
  /** Currencies the product is sellable in (keys of price_minor). */
  currencies: string[];
  in_stock: boolean;
  /** Sum of `available` over active warehouses; null when no variant manages inventory. */
  available_quantity: number | null;
  updated_at: string;
}

/** Subset of Algolia index settings this module writes. Unknown keys pass through untouched. */
export interface IndexSettings {
  searchableAttributes?: string[];
  attributesForFaceting?: string[];
  customRanking?: string[];
  ranking?: string[];
  replicas?: string[];
  attributesToRetrieve?: string[];
  unretrievableAttributes?: string[];
  /** Free-form; this module keeps the outbox cursor here (`{ outbox_cursor: number }`). */
  userData?: Record<string, unknown>;
  [key: string]: unknown;
}

/** An Algolia Rule as sent to `/1/indexes/<name>/rules/batch` (subset this module produces; task 2.2). */
export interface AlgoliaRule {
  objectID: string;
  description?: string;
  enabled: boolean;
  conditions: {
    pattern?: string;
    anchoring?: 'is' | 'startsWith' | 'endsWith' | 'contains';
    filters?: string;
    context?: string;
  }[];
  consequence: {
    promote?: { objectID: string; position: number }[];
    hide?: { objectID: string }[];
    params?: { optionalFilters?: string[] };
  };
  validity?: { from: number; until: number }[];
}

/** Query parameters of one search (Algolia `/query` subset). */
export interface SearchParams {
  query: string;
  /** Algolia filter expression, e.g. `category_id:<uuid>`; the fake understands `category_id:` only. */
  filters?: string;
  /** 0-based page. */
  page?: number;
  hitsPerPage?: number;
  /** Rule contexts to activate (unused by the fake). */
  ruleContexts?: string[];
}

export interface SearchResponse {
  hits: { objectID: string }[];
  nbHits: number;
  page: number;
  hitsPerPage: number;
}

/**
 * What the sync logic needs from an index backend. `AlgoliaIndexClient` talks to the REST API; `FakeIndexClient`
 * keeps everything in memory. All operations are idempotent (save = upsert by objectID, delete = no-op when
 * absent, setSettings = partial merge like Algolia's).
 */
export interface IndexClient {
  saveObjects(indexName: string, records: SearchRecord[]): Promise<void>;
  deleteObjects(indexName: string, objectIDs: string[]): Promise<void>;
  /** Every objectID currently in the index (browse). Used by the full reindex to delete stale records. */
  browseObjectIDs(indexName: string): Promise<string[]>;
  getSettings(indexName: string): Promise<IndexSettings>;
  setSettings(
    indexName: string,
    settings: IndexSettings,
    opts?: { forwardToReplicas?: boolean },
  ): Promise<void>;
  deleteIndex(indexName: string): Promise<void>;
  /** Upserts rules; `clearExisting` replaces the whole rule set of the index (publish semantics). */
  saveRules(
    indexName: string,
    rules: AlgoliaRule[],
    opts?: { clearExisting?: boolean },
  ): Promise<void>;
  clearRules(indexName: string): Promise<void>;
  /** One query with rules applied (Store API `sort=relevance`). */
  search(indexName: string, params: SearchParams): Promise<SearchResponse>;
}

/** The store fields the module needs (read from `store` by the caller or the job). */
export interface StoreIndexTarget {
  id: string;
  code: string;
  default_currency: string;
  /** `store.search_index` (registry); null → `products_<code>`. */
  search_index: string | null;
}

export interface SyncResult {
  /** Outbox rows consumed. */
  processed: number;
  upserted: number;
  deleted: number;
  /** Outbox `seq` the index is now caught up to. */
  cursor: number;
}

export interface ReindexResult {
  indexName: string;
  indexed: number;
  /** Records that were in the index but no longer published. */
  removed: number;
  cursor: number;
}

export const DESCRIPTION_MAX_CHARS = 4000;

/** Outbox topics that change what a store's index must contain. */
export const SYNC_TOPICS = ['product.published', 'product.updated', 'product.archived'] as const;
