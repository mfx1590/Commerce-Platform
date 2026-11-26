// Runs a compiled query on the read-only ClickHouse user and shapes the contract's `MetricResult`: rows merged across
// sources by key (period, currency, dimensions), ratios computed per row and per currency total from their inputs
// (never summed), `order_by` + `limit`, per-currency totals (never across currencies) and `data_as_of`. A ClickHouse
// failure is a 503 that returns nothing partial (fail closed).
// BI v2 (#871): the new row keys (country, sales channel, category, customer type, warehouse), the stock scope, and
// `compare` — the comparison range runs as a second query and is matched by OFFSET (comparisonRange), never by key.
// BI v2 wave 2 (#935): the new row keys; distribution metrics (quantiles, one decimal, never summed); totals of
// `total: 'query'` metrics from their own query over every row in scope; per-customer values suppressed under
// MIN_CUSTOMERS customers, with a complementary cell; utm values past the answer's top 50, or PII-shaped, → `other`;
// promotions from Postgres through `ExecuteOptions.promotions`.
import { AppError } from '../../../lib/errors';
import { LIMITS, METRICS, MIN_CUSTOMERS, type MetricId } from './catalogue';
import {
  additiveMetrics,
  compileMetricQuery,
  partitionsCustomers,
  POSTGRES_SOURCES,
  restsOnCustomers,
  type Compiled,
  type StockScope,
} from './compile';
import { comparisonRange, type CompareMode, type MetricQuery } from './query';

/** The read path: the `analytics_ro` user, no per-query settings (a readonly user is refused any). */
export interface MetricsReader {
  query(p: {
    query: string;
    format: 'JSONEachRow';
    query_params?: Record<string, unknown>;
    /** Parameters (and the SQL) in the multipart BODY: a long id list never hits the URL / form-field limit. */
    use_multipart_params?: boolean;
  }): Promise<{ json<T>(): Promise<T[]> }>;
}

export interface MetricRow {
  period: string | null;
  currency: string | null;
  store_id: string | null;
  product_id: string | null;
  refund_reason: string | null;
  provider: string | null;
  country: string | null;
  sales_channel_id: string | null;
  category_id: string | null;
  customer_type: string | null;
  warehouse_id: string | null;
  // BI v2 wave 2 (#935)
  customer_group_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  campaign_id: string | null;
  promotion_id: string | null;
  carrier: string | null;
  failure_reason: string | null;
  /** Per-customer values of this row are null: fewer than MIN_CUSTOMERS customers, or its complementary cell. */
  suppressed: boolean;
  values: Record<string, number | null>;
}

/** The id-valued columns of a row a CSV or a label map refers to. */
export type DimensionColumn =
  | 'store_id'
  | 'product_id'
  | 'refund_reason'
  | 'provider'
  | 'country'
  | 'sales_channel_id'
  | 'category_id'
  | 'customer_type'
  | 'warehouse_id'
  | 'customer_group_id'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'campaign_id'
  | 'promotion_id'
  | 'carrier'
  | 'failure_reason';

/** Display names for the ids an answer holds (#871 a3), resolved by the route under the caller's scope. */
export interface MetricLabels {
  store?: Record<string, string>;
  product?: Record<string, string>;
  category?: Record<string, string>;
  sales_channel?: Record<string, string>;
  warehouse?: Record<string, string>;
  // BI v2 wave 2 (#935)
  customer_group?: Record<string, string>;
  campaign?: Record<string, string>;
  promotion?: Record<string, string>;
}

type CurrencyTotals = {
  currency: string | null;
  values: Record<string, number | null>;
  /** #935: per-customer totals are suppressed under MIN_CUSTOMERS customers too. */
  suppressed?: boolean;
}[];

export interface MetricComparison {
  mode: CompareMode;
  from: string;
  to: string;
  offset: string;
  current_incomplete: boolean;
  truncated: boolean;
  rows: MetricRow[];
  currency_totals: CurrencyTotals;
  changes: {
    currency: string | null;
    metric: MetricId;
    current: number | null;
    previous: number | null;
    change: number | null;
    change_bp: number | null;
  }[];
}

export interface MetricResult {
  query: MetricQuery;
  generated_at: string;
  data_as_of: string | null;
  truncated: boolean;
  rows: MetricRow[];
  currency_totals: CurrencyTotals;
  compare?: MetricComparison | null;
  labels?: MetricLabels;
}

/** Integer half-up division for non-negative money; null when the divisor is 0 (never a fake 0). */
function ratio(num: number | null, den: number | null, scale = 1): number | null {
  if (num === null || den === null || den === 0) return null;
  const n = BigInt(num) * BigInt(scale);
  const d = BigInt(den);
  const neg = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const q = (2n * a + b) / (2n * b);
  return Number(neg ? -q : q);
}

