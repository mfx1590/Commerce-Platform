/**
 * BI v2 screens, wave 1 (#869 / #871, Admin API 0.4.30): Overview, Products & categories,
 * Inventory health. Pure — the URL state, the query bodies, and the shaping of the answers. No
 * React, no `next/*`, no I/O.
 *
 * Rules that hold on every view:
 * - money is integer minor units of ONE currency and is never summed across currencies: the
 *   currency is a tab, and every figure on the page belongs to it;
 * - days are UTC, `to` is exclusive, at most 366 days (the existing BI window rules);
 * - a comparison reports what changed, never why;
 * - a metric or dimension the catalogue does not offer to this principal is left out and said,
 *   never asked for (that would be a 400 or 403).
 */

import type { AdminComponents } from '@/lib/api/admin-client';
import { formatMoney } from '@/lib/forms/money';
import { windowFrom, type ReportWindow } from '../_lib/report';

export type MetricId = AdminComponents['MetricId'];
export type MetricQuery = AdminComponents['MetricQuery'];
export type MetricResult = AdminComponents['MetricResult'];
export type MetricRow = AdminComponents['MetricRow'];
export type MetricCatalogue = AdminComponents['MetricCatalogue'];
export type MetricDefinition = AdminComponents['MetricDefinition'];
export type MoversQuery = AdminComponents['MetricMoversQuery'];
export type Movers = AdminComponents['MetricMovers'];
export type InventoryQuery = AdminComponents['InventoryHealthQuery'];
export type InventoryHealth = AdminComponents['InventoryHealth'];
export type InventoryRow = AdminComponents['InventoryHealthRow'];
export type InventoryStatus = AdminComponents['InventoryStatus'];
type Filters = NonNullable<MetricQuery['filters']>;
type Labels = NonNullable<MetricResult['labels']>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------- URL state

