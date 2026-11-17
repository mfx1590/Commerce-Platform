// Runs a compiled query on the read-only ClickHouse user and shapes the contract's `MetricResult`: rows merged across
// sources by key (period, currency, dimensions), ratios computed per row and per currency total from their inputs
// (never summed), `order_by` + `limit`, per-currency totals (never across currencies) and `data_as_of`. A ClickHouse
// failure is a 503 that returns nothing partial (fail closed).
// BI v2 (#871): the new row keys (country, sales channel, category, customer type, warehouse), the stock scope, and
// `compare` — the comparison range runs as a second query and is matched by OFFSET (comparisonRange), never by key.
import { AppError } from '../../../lib/errors';
import { METRICS, type MetricId } from './catalogue';
import { compileMetricQuery, type Compiled, type StockScope } from './compile';
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
  | 'warehouse_id';

/** Display names for the ids an answer holds (#871 a3), resolved by the route under the caller's scope. */
export interface MetricLabels {
  store?: Record<string, string>;
  product?: Record<string, string>;
  category?: Record<string, string>;
  sales_channel?: Record<string, string>;
  warehouse?: Record<string, string>;
}

type CurrencyTotals = { currency: string | null; values: Record<string, number | null> }[];

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

export interface ExecuteOptions {
  now?: () => Date;
  /** Required when a `stock` metric is asked for (compile.ts). */
  stock?: StockScope;
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
        change_bp:
          change === null || prev === null || prev === 0 ? null : ratio(change, prev, 10_000),
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
  let results: Raw[][];
  let asOf: { t: string | null }[];
  try {
    [results, asOf] = await Promise.all([
      Promise.all(
        compiled.sources.map(async (s) =>
          (
            await reader.query({
              query: s.sql,
              format: 'JSONEachRow',
              query_params: s.params,
              use_multipart_params: true,
            })
          ).json<Raw>(),
        ),
      ),
      // a promise, not an `await` inside the array: awaiting here would leave the sources' rejection unhandled
      // (Node's default kills the process) whenever ClickHouse is down
      (async () =>
        (
          await reader.query({
            query: 'SELECT if(count() = 0, NULL, toString(max(ingested_at))) AS t FROM raw_events',
            format: 'JSONEachRow',
          })
        ).json<{ t: string | null }>())(),
    ]);
  } catch (err) {
    throw new AppError('unavailable', 'Analytics store unavailable', {
      reason: (err as Error).name,
    });
  }

  // merge the sources by key
  const merged = new Map<
    string,
    { row: Omit<MetricRow, 'values'>; values: Record<string, number | null> }
  >();
  compiled.sources.forEach((s, i) => {
    for (const r of results[i]!) {
      const row = {
        period: str(r.out_period),
        currency: compiled.currencyKey ? str(r.out_currency) : null,
        store_id: str(r.out_store),
        product_id: str(r.out_product),
        refund_reason: str(r.out_reason),
        provider: str(r.out_provider),
        country: dimKey(r.out_country),
        sales_channel_id: dimKey(r.out_channel),
        category_id: dimKey(r.out_category),
        customer_type: dimKey(r.out_ctype),
        warehouse_id: dimKey(r.out_warehouse),
      };
      const key = JSON.stringify(row);
      const cur = merged.get(key) ?? { row, values: {} };
      for (const m of s.metrics) cur.values[m] = (cur.values[m] ?? 0) + int(r[`m_${m}`]);
      merged.set(key, cur);
    }
  });

  let rows: MetricRow[] = [...merged.values()].map(({ row, values }) => ({
    ...row,
    values: derive(values, q.metrics),
  }));
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
  const truncated = rows.length > q.limit;
  if (truncated) rows = rows.slice(0, q.limit);

  // per currency over every merged row (not only the shown ones); ratios recomputed from the totals
  const totals = new Map<string | null, Record<string, number | null>>();
  for (const { row, values } of merged.values()) {
    const t = totals.get(row.currency) ?? {};
    for (const [m, v] of Object.entries(values)) t[m] = (t[m] ?? 0) + (v ?? 0);
    totals.set(row.currency, t);
  }
  const currency_totals = [...totals.entries()]
    .sort(([a], [b]) => String(a ?? '').localeCompare(String(b ?? '')))
    .map(([currency, values]) => {
      const v = derive(values, q.metrics);
      // a distinct count (product_orders) is not the sum of its rows: no total rather than a wrong one
      for (const m of q.metrics) if (METRICS[m].total === 'none') v[m] = null;
      return { currency, values: v };
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