function derive(
  values: Record<string, number | null>,
  metrics: readonly MetricId[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of metrics) {
    if (m === 'aov_minor') out[m] = ratio(values.bookings_minor ?? 0, values.orders ?? 0);
    else if (m === 'refund_rate_bp')
      out[m] = ratio(values.refunds_minor ?? 0, values.bookings_minor ?? 0, 10_000);
    else if (m === 'items_per_order_bp')
      out[m] = ratio(values.units ?? 0, values.orders ?? 0, 10_000);
    else if (m === 'cancellation_rate_bp')
      out[m] = ratio(values.cancelled_orders ?? 0, values.placed_orders ?? 0, 10_000);
    else if (m === 'return_rate_bp')
      out[m] = ratio(values.returned_units ?? 0, values.units ?? 0, 10_000);
    else if (m === 'product_return_rate_bp')
      out[m] = ratio(values.product_returned_units ?? 0, values.units ?? 0, 10_000);
    // BI v2 wave 2 (#935)
    else if (m === 'repeat_rate_bp')
      out[m] = ratio(values.repeat_customers ?? 0, values.customers ?? 0, 10_000);
    else if (m === 'orders_per_customer_bp')
      out[m] = ratio(values.customer_orders ?? 0, values.customers ?? 0, 10_000);
    else if (m === 'revenue_per_customer_minor')
      out[m] = ratio(values.customer_net_sales_minor ?? 0, values.customers ?? 0);
    else if (m === 'payment_failure_rate_bp')
      out[m] = ratio(values.payments_failed ?? 0, values.payments_with_outcome ?? 0, 10_000);
    else if (METRICS[m].kind === 'distribution') out[m] = values[m] ?? null;
    // a campaign with no planned budget in the range has none: null, never 0 (#951 review 5)
    else if (m === 'campaign_budget_minor') out[m] = values[m] ?? null;
    else out[m] = values[m] ?? 0;
  }
  return out;
}

type Raw = Record<string, string | number | null>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/** An empty key (a LEFT JOIN that found no order: its country is '') is no key. */
const dimKey = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);
const int = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isSafeInteger(n)) throw new Error(`metrics: a non-integer aggregate (${String(v)})`);
  return n;
};
/** A distribution value (#935): hours with one decimal; null when ClickHouse has none (nan on an empty group). */
const hours = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return v === null || v === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
};
const valueOf = (m: MetricId, v: unknown): number | null =>
  METRICS[m].kind === 'distribution' ? hours(v) : int(v);

/** The row key a compiled source's raw row maps to (every source answers in the same `out_*` columns). */
function rowOf(r: Raw, currencyKey: boolean): Omit<MetricRow, 'values' | 'suppressed'> {
  return {
    period: str(r.out_period),
    currency: currencyKey ? str(r.out_currency) : null,
    store_id: str(r.out_store),
    product_id: str(r.out_product),
    refund_reason: str(r.out_reason),
    provider: str(r.out_provider),
    country: dimKey(r.out_country),
    sales_channel_id: dimKey(r.out_channel),
    category_id: dimKey(r.out_category),
    customer_type: dimKey(r.out_ctype),
    warehouse_id: dimKey(r.out_warehouse),
    customer_group_id: dimKey(r.out_cgroup),
    utm_source: dimKey(r.out_utm_source),
    utm_medium: dimKey(r.out_utm_medium),
    utm_campaign: dimKey(r.out_utm_campaign),
    campaign_id: dimKey(r.out_campaign),
    promotion_id: dimKey(r.out_promotion),
    carrier: dimKey(r.out_carrier),
    failure_reason: dimKey(r.out_failure),
  };
}

// ---- utm values (#935 decision 5) ----------------------------------------------------------------------------------
const UTM_COLUMNS = ['utm_source', 'utm_medium', 'utm_campaign'] as const;
/** PII shapes (the ingest sweep's families, by shape): e-mail, phone-like or long digit runs, token-like strings. */
const PII_SHAPES = [/@/, /\d[\d\s().+-]{6,}\d/, /\d{6,}/, /[a-z0-9_-]{24,}/i, /%40|%2b/i];
export function utmValue(v: string): string {
  return PII_SHAPES.some((re) => re.test(v)) ? 'other' : v;
}

