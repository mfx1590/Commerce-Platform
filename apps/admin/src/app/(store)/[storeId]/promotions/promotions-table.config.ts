import type { TableQueryDefaults } from '@/lib/table/query-state';

/** Plain module (no `'use client'`) — imported by the server page as well as the client table. */

/** `listPromotions` in Admin API 0.4.5 sorts by exactly these; there are no filters. */
export const PROMOTIONS_SORTABLE_COLUMNS = [
  'name',
  'code',
  'status',
  'starts_at',
  'created_at',
] as const;
export const PROMOTION_FILTER_KEYS = [] as const;
export const PROMOTIONS_TABLE_DEFAULTS: TableQueryDefaults = { sort: 'created_at', order: 'desc' };

export type PromotionTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export const PROMOTION_STATUS_TONES: Record<string, PromotionTone> = {
  active: 'success',
  draft: 'neutral',
  disabled: 'warning',
  expired: 'danger',
};

export const PRICE_LIST_TYPE_TONES: Record<string, PromotionTone> = {
  default: 'neutral',
  sale: 'accent',
  override: 'warning',
};

export function promotionTone(status: string): PromotionTone {
  return PROMOTION_STATUS_TONES[status] ?? 'neutral';
}

/** The usage card's window: the last 30 days, ending now, as ISO date-times the report requires. */
export function last30Days(now = new Date()): { from: string; to: string } {
  const to = new Date(now);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  return { from: from.toISOString(), to: to.toISOString() };
}
