/**
 * BI v2 data layer (#604) over the metrics API (#603, `queryMetrics`). Pure: the query bodies the dashboards send,
 * and the shaping of a `MetricResult` into what the page draws. No fetch here, so it is unit-tested without a
 * server; the typed call lives in `_api.ts` once the contract's generated types exist.
 *
 * Rules carried through every helper: money is integer minor units beside its currency and is NEVER added across
 * currencies (every money view is per currency tab); ratios come from the server (recomputed there per total);
 * a live figure is labelled live, never bookings.
 */

// The shapes of the posted contract (#603 comments 6438446364 + 6444596272). Replaced by the generated
// `AdminComponents['schemas']['MetricQuery' | 'MetricResult']` when the contract lands; the tests pin the shapes.
export type MetricId =
  | 'orders'
  | 'bookings_minor'
  | 'net_bookings_minor'
  | 'aov_minor'
  | 'refunds_minor'
  | 'refund_rate_bp'
  | 'units'
  | 'product_net_minor'
  | 'new_customers'
  | 'returning_customers'
  | 'captured_minor'
  | 'fee_minor'
  | 'recognised_minor'
  | 'live_orders'
  | 'live_placed_minor';
export type Dimension = 'store' | 'product' | 'refund_reason' | 'provider';
export type Grain = 'day' | 'week' | 'month' | 'total';

export interface MetricQuery {
  metrics: MetricId[];
  dimensions?: Dimension[];
  grain: Grain;
  from: string;
  to: string;
  filters?: { store_ids?: string[]; currencies?: string[]; product_ids?: string[] };
  order_by?: { metric: MetricId; direction?: 'desc' | 'asc' };
  limit?: number;
}

export interface MetricRow {
  period: string | null;
  currency: string | null;
  store_id: string | null;
  product_id: string | null;
  refund_reason: string | null;
  provider: string | null;
  values: Partial<Record<MetricId, number | null>>;
}

export interface MetricResult {
  query: MetricQuery;
  generated_at: string;
  data_as_of: string | null;
  truncated: boolean;
  rows: MetricRow[];
  currency_totals: { currency: string | null; values: Partial<Record<MetricId, number | null>> }[];
}

export interface Window {
  from: string;
  to: string;
}

// ---- the queries the dashboards send ------------------------------------------------------------------------

/** The period dashboard: bookings, refunds and their rate per store and day (every BI principal). */
export function periodQuery(w: Window): MetricQuery {
  return {
    metrics: ['bookings_minor', 'refunds_minor', 'refund_rate_bp'],
    dimensions: ['store'],
    grain: 'day',
    from: w.from,
    to: w.to,
  };
}

/** The three money views side by side per currency: bookings vs recognised (ledger) vs cash (finance only). */
export function moneyViewsQuery(w: Window): MetricQuery {
  return {
    metrics: ['bookings_minor', 'recognised_minor', 'captured_minor'],
    grain: 'total',
    from: w.from,
    to: w.to,
  };
}

/** Top products by units in the window (product ids; the page resolves names it is allowed to see). */
export function topProductsQuery(w: Window, limit = 10): MetricQuery {
  return {
    metrics: ['units', 'product_net_minor'],
    dimensions: ['product'],
    grain: 'total',
    from: w.from,
    to: w.to,
    order_by: { metric: 'units', direction: 'desc' },
    limit,
  };
}

/** The live tiles (D6): today, UTC, per store, polled every 15 s. */
export function liveQuery(now: Date = new Date()): MetricQuery {
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    metrics: ['live_orders', 'live_placed_minor'],
    dimensions: ['store'],
    grain: 'total',
    from: today,
    to: tomorrow,
  };
}

// ---- shaping --------------------------------------------------------------------------------------------------

/** Currency tabs of a result: every currency it has a total for, alphabetically (a currency is never merged). */
export function currencies(result: MetricResult): string[] {
  return result.currency_totals
    .map((t) => t.currency)
    .filter((c): c is string => c !== null)
    .sort();
}

