// Runs a compiled query on the read-only ClickHouse user and shapes the contract's `MetricResult`: rows merged across
// sources by key (period, currency, dimensions), ratios computed per row and per currency total from their inputs
// (never summed), `order_by` + `limit`, per-currency totals (never across currencies) and `data_as_of`. A ClickHouse
// failure is a 503 that returns nothing partial (fail closed).
import { AppError } from '../../../lib/errors';
import { METRICS, type MetricId } from './catalogue';
import { compileMetricQuery, type Compiled } from './compile';
import type { MetricQuery } from './query';

/** The read path: the `analytics_ro` user, no per-query settings (a readonly user is refused any). */
export interface MetricsReader {
  query(p: {
    query: string;
    format: 'JSONEachRow';
    query_params?: Record<string, unknown>;
  }): Promise<{ json<T>(): Promise<T[]> }>;
}

export interface MetricRow {
  period: string | null;
  currency: string | null;
  store_id: string | null;
  product_id: string | null;
  refund_reason: string | null;
  provider: string | null;
  values: Record<string, number | null>;
}

export interface MetricResult {
  query: MetricQuery;
  generated_at: string;
  data_as_of: string | null;
  truncated: boolean;
  rows: MetricRow[];
  currency_totals: { currency: string | null; values: Record<string, number | null> }[];
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
    else out[m] = values[m] ?? 0;
  }
  return out;
}

type Raw = Record<string, string | number | null>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isSafeInteger(n)) throw new Error(`metrics: a non-integer aggregate (${String(v)})`);
  return n;
};

export async function executeMetricQuery(
  reader: MetricsReader,
  q: MetricQuery,
  scope: readonly string[],
  now: () => Date = () => new Date(),
): Promise<MetricResult> {
  const compiled: Compiled = compileMetricQuery(q, scope);
  let results: Raw[][];
  let asOf: { t: string | null }[];
  try {
    [results, asOf] = await Promise.all([
      Promise.all(
        compiled.sources.map(async (s) =>
          (
            await reader.query({ query: s.sql, format: 'JSONEachRow', query_params: s.params })
          ).json<Raw>(),
        ),
      ),
      (
        await reader.query({
          query: 'SELECT if(count() = 0, NULL, toString(max(ingested_at))) AS t FROM raw_events',
          format: 'JSONEachRow',
        })
      ).json<{ t: string | null }>(),
    ]);
  } catch (err) {
    throw new AppError(
      'internal',
      'Analytics store unavailable',
      { reason: (err as Error).name },
      503,
    );
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
    [r.period, r.currency, r.store_id, r.product_id, r.refund_reason, r.provider]
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
    .map(([currency, values]) => ({ currency, values: derive(values, q.metrics) }));

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
export function scopedEverywhere(q: MetricQuery, scope: readonly string[]): boolean {
  return compileMetricQuery(q, scope).sources.every(
    (s) => s.sql.includes('store_id IN {scope:Array(UUID)}') && Array.isArray(s.params.scope),
  );
}

export { METRICS };