export type Raw = Record<string, string | string[] | undefined>;
const one = (raw: Raw, key: string): string => {
  const v = raw[key];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

export const COMPARE_MODES = ['previous_period', 'previous_year', 'none'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export const BREAKDOWNS = ['store', 'country', 'sales_channel', 'category'] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];
export const CUSTOMER_TYPES = ['new', 'returning', 'unknown'] as const;

/** Everything the three views read from the URL. Unknown or malformed values fall back. */
export interface BiState {
  window: ReportWindow;
  compare: CompareMode;
  currency: string;
  by: Breakdown;
  store: string;
  country: string;
  channel: string;
  category: string;
  product: string;
  customer: string;
}

export function parseState(raw: Raw, now: Date = new Date()): BiState {
  const pick = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  const uuid = (key: string) => (UUID.test(one(raw, key)) ? one(raw, key) : '');
  const country = one(raw, 'country').toUpperCase();
  return {
    window: windowFrom({ from: one(raw, 'from'), to: one(raw, 'to') }, now),
    compare: pick(one(raw, 'compare'), COMPARE_MODES, 'previous_period'),
    currency: /^[A-Z]{3}$/.test(one(raw, 'currency')) ? one(raw, 'currency') : '',
    by: pick(one(raw, 'by'), BREAKDOWNS, 'store'),
    store: uuid('store'),
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    channel: uuid('channel'),
    category: uuid('category'),
    product: uuid('product'),
    customer: pick(one(raw, 'customer'), [...CUSTOMER_TYPES, ''] as const, ''),
  };
}

/** The URL for `state` with `changes`, dropping empty values and defaults so links stay short. */
export function stateHref(
  base: string,
  state: BiState,
  changes: Partial<Record<keyof Omit<BiState, 'window'> | 'from' | 'to', string>> = {},
  extra: Record<string, string> = {},
): string {
  const values: Record<string, string> = {
    from: state.window.from,
    to: state.window.to,
    compare: state.compare === 'previous_period' ? '' : state.compare,
    currency: state.currency,
    by: state.by === 'store' ? '' : state.by,
    store: state.store,
    country: state.country,
    channel: state.channel,
    category: state.category,
    product: state.product,
    customer: state.customer,
    ...changes,
    ...extra,
  };
  if (values['compare'] === 'previous_period') values['compare'] = '';
  if (values['by'] === 'store') values['by'] = '';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const text = query.toString();
  return text === '' ? base : `${base}?${text}`;
}

/** The API filters for the state; a store view is always narrowed to its store. */
export function filtersOf(state: BiState, storeId?: string): Filters {
  const filters: Filters = {};
  const store = storeId ?? state.store;
  if (store) filters.store_ids = [store];
  if (state.country) filters.countries = [state.country];
  if (state.channel) filters.sales_channel_ids = [state.channel];
  if (state.category) filters.category_ids = [state.category];
  if (state.product) filters.product_ids = [state.product];
  if (state.customer) {
    filters.customer_types = [state.customer as (typeof CUSTOMER_TYPES)[number]];
  }
  return filters;
}

/** The active filters in words, for headings, empty states and CSV names. */
export function describeState(state: BiState, names: (kind: string, id: string) => string): string {
  const parts: string[] = [];
  if (state.store) parts.push(`store ${names('store', state.store)}`);
  if (state.country) parts.push(`country ${state.country}`);
  if (state.channel) parts.push(`channel ${names('sales_channel', state.channel)}`);
  if (state.category) parts.push(`category ${names('category', state.category)}`);
  if (state.product) parts.push(`product ${names('product', state.product)}`);
  if (state.customer) parts.push(`${state.customer} customers`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------- catalogue

/** The catalogue's definition of a metric, or undefined when this principal is not offered it. */
export function definitionOf(
  catalogue: MetricCatalogue,
  id: MetricId,
): MetricDefinition | undefined {
  return catalogue.metrics.find((metric) => metric.id === id && metric.available);
}

/**
 * The metrics of `wanted` the catalogue offers (for `dimension`, when one is asked), in order.
 * The rest come back as `missing`, so the page can say what it cannot show.
 */
export function offered(
  catalogue: MetricCatalogue,
  wanted: readonly MetricId[],
  dimension?: string,
): { metrics: MetricId[]; missing: MetricId[] } {
  const metrics: MetricId[] = [];
  const missing: MetricId[] = [];
  for (const id of wanted) {
    const definition = definitionOf(catalogue, id);
    const fits =
      definition !== undefined &&
      (dimension === undefined || (definition.dimensions as string[]).includes(dimension));
    (fits ? metrics : missing).push(id);
  }
  return { metrics, missing };
}

/** Splits `metrics` into queries of at most the catalogue's `max_metrics`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

// ---------------------------------------------------------------------------- formatting

/**
 * How a value reads, by what the metric MEANS (#927 review): the API's `bp` unit is "× 10 000",
 * which is a percentage for a rate (`refund_rate_bp`, `return_rate_bp`, `cancellation_rate_bp`,
 * `product_return_rate_bp`: 1 250 = 12.5 %) but a plain ratio for anything else
 * (`items_per_order_bp`: 21 429 = 2.14 items per order, never "214.3 %").
 */
// `hours` (Admin API 0.4.31, #935): distribution metrics, hours with one decimal (10.5 h), no currency.
export type DisplayUnit = 'minor' | 'count' | 'milli' | 'percent' | 'ratio' | 'hours';

export function displayUnitOf(
  definition: Pick<MetricDefinition, 'unit'> | undefined,
  metric: string,
): DisplayUnit {
  const unit = (definition?.unit ?? 'count') as MetricDefinition['unit'] | 'hours';
  if (unit !== 'bp') return unit;
  return metric.endsWith('_rate_bp') ? 'percent' : 'ratio';
}

/** What the page shows for a value the API did not compute (never 0, never a blank). */
export const NOT_COMPUTED = 'not computed';

/**
 * A value in its display unit: money in the currency (JPY with no decimals), a rate as %, a ratio
 * as a number with two decimals, milli as ×1/1000. A missing value is "not computed".
 */
export function formatValue(
  value: number | null | undefined,
  unit: DisplayUnit,
  currency: string | null,
  locale = 'en-GB',
): string {
  if (value === null || value === undefined) return NOT_COMPUTED;
  switch (unit) {
    case 'minor':
      return currency === null ? String(value) : formatMoney(value, currency, locale);
    case 'percent':
      return `${(value / 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %`;
    case 'ratio':
      return (value / 10000).toLocaleString(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    case 'milli':
      return (value / 1000).toLocaleString(locale, { maximumFractionDigits: 1 });
    case 'hours':
      return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} h`;
    default:
      return value.toLocaleString(locale);
  }
}

/**
 * A change as people read it. Money and counts: the signed difference and the percentage
 * (`change_bp`, null when the API withholds it below its minimum base). A rate (bp): percentage
 * POINTS, never a percentage of a percentage.
 */
export function formatChange(
  change: number | null | undefined,
  changeBp: number | null | undefined,
  unit: DisplayUnit,
  currency: string | null,
  locale = 'en-GB',
): string {
  if (change === null || change === undefined) return 'no comparison';
  const sign = change > 0 ? '+' : change < 0 ? '−' : '±';
  if (unit === 'percent') {
    return `${sign}${(Math.abs(change) / 100).toLocaleString(locale, { maximumFractionDigits: 1 })} pts`;
  }
  if (unit === 'ratio') {
    // A ratio changes by its own amount (2.02 → 2.14 is +0.12), plus the relative change.
    const percent =
      changeBp === null || changeBp === undefined
        ? ''
        : ` (${changeBp > 0 ? '+' : changeBp < 0 ? '−' : '±'}${(Math.abs(changeBp) / 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %)`;
    return `${sign}${formatValue(Math.abs(change), 'ratio', null, locale)}${percent}`;
  }
  const amount = formatValue(Math.abs(change), unit, currency, locale);
  const percent =
    changeBp === null || changeBp === undefined
      ? ''
      : ` (${changeBp > 0 ? '+' : changeBp < 0 ? '−' : '±'}${(Math.abs(changeBp) / 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %)`;
  return `${sign}${amount}${percent}`;
}

/** Direction for colour: up, down or flat — the page never says whether that is good. */
export function trend(change: number | null | undefined): 'up' | 'down' | 'flat' | 'none' {
  if (change === null || change === undefined) return 'none';
  return change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
}

// ---------------------------------------------------------------------------- answers

/** The currencies an answer holds (money metrics), most valuable first; counts-only → []. */
export function currenciesOf(result: Pick<MetricResult, 'currency_totals'>): string[] {
  return result.currency_totals
    .map((total) => total.currency)
    .filter((currency): currency is string => currency !== null);
}

export function pickCurrency(available: readonly string[], wanted: string): string | null {
  if (available.length === 0) return null;
  return available.includes(wanted) ? wanted : available[0]!;
}

export interface Kpi {
  metric: MetricId;
  current: number | null;
  previous: number | null;
  change: number | null;
  changeBp: number | null;
}

/**
 * The headline figures of one currency from total-grain answers (one per metric chunk): money
 * metrics from that currency's totals, counts from the currency-less totals when the API keys
 * them so, else from the currency's row. The comparison from `compare.changes`.
 */
export function kpisOf(
  results: readonly MetricResult[],
  metrics: readonly MetricId[],
  currency: string | null,
): Kpi[] {
  const valueOf = (result: MetricResult, metric: MetricId): number | null => {
    const totals =
      result.currency_totals.find((t) => t.currency === currency) ??
      result.currency_totals.find((t) => t.currency === null);
    const raw = (totals?.values as Record<string, number | null> | undefined)?.[metric];
    return typeof raw === 'number' ? raw : null;
  };
  return metrics.map((metric) => {
    const result = results.find((r) => r.query.metrics.includes(metric));
    if (result === undefined) {
      return { metric, current: null, previous: null, change: null, changeBp: null };
    }
    const change =
      result.compare?.changes.find((c) => c.metric === metric && c.currency === currency) ??
      result.compare?.changes.find((c) => c.metric === metric && c.currency === null);
    return {
      metric,
      current: change?.current ?? valueOf(result, metric),
      previous: change?.previous ?? null,
      change: change?.change ?? null,
      changeBp: change?.change_bp ?? null,
    };
  });
}

/** The key of a row under one dimension. */
export function keyOf(row: MetricRow, dimension: string): string | null {
  const field = dimension === 'sales_channel' ? 'sales_channel_id' : `${dimension}_id`;
  const record = row as unknown as Record<string, string | null>;
  return dimension === 'country' ? row.country : (record[field] ?? null);
}

export interface BreakdownLine {
  key: string;
  label: string;
  values: Record<string, number | null>;
  previous: Record<string, number | null>;
}

/** Display name of an id under a dimension: the answer's label, else the start of the id. */
export function labelOf(labels: Labels | undefined, dimension: string, key: string): string {
  if (dimension === 'country') return key;
  const map = (labels as Record<string, Record<string, string> | undefined> | undefined)?.[
    dimension
  ];
  // The API labels a deleted record "(deleted)" itself; an id it did not label is one the caller
  // may not read, or that is unknown — said in words, never shown as an id prefix.
  return map?.[key] ?? 'unknown';
}

/** One currency's rows by `dimension`, each with its previous-period values when compared. */
export function breakdownOf(
  result: MetricResult,
  dimension: string,
  currency: string | null,
): BreakdownLine[] {
  const inCurrency = (row: MetricRow) => row.currency === currency || row.currency === null;
  const previous = new Map<string, Record<string, number | null>>();
  for (const row of result.compare?.rows ?? []) {
    const key = keyOf(row, dimension);
    if (key !== null && inCurrency(row))
      previous.set(key, row.values as Record<string, number | null>);
  }
  return result.rows
    .filter(inCurrency)
    .map((row) => ({ row, key: keyOf(row, dimension) }))
    .filter((line): line is { row: MetricRow; key: string } => line.key !== null)
    .map(({ row, key }) => ({
      key,
      label: labelOf(result.labels, dimension, key),
      values: row.values as Record<string, number | null>,
      previous: previous.get(key) ?? {},
    }));
}

/** The movers block of one currency (counts form one block with currency null). */
export function moversFor(movers: Movers, currency: string | null) {
  return (
    movers.by_currency.find((block) => block.currency === currency) ??
    movers.by_currency.find((block) => block.currency === null) ??
    null
  );
}

// ---------------------------------------------------------------------------- inventory

export const INVENTORY_STATUSES = [
  'stock_out',
  'low',
  'reorder',
  'dead',
  'overstock',
  'ok',
] as const;
export const INVENTORY_SORTS = [
  // Most urgent first (the default): out of stock, then low by days of cover, then the rest by
  // cover; items without a cover last. Asked of the API as days of cover, ordered here per page.
  'urgency',
  'days_of_cover',
  'suggested_reorder_units',
  'available',
  'units_sold_per_day_milli',
  'sku',
] as const;

/** What each status means, in the owner's words. */
export const STATUS_WORDS: Record<InventoryStatus, string> = {
  stock_out: 'Out of stock',
  low: 'Low — order now',
  reorder: 'Reorder point reached',
  dead: 'Stock but no sales',
  overstock: 'Overstocked',
  ok: 'OK',
};

export interface InventoryState {
  statuses: InventoryStatus[];
  q: string;
  sort: (typeof INVENTORY_SORTS)[number];
  direction: 'asc' | 'desc';
  page: number;
  warehouse: string;
  velocity: number | null;
  lead: number | null;
  cover: number | null;
  dead: number | null;
}

/** The API's bounds for each override (InventoryHealthQuery); outside them the value is ignored. */
export const INVENTORY_BOUNDS = {
  velocity: [7, 90],
  lead: [0, 180],
  cover: [0, 180],
  dead: [14, 365],
} as const;

const days = (value: string, [min, max]: readonly [number, number]): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return n >= min && n <= max ? n : null;
};

export function parseInventory(raw: Raw): InventoryState {
  const statuses = one(raw, 'status')
    .split(',')
    .filter((s): s is InventoryStatus => (INVENTORY_STATUSES as readonly string[]).includes(s));
  const sort = one(raw, 'sort');
  const page = Number.parseInt(one(raw, 'page'), 10);
  return {
    statuses,
    q: one(raw, 'q').trim().slice(0, 100),
    sort: (INVENTORY_SORTS as readonly string[]).includes(sort)
      ? (sort as InventoryState['sort'])
      : 'urgency',
    direction: one(raw, 'dir') === 'desc' ? 'desc' : 'asc',
    page: Number.isFinite(page) && page > 0 ? page : 1,
    warehouse: UUID.test(one(raw, 'warehouse')) ? one(raw, 'warehouse') : '',
    velocity: days(one(raw, 'velocity'), INVENTORY_BOUNDS.velocity),
    lead: days(one(raw, 'lead'), INVENTORY_BOUNDS.lead),
    cover: days(one(raw, 'cover'), INVENTORY_BOUNDS.cover),
    dead: days(one(raw, 'dead'), INVENTORY_BOUNDS.dead),
  };
}

export const INVENTORY_LIMIT = 50;

export function inventoryQuery(
  state: BiState,
  inventory: InventoryState,
  storeId?: string,
): InventoryQuery {
  const store = storeId ?? state.store;
  return {
    ...(store ? { store_ids: [store] } : {}),
    ...(inventory.warehouse ? { warehouse_ids: [inventory.warehouse] } : {}),
    ...(state.category ? { category_ids: [state.category] } : {}),
    ...(state.product ? { product_ids: [state.product] } : {}),
    ...(inventory.statuses.length > 0 ? { status: inventory.statuses } : {}),
    ...(inventory.q ? { q: inventory.q } : {}),
    ...(inventory.velocity !== null ? { velocity_days: inventory.velocity } : {}),
    ...(inventory.lead !== null ? { lead_time_days: inventory.lead } : {}),
    ...(inventory.cover !== null ? { cover_days: inventory.cover } : {}),
    ...(inventory.dead !== null ? { dead_days: inventory.dead } : {}),
    sort: inventory.sort === 'urgency' ? 'days_of_cover' : inventory.sort,
    direction: inventory.sort === 'urgency' ? 'asc' : inventory.direction,
    page: inventory.page,
    limit: INVENTORY_LIMIT,
  };
}

/** Units per day from the API's milli-units, as people read it. */
export function perDay(milli: number | null): string {
  return milli === null
    ? NOT_COMPUTED
    : (milli / 1000).toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

/**
 * The owner's question in one plain line, from the status counts of the whole filtered set (#927
 * review): "N items need ordering (M out of stock, K low); incoming stock is not tracked yet."
 * "Need ordering" = out of stock + low + at the reorder point. During an outage of the sales
 * rates there is no status: "Cannot compute what to order right now …". A status filter narrows
 * what is counted, and the line says so.
 */
export function inventoryAnswer(
  health: Pick<InventoryHealth, 'rate_available' | 'incoming_tracked' | 'summary'>,
  statusFiltered: boolean,
): string {
  if (!health.rate_available) {
    return 'Cannot compute what to order right now: sales rates are unavailable. The stock positions below are live.';
  }
  const count = (status: InventoryStatus) =>
    (health.summary as Record<string, number>)[status] ?? 0;
  const out = count('stock_out');
  const low = count('low');
  const need = out + low + count('reorder');
  const prefix = statusFiltered ? 'Among the statuses shown: ' : '';
  const head =
    need === 0
      ? 'Nothing needs ordering right now'
      : `${need} ${need === 1 ? 'item needs' : 'items need'} ordering (${out} out of stock, ${low} low)`;
  return `${prefix}${head}${health.incoming_tracked ? '.' : '; incoming stock is not tracked yet.'}`;
}

const URGENCY: Partial<Record<InventoryStatus, number>> = { stock_out: 0, low: 1 };

/**
 * Most urgent first: out of stock, then low, then everything else; inside each, fewest days of
 * cover first; an item whose cover is not computed goes last. Stable for equal keys.
 */
export function byUrgency<T extends Pick<InventoryRow, 'status' | 'days_of_cover'>>(
  rows: readonly T[],
): T[] {
  const rank = (row: T) => (row.status === null ? 3 : (URGENCY[row.status] ?? 2));
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byRank = rank(a.row) - rank(b.row);
      if (byRank !== 0) return byRank;
      const ac = a.row.days_of_cover;
      const bc = b.row.days_of_cover;
      if (ac === null && bc !== null) return 1;
      if (bc === null && ac !== null) return -1;
      if (ac !== null && bc !== null && ac !== bc) return ac - bc;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/** Where a row's cover and lead time came from, in words. */
export const PARAMETERS_SOURCE_WORDS: Record<InventoryRow['parameters_source'], string> = {
  request: 'set on this page',
  store: "the store's setting",
  default: 'the platform default',
};
