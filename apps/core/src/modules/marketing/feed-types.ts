// Product feed types (issue #146, Admin API 0.3.0 + the `product_feed` table of migration 0120).
// Same split as the campaign types: `ProductFeedRow` is the table, `ProductFeed` is the contract.
import type { AdminComponents } from '@platform/contracts';

export type ProductFeedInput = AdminComponents['schemas']['ProductFeedInput'];
export type FeedItem = AdminComponents['schemas']['FeedItem'];

/** The read shape of a feed — the contract's own `ProductFeed` (spelled out since Admin API 0.4.1, #194). */
export type ProductFeed = AdminComponents['schemas']['ProductFeed'];

export type FeedChannel = NonNullable<ProductFeedInput['channel']>;
/** `error` is the publish job's verdict; since 0.4.1 the contract's `ProductFeed.status` carries it. */
export type FeedStatus = ProductFeed['status'];
export type FeedError = ProductFeed['errors'][number];
export type Availability = FeedItem['availability'];

export const FEED_CHANNELS: readonly FeedChannel[] = [
  'google_merchant',
  'meta',
  'tiktok',
  'pinterest',
];
export const FEED_STATUSES: readonly FeedStatus[] = ['draft', 'active', 'paused', 'error'];
/** `ProductFeedInput.status` cannot be set to `error` — that is the publish job's verdict, not a choice. */
export const FEED_INPUT_STATUSES: readonly FeedStatus[] = ['draft', 'active', 'paused'];

/**
 * Channels this window can actually render (#146: Google Merchant and Meta). `tiktok` and `pinterest` are legal
 * in the contract and can be stored as definitions, but publishing one is a 409 rather than a silently empty
 * file — Phase 3 adds the writers.
 */
export const RENDERABLE_CHANNELS: readonly FeedChannel[] = ['google_merchant', 'meta'];

/** File extension per channel; also the second half of the storage key (`<store_code>/<feed_id>.<ext>`). */
export const FEED_EXTENSION: Record<FeedChannel, string> = {
  google_merchant: 'xml',
  meta: 'csv',
  tiktok: 'csv',
  pinterest: 'csv',
};

export const FEED_CONTENT_TYPE: Record<string, string> = {
  xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

/** A row of the `product_feed` table. */
export interface ProductFeedRow {
  id: string;
  organization_id: string;
  store_id: string;
  name: string;
  channel: FeedChannel;
  locale: string;
  currency: string;
  filters: FeedFilters;
  mapping: Record<string, unknown>;
  url: string | null;
  status: FeedStatus;
  last_published_at: Date | null;
  item_count: number;
  errors: FeedError[];
  created_at: Date;
  updated_at: Date;
}

/** The documented keys of `filters`; the contract allows more and we keep what we do not understand. */
export interface FeedFilters {
  category_ids?: string[];
  tags?: string[];
  in_stock_only?: boolean;
  [key: string]: unknown;
}

export interface FeedListQuery {
  channel?: FeedChannel;
  status?: FeedStatus;
  page?: number;
  limit?: number;
}

/** What `buildFeedItems` returns: the rows, and the feed-level errors collected while building them. */
export interface FeedBuild {
  items: FeedItem[];
  errors: FeedError[];
}