/** The loader of the Postgres sources (#935 promotions): raw rows in the compiled `out_*` / `m_*` shape. */
export type PostgresSourceLoader = (
  q: MetricQuery,
  scope: readonly string[],
  metrics: readonly MetricId[],
  currencyKey: boolean,
) => Promise<Raw[]>;

export interface ExecuteOptions {
  now?: () => Date;
  /** Required when a `stock` metric is asked for (compile.ts). */
  stock?: StockScope;
  /**
   * Keep EVERY row (no `limit` cut, `truncated` false): listMetricMovers ranks over all keys of both ranges, never a
   * slice (#924 review). Its callers bound what they show themselves.
   */
  noLimit?: boolean;
  /** Postgres-backed metrics (#935 promotions); a query asking for them without a loader is a 503. */
  promotions?: PostgresSourceLoader;
  /** The row cap instead of `q.limit` (#935: CSV up to LIMITS.max_csv_rows). */
  limit?: number;
}

export async function executeMetricQuery(
  reader: MetricsReader,
  q: MetricQuery,
  scope: readonly string[],
  opts: ExecuteOptions | (() => Date) = {},
): Promise<MetricResult> {
  const o: ExecuteOptions = typeof opts === 'function' ? { now: opts } : opts;
  const now = o.now ?? (() => new Date());
  if (!q.compare) return runOne(reader, q, scope, o, now);
  const range = comparisonRange(q, q.compare);
  const prevQuery: MetricQuery = { ...q, from: range.from, to: range.to };
  delete prevQuery.compare;
  const [current, previous] = await Promise.all([
    runOne(reader, q, scope, o, now),
    runOne(reader, prevQuery, scope, o, now),
  ]);
  const prevTotals = new Map(previous.currency_totals.map((t) => [t.currency, t.values]));
  const changes: MetricComparison['changes'] = [];
  for (const t of current.currency_totals)
    for (const m of q.metrics) {
      const cur = t.values[m] ?? null;
      const prev = prevTotals.get(t.currency)?.[m] ?? null;
      const change = cur === null || prev === null ? null : cur - prev;
      changes.push({
        currency: t.currency,
        metric: m,
        current: cur,
        previous: prev,
        change,
        // a distribution's change is a difference in hours, never a % (#935 a1)
        change_bp:
          change === null || prev === null || prev === 0 || METRICS[m].kind === 'distribution'
            ? null
            : ratio(change, prev, 10_000),
      });
    }
  return {
    ...current,
    compare: {
      mode: q.compare,
      from: range.from,
      to: range.to,
      offset: range.offset,
      current_incomplete:
        current.data_as_of === null ||
        Date.parse(`${q.to}T00:00:00Z`) > Date.parse(current.data_as_of),
      truncated: previous.truncated,
      rows: previous.rows,
      currency_totals: previous.currency_totals,
      changes,
    },
  };
}

