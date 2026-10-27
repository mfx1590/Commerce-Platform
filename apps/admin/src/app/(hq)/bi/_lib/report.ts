/**
 * Pure helpers for the BI section (#480): the report window, the currency tab, the per-store daily series and
 * the series colours. No I/O, no React — unit-tested in apps/admin/test/bi.
 *
 * The rule everything here serves: one currency at a time. A tab picks the currency; series, totals and the chart
 * only ever hold rows of that currency.
 */

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** The contract's limit (`ReportTo`: at most 366 days after `from`). */
export const MAX_DAYS = 366;
export const DEFAULT_DAYS = 30;

/**
 * Categorical slots for the admin's dark surface (#131a22), validated with the dataviz validator (lightness band,
 * chroma, CVD and normal-vision separation, ≥ 3:1 contrast). Assigned in fixed order by the store's position in
 * the principal's store list (sorted by code) — a colour follows the store, never its rank in a report.
 */
export const SERIES_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

export interface ReportWindow {
  from: string;
  to: string;
}

function isDay(value: string | undefined): value is string {
  if (!value || !DAY.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The last `days` UTC days including today: `to` is tomorrow (exclusive), as the report operations expect. */
export function defaultWindow(now: Date = new Date(), days = DEFAULT_DAYS): ReportWindow {
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return { from: dayOf(tomorrow - days * DAY_MS), to: dayOf(tomorrow) };
}

/** `from`/`to` from the URL when they form a valid window (after, at most 366 days); otherwise the default. */
export function windowFrom(
  params: { from?: string | undefined; to?: string | undefined },
  now: Date = new Date(),
): ReportWindow {
  const { from, to } = params;
  if (isDay(from) && isDay(to)) {
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
    if (span > 0 && span <= MAX_DAYS) return { from, to };
  }
  return defaultWindow(now);
}

/** Every UTC day in the window, `from` inclusive, `to` exclusive. */
export function daysOf(window: ReportWindow): string[] {
  const out: string[] = [];
  const end = Date.parse(`${window.to}T00:00:00Z`);
  for (let t = Date.parse(`${window.from}T00:00:00Z`); t < end; t += DAY_MS) out.push(dayOf(t));
  return out;
}

interface CurrencyTotal {
  currency: string;
  orders: number;
}

/** The tabs: one per currency in the report, most orders first (ties alphabetical). */
export function currencyTabs(totals: readonly CurrencyTotal[]): string[] {
  return [...totals]
    .sort((a, b) => b.orders - a.orders || a.currency.localeCompare(b.currency))
    .map((t) => t.currency);
}

/**
 * #502 nit: a currency the FINANCE report has but sales do not (captures or refunds without placed orders in the
 * window) must still be reachable. Sales currencies first (most orders first), then the finance-only ones,
 * alphabetically.
 */
export function mergeCurrencyTabs(
  salesTabs: readonly string[],
  financeCurrencies: readonly string[],
): string[] {
  const extra = [...new Set(financeCurrencies)].filter((c) => !salesTabs.includes(c)).sort();
  return [...salesTabs, ...extra];
}

/**
 * #502 nit: a store the report names but the principal's store list lacks is shown by its FULL id (a prefix could
 * collide and would hide which store it is).
 */
export function storeLabel(stores: readonly StoreRef[], id: string): string {
  return stores.find((s) => s.store_id === id)?.code ?? id;
}

/** The requested currency when the report has it, else the first tab; null when there is nothing to show. */
export function pickCurrency(
  tabs: readonly string[],
  requested: string | undefined,
): string | null {
  if (requested && CURRENCY.test(requested) && tabs.includes(requested)) return requested;
  return tabs[0] ?? null;
}

export interface StoreRef {
  store_id: string;
  code: string;
}

/** Stores in a fixed order (by code) with their colour slot; null past the eighth (table only, never a new hue). */
export function storeColors(stores: readonly StoreRef[]): Map<string, string | null> {
  const sorted = [...stores].sort((a, b) => a.code.localeCompare(b.code));
  return new Map(sorted.map((s, i) => [s.store_id, SERIES_COLORS[i] ?? null]));
}

interface SalesRow {
  store_id: string;
  day: string;
  currency: string;
  net_minor: number;
  orders: number;
}

export interface Series {
  storeId: string;
  values: number[];
}

/**
 * One series per store that has rows in `currency`, one value per day of the window (0 on a day without sales).
 * Rows in any other currency are ignored: a series never mixes currencies.
 */
export function dailySeries(
  rows: readonly SalesRow[],
  currency: string,
  days: readonly string[],
  measure: 'net_minor' | 'orders',
): Series[] {
  const index = new Map(days.map((d, i) => [d, i]));
  const byStore = new Map<string, number[]>();
  for (const r of rows) {
    if (r.currency !== currency) continue;
    const i = index.get(r.day);
    if (i === undefined) continue;
    let values = byStore.get(r.store_id);
    if (!values) {
      values = days.map(() => 0);
      byStore.set(r.store_id, values);
    }
    values[i] = (values[i] ?? 0) + r[measure];
  }
  return [...byStore.entries()].map(([storeId, values]) => ({ storeId, values }));
}

/** A query string for a BI link, keeping the window and replacing the given keys. */
export function biHref(
  window: ReportWindow,
  params: Record<string, string | undefined> = {},
): string {
  const q = new URLSearchParams({ from: window.from, to: window.to });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  return `/bi?${q.toString()}`;
}
