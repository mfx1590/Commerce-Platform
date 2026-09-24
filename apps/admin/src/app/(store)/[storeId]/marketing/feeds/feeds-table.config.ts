import type { TableQueryDefaults } from '@/lib/table/query-state';

/** Plain module (not `'use client'`) — see the note in `campaigns-table.config.ts`. */

/** `listFeeds` takes these filters; it has no sort parameter, so the table sorts nothing. */
export const FEED_FILTER_KEYS = ['channel', 'status'] as const;

export const FEEDS_TABLE_DEFAULTS: TableQueryDefaults = {};

export const FEED_CHANNELS = ['google_merchant', 'meta', 'tiktok', 'pinterest'] as const;

/** Only these two have a writer today; publishing either of the others is a 409, not an empty file. */
export const RENDERABLE_CHANNELS: readonly string[] = ['google_merchant', 'meta'];

export const FEED_STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger'> = {
  active: 'success',
  draft: 'neutral',
  paused: 'warning',
  error: 'danger',
};

export const CHANNEL_LABEL: Record<string, string> = {
  google_merchant: 'Google Merchant',
  meta: 'Meta',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
};
