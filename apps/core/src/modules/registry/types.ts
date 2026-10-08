import type { AdminComponents } from '@platform/contracts';

/** Contract shapes (packages/contracts, Admin API). The registry returns exactly these. */
export type Store = AdminComponents['schemas']['Store'];
export type StoreInput = AdminComponents['schemas']['StoreInput'];
export type Domain = AdminComponents['schemas']['Domain'];
export type SalesChannel = AdminComponents['schemas']['SalesChannel'];
export type ApiKey = AdminComponents['schemas']['ApiKey'];
export type ApiKeyCreated = ApiKey & { key: string };

export type StoreStatus = Store['status'];
export type SalesChannelType = SalesChannel['type'];
export type ApiKeyType = ApiKey['type'];

export interface DomainInput {
  hostname: string;
  is_primary?: boolean;
}

export interface SalesChannelInput {
  code: string;
  name: string;
  type: SalesChannelType;
}

export interface ApiKeyInput {
  name: string;
  type: ApiKeyType;
  sales_channel_id?: string | null;
}

export interface StoreLocale {
  id: string;
  locale: string;
  is_default: boolean;
}

export interface StoreCurrency {
  id: string;
  currency: string;
  is_default: boolean;
}

export interface PageQuery {
  page?: number;
  limit?: number;
}

/** Admin API 0.2.0 `sort` for `listStores`; `order` is ignored unless `sort` is present. */
export const STORE_SORT_FIELDS = ['code', 'name', 'status', 'created_at'] as const;
export type StoreSortField = (typeof STORE_SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';
export interface StoreListQuery extends PageQuery {
  sort?: StoreSortField | undefined;
  order?: SortOrder | undefined;
}

export interface Page<T> {
  page: number;
  limit: number;
  total: number;
  items: T[];
}

/** Raw `store` row as node-postgres returns it. */
export interface StoreRow {
  id: string;
  organization_id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  status: StoreStatus;
  default_currency: string;
  default_locale: string;
  default_country: string;
  timezone: string;
  content_space_id: string | null;
  search_index: string | null;
  psp_account_id: string | null;
  theme: Record<string, unknown>;
  settings: Record<string, unknown>;
  next_order_number: string;
  created_at: Date;
  updated_at: Date;
  /** Enabled sets from `store_currency` / `store_locale`; only on rows read through the registry's store select. */
  currencies?: string[];
  locales?: string[];
}

export interface DomainUpdate {
  is_primary: boolean;
}

export type Warehouse = AdminComponents['schemas']['Warehouse'];
export type LegalEntity = AdminComponents['schemas']['LegalEntity'];

// ---- onboarding (#413, CONTRACT CHANGE #417 — Admin API 0.4.11) ----------------------------------------------
// Local mirrors of the 0.4.11 schemas until the contract lands on main; then they become
// `AdminComponents['schemas'][...]` like the types above.

export interface LegalEntityInput {
  code: string;
  name: string;
  country: string;
  currency: string;
  vat_number?: string | null;
}

export interface StoreOnboardingInput {
  /** An existing legal entity — exactly one of this and `legal_entity`. */
  legal_entity_id?: string;
  /** Created in the same transaction — exactly one of this and `legal_entity_id`. */
  legal_entity?: LegalEntityInput;
  code: string;
  name: string;
  default_currency: string;
  default_locale: string;
  default_country: string;
  timezone?: string;
  currencies?: string[];
  locales?: string[];
  domain: { hostname: string };
  theme?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface StoreOnboarded {
  store: Store;
  legal_entity: LegalEntity;
  domain: Domain;
  sales_channel: SalesChannel;
  /** Shown once (201); null when the call repeated an onboarding already done (200). */
  publishable_key: ApiKeyCreated | null;
}

/**
 * The OpenFGA side of a store (#413 / #415): the `store:<id>#organization@organization:hq` tuple that makes a
 * store visible to scope resolution at all. The registry never talks to OpenFGA directly — the routes hand in
 * an implementation (window 2's `ensureStoreObject` once #415 is on main; a fake in tests).
 */
export interface StoreRegistrar {
  /** Writes the tuple; idempotent (a second call on the same store is a no-op). */
  ensureStoreObject(storeId: string): Promise<void>;
  /** Whether the tuple exists — the `fga_object` activation prerequisite. */
  hasStoreObject(storeId: string): Promise<boolean>;
}