async function runOne(
  reader: MetricsReader,
  q: MetricQuery,
  scope: readonly string[],
  o: ExecuteOptions,
  now: () => Date,
): Promise<MetricResult> {
  const compiled: Compiled = compileMetricQuery(q, scope, o.stock ? { stock: o.stock } : {});
  const additive = additiveMetrics(q.metrics, q);
  const pgMetrics = additive.filter((m) => POSTGRES_SOURCES.has(METRICS[m].source!.id));
  // #935: metrics whose total is a query of its own (distinct counts, quantiles), asked again over every row in scope
  const queryTotals = additive.filter((m) => METRICS[m].total === 'query');
  const totalsCompiled =
    queryTotals.length > 0
      ? compileMetricQuery({ ...q, metrics: queryTotals, dimensions: [], grain: 'total' }, scope, {
          ...(o.stock ? { stock: o.stock } : {}),
          currencyKey: compiled.currencyKey,
        })
      : null;
  const run = (c: Compiled) =>
    Promise.all(
      c.sources.map(async (s) =>
        (
          await reader.query({
            query: s.sql,
            format: 'JSONEachRow',
            query_params: s.params,
            use_multipart_params: true,
          })
        ).json<Raw>(),
      ),
    );
  if (pgMetrics.length > 0 && !o.promotions)
    throw new AppError('unavailable', 'promotion metrics are not available here', {
      metrics: pgMetrics,
    });
  let results: Raw[][];
  let totalsRaw: Raw[][];
  let pgRows: Raw[];
  let asOf: { t: string | null }[];
  try {
    [results, totalsRaw, asOf, pgRows] = await Promise.all([
      run(compiled),
      totalsCompiled ? run(totalsCompiled) : Promise.resolve([]),
      // a promise, not an `await` inside the array: awaiting here would leave the sources' rejection unhandled
      // (Node's default kills the process) whenever ClickHouse is down
      (async () =>
        (
          await reader.query({
            query: 'SELECT if(count() = 0, NULL, toString(max(ingested_at))) AS t FROM raw_events',
            format: 'JSONEachRow',
          })
        ).json<{ t: string | null }>())(),
      pgMetrics.length > 0
        ? o.promotions!(q, scope, pgMetrics, compiled.currencyKey)
        : Promise.resolve([]),
    ]);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('unavailable', 'Analytics store unavailable', {
      reason: (err as Error).name,
    });
  }

  // utm values (#935 decision 5): PII-shaped → `other`, then only the answer's top values by attributed orders
  const utmTop = topUtmValues([...results.flat()]);

  // merge the sources by key
  const merged = new Map<
    string,
    { row: Omit<MetricRow, 'values' | 'suppressed'>; values: Record<string, number | null> }
  >();
  const add = (r: Raw, metrics: readonly MetricId[]) => {
    const row = rowOf(r, compiled.currencyKey);
    for (const c of UTM_COLUMNS) {
      const v = row[c];
      if (v !== null) row[c] = utmTop[c].has(utmValue(v)) ? utmValue(v) : 'other';
    }
    const key = JSON.stringify(row);
    const cur = merged.get(key) ?? { row, values: {} };
    for (const m of metrics) {
      const v = valueOf(m, r[`m_${m}`]);
      // a distribution is never summed: one source row per key (utm folding only ever merges sums)
      cur.values[m] =
        METRICS[m].kind === 'distribution' ? v : ((cur.values[m] ?? 0) as number) + (v ?? 0);
    }
    merged.set(key, cur);
  };
  compiled.sources.forEach((s, i) => results[i]!.forEach((r) => add(r, s.metrics)));
  pgRows.forEach((r) => add(r, pgMetrics));

  let rows: MetricRow[] = [...merged.values()].map(({ row, values }) => ({
    ...row,
    suppressed: false,
    values: derive(values, q.metrics),
  }));
  // small cells (#935 c, the #951 review rule): on an answer resting on customers
  const unsafe = restsOnCustomers(q)
    ? suppressSmallCells(
        rows,
        [...merged.values()].map((x) => x.values),
        partitionsCustomers(q),
      )
    : new Set<string | null>();
  const keyOf = (r: MetricRow) =>
    [
      r.period,
      r.currency,
      r.store_id,
      r.product_id,
      r.refund_reason,
      r.provider,
      r.country,
      r.sales_channel_id,
      r.category_id,
      r.customer_type,
      r.warehouse_id,
      r.customer_group_id,
      r.utm_source,
      r.utm_medium,
      r.utm_campaign,
      r.campaign_id,
      r.promotion_id,
      r.carrier,
      r.failure_reason,
    ]
      .map((x) => x ?? '')
      .join('|');
  rows.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  if (q.order_by) {
    const { metric, direction } = q.order_by;
    const sign = direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const x = a.values[metric] ?? null;
      const y = b.values[metric] ?? null;
      if (x === y) return 0;
      if (x === null) return 1; // nulls last either way
      if (y === null) return -1;
      return (x - y) * sign;
    });
  }
  const limit = o.limit ?? q.limit;
  const truncated = !o.noLimit && rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);

  // per currency over every merged row (not only the shown ones); ratios recomputed from the totals
  const totals = new Map<string | null, Record<string, number | null>>();
  for (const { row, values } of merged.values()) {
    const t = totals.get(row.currency) ?? {};
    for (const [m, v] of Object.entries(values)) t[m] = (t[m] ?? 0) + (v ?? 0);
    totals.set(row.currency, t);
  }
  // #935: the `total: 'query'` metrics come from their own query, never from the rows
  if (totalsCompiled) {
    for (const t of totals.values()) for (const m of queryTotals) t[m] = null;
    totalsCompiled.sources.forEach((s, i) => {
      for (const r of totalsRaw[i]!) {
        const currency = compiled.currencyKey ? str(r.out_currency) : null;
        const t = totals.get(currency) ?? {};
        for (const m of s.metrics) t[m] = valueOf(m, r[`m_${m}`]);
        totals.set(currency, t);
      }
    });
  }
  const currency_totals = [...totals.entries()]
    .sort(([a], [b]) => String(a ?? '').localeCompare(String(b ?? '')))
    .map(([currency, values]) => {
      const v = derive(values, q.metrics);
      // a distinct count (product_orders) is not the sum of its rows: no total rather than a wrong one
      for (const m of q.metrics) if (METRICS[m].total === 'none') v[m] = null;
      // a total is shown only when what it adds beyond the visible rows covers MIN_CUSTOMERS customers or more
      const small =
        unsafe.has(currency) || (restsOnCustomers(q) && (values.customers ?? 0) < MIN_CUSTOMERS);
      if (small) for (const m of q.metrics) v[m] = null;
      return { currency, values: v, ...(small ? { suppressed: true } : {}) };
    });

  return {
    query: q,
    generated_at: now().toISOString(),
    data_as_of: asOf[0]?.t ? `${asOf[0].t.replace(' ', 'T')}Z` : null,
    truncated,
    rows,
    currency_totals,
  };
}