/** The values of one currency's totals (zeros when the currency has no rows). */
export function totalsOf(
  result: MetricResult,
  currency: string,
): Partial<Record<MetricId, number | null>> {
  return result.currency_totals.find((t) => t.currency === currency)?.values ?? {};
}

export interface MoneyViews {
  currency: string;
  bookings_minor: number;
  recognised_minor: number | null;
  captured_minor: number | null;
}

/**
 * Bookings vs recognised vs cash per currency. Without finance the recognised and cash columns are null (the page
 * asks for bookings only, so nothing is fetched that the principal may not see).
 */
export function moneyViews(result: MetricResult, finance: boolean): MoneyViews[] {
  return currencies(result).map((currency) => {
    const v = totalsOf(result, currency);
    return {
      currency,
      bookings_minor: v.bookings_minor ?? 0,
      recognised_minor: finance ? (v.recognised_minor ?? 0) : null,
      captured_minor: finance ? (v.captured_minor ?? 0) : null,
    };
  });
}

export interface StoreSeries {
  storeId: string;
  values: number[];
}

/** One series per store of `metric` in `currency`, one value per day (0 on a day without a row). */
export function storeSeries(
  result: MetricResult,
  metric: MetricId,
  currency: string,
  days: readonly string[],
): StoreSeries[] {
  const index = new Map(days.map((d, i) => [d, i]));
  const byStore = new Map<string, number[]>();
  for (const r of result.rows) {
    if (r.currency !== currency || r.store_id === null || r.period === null) continue;
    const i = index.get(r.period);
    if (i === undefined) continue;
    let values = byStore.get(r.store_id);
    if (!values) {
      values = days.map(() => 0);
      byStore.set(r.store_id, values);
    }
    values[i] = (values[i] ?? 0) + (r.values[metric] ?? 0);
  }
  return [...byStore.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([storeId, values]) => ({ storeId, values }));
}

export interface LiveTile {
  storeId: string;
  currency: string;
  orders: number;
  placed_minor: number;
  /** placed ÷ orders, integer half-up; null with no orders. Live, not bookings. */
  aov_minor: number | null;
}

/** The live tiles: per store × currency; a store with orders in two currencies gets two tiles, never one sum. */
export function liveTiles(result: MetricResult): LiveTile[] {
  return result.rows
    .filter(
      (r): r is MetricRow & { store_id: string; currency: string } =>
        r.store_id !== null && r.currency !== null,
    )
    .map((r) => {
      const orders = r.values.live_orders ?? 0;
      const placed = r.values.live_placed_minor ?? 0;
      return {
        storeId: r.store_id,
        currency: r.currency,
        orders,
        placed_minor: placed,
        aov_minor: orders === 0 ? null : Math.floor((2 * placed + orders) / (2 * orders)),
      };
    })
    .sort((a, b) => a.storeId.localeCompare(b.storeId) || a.currency.localeCompare(b.currency));
}

export interface Freshness {
  label: string;
  /** No event for longer than `staleAfterMs`: the page shows the tiles as stale, not as quiet. */
  stale: boolean;
}

/** "Updated 12 s ago" from `data_as_of` (the latest event the answer includes). */
export function freshness(
  dataAsOf: string | null,
  now: Date = new Date(),
  staleAfterMs = 120_000,
): Freshness {
  if (dataAsOf === null) return { label: 'No events yet', stale: true };
  const age = Math.max(0, now.getTime() - Date.parse(dataAsOf));
  const s = Math.round(age / 1000);
  const label =
    s < 60
      ? `Updated ${s} s ago`
      : s < 3600
        ? `Updated ${Math.round(s / 60)} min ago`
        : `Updated ${Math.round(s / 3600)} h ago`;
  return { label, stale: age > staleAfterMs };
}

/** Basis points as a percentage label (12.34 %); a dash when undefined. */
export function rateLabel(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return '—';
  return `${(bp / 100).toFixed(2)} %`;
}
