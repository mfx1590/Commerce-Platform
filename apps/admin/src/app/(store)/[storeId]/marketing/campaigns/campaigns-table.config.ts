import type { TableQueryDefaults } from '@/lib/table/query-state';

/**
 * Plain module, not the `'use client'` one — a constant exported from a client module and imported by a server
 * component becomes a client reference (Memory-main global gotchas; window 4 hit it in 1.5).
 */

/** `listCampaigns` in Admin API 0.3.0 sorts by exactly these. */
export const CAMPAIGNS_SORTABLE_COLUMNS = ['name', 'status', 'starts_at', 'created_at'] as const;

/** The contract's own filter parameters — anything else is a 400. */
export const CAMPAIGN_FILTER_KEYS = ['status', 'type'] as const;

export const CAMPAIGNS_TABLE_DEFAULTS: TableQueryDefaults = { sort: 'created_at', order: 'desc' };

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'active', 'paused', 'ended'] as const;

export const CAMPAIGN_TYPES = [
  'email',
  'sms',
  'paid_social',
  'paid_search',
  'affiliate',
  'referral',
  'landing',
] as const;

/** Status → badge tone. `ended` is neutral, not a failure: it is the successful end of a campaign. */
export const CAMPAIGN_STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning'> = {
  active: 'success',
  scheduled: 'neutral',
  draft: 'neutral',
  paused: 'warning',
  ended: 'neutral',
};

/**
 * Which transitions the contract allows, mirrored here so the screen offers only the button that can work.
 * The server decides — this is convenience, and a refused action still renders `ActionRefusal`.
 */
export const LAUNCHABLE: readonly string[] = ['draft', 'scheduled', 'paused'];
export const ENDABLE: readonly string[] = ['active', 'paused'];