/** The utm values an answer shows per column (#935): its top LIMITS.utm_top by attributed orders, PII-shaped out. */
function topUtmValues(raw: readonly Raw[]): Record<(typeof UTM_COLUMNS)[number], Set<string>> {
  const out = {} as Record<(typeof UTM_COLUMNS)[number], Set<string>>;
  const col = {
    utm_source: 'out_utm_source',
    utm_medium: 'out_utm_medium',
    utm_campaign: 'out_utm_campaign',
  };
  for (const c of UTM_COLUMNS) {
    const weight = new Map<string, number>();
    for (const r of raw) {
      const v = dimKey(r[col[c]]);
      if (v === null) continue;
      const u = utmValue(v);
      if (u === 'other') continue;
      const w = Number(r.m_attributed_orders ?? r.m_attributed_net_sales_minor ?? 1);
      weight.set(u, (weight.get(u) ?? 0) + (Number.isFinite(w) ? w : 1));
    }
    out[c] = new Set(
      [...weight.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, LIMITS.utm_top)
        .map(([v]) => v),
    );
  }
  return out;
}

/**
 * Small cells (#935 c; the rule of the #951 review): no figure in one answer, alone or added to / subtracted from the
 * other figures of the same answer, may reveal a value resting on fewer than MIN_CUSTOMERS customers.
 *   * A row of fewer than MIN_CUSTOMERS customers is hidden WHOLE (every value null: money, counts, ratios — the same
 *     figure under another metric id is no way round it).
 *   * Within each (period, currency) group the hidden rows must together cover at least MIN_CUSTOMERS customers: the
 *     smallest visible rows are hidden with them until they do. Then a total minus the visible rows is an aggregate
 *     of at least MIN_CUSTOMERS customers.
 *   * When even the whole group covers fewer, every row of it is hidden and its currency's totals are hidden too
 *     (returned: the currencies whose totals must not show).
 * `partitioned`: rows are disjoint in customers (store, customer group), so their customers add up; otherwise one
 * customer can sit in two rows, and only the largest row is a safe lower bound of what several cover.
 */
export function suppressSmallCells(
  rows: MetricRow[],
  raw: readonly Record<string, number | null>[],
  partitioned: boolean,
): Set<string | null> {
  const customers = raw.map((v) => v.customers ?? 0);
  const hide = (i: number) => {
    rows[i]!.suppressed = true;
    for (const m of Object.keys(rows[i]!.values)) rows[i]!.values[m] = null;
  };
  const cover = (idx: readonly number[]) =>
    partitioned
      ? idx.reduce((n, i) => n + customers[i]!, 0)
      : idx.reduce((n, i) => Math.max(n, customers[i]!), 0);
  const unsafe = new Set<string | null>();
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = JSON.stringify([r.period, r.currency]);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  for (const idx of groups.values()) {
    const hidden = idx.filter((i) => customers[i]! < MIN_CUSTOMERS);
    if (hidden.length === 0) continue;
    const visible = idx
      .filter((i) => !hidden.includes(i))
      .sort((a, b) => customers[a]! - customers[b]! || a - b);
    while (cover(hidden) < MIN_CUSTOMERS && visible.length > 0) hidden.push(visible.shift()!);
    hidden.forEach(hide);
    if (cover(hidden) < MIN_CUSTOMERS) unsafe.add(rows[idx[0]!]!.currency);
  }
  return unsafe;
}

/** For a test or a log line: whether every compiled statement carries the scope predicate. */
export function scopedEverywhere(
  q: MetricQuery,
  scope: readonly string[],
  stock?: StockScope,
): boolean {
  return compileMetricQuery(q, scope, stock ? { stock } : {}).sources.every((s) =>
    s.source === 'stock'
      ? s.sql.includes('organization_id = {org:UUID}') ||
        s.sql.includes('stock_item_id IN {items:Array(UUID)}')
      : s.sql.includes('store_id IN {scope:Array(UUID)}') && Array.isArray(s.params.scope),
  );
}

export { METRICS };
