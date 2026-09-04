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
}
