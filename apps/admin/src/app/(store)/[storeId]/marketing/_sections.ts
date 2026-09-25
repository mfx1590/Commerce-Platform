/**
 * The Marketing section's own sub-navigation.
 *
 * A **plain module**, deliberately: a constant exported from a `'use client'` file and imported by a server
 * component becomes a client reference, and an array that is no longer iterable is how that failure shows up
 * (Memory-main global gotchas, and the note window 4 left in `products-table.config.ts`).
 *
 * These are not rail serpents. The rail is window 4's and shows one Marketing section; this is navigation
 * *inside* it, so it carries no motion — the design brief puts motion in the rail and nowhere else.
 */

export interface MarketingTab {
  /** Path segment under `/{storeId}/marketing`; the empty string is the section root. */
  readonly segment: string;
  readonly label: string;
  readonly description: string;
}

export const MARKETING_TABS: readonly MarketingTab[] = [
  {
    segment: '',
    label: 'Overview',
    description: 'Revenue by channel and campaign, and the promotions behind it',
  },
  { segment: 'campaigns', label: 'Campaigns', description: 'Per campaign, with launch and end' },
  { segment: 'segments', label: 'Segments', description: 'Rule builder with a live count' },
  { segment: 'feeds', label: 'Feeds', description: 'Status, item count, errors, publish' },
] as const;

export function marketingHref(storeId: string, segment: string): string {
  return segment === '' ? `/${storeId}/marketing` : `/${storeId}/marketing/${segment}`;
}

/** The report window every Overview tile shares: the last `days` days, ending now. */
export function reportWindow(days = 30, now: Date = new Date()): { from: string; to: string } {
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - days * 24 * 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}
