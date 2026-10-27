// A validated query + the caller's scope → parameterised ClickHouse SQL, one statement per model the query reads.
//
//   * The SCOPE is always in the WHERE: `store_id IN {scope:Array(UUID)}`, from the server, never from the request.
//     A request's `filters.store_ids` only narrows it (the route has already refused an id outside the scope).
//   * Every value is a server-side parameter ({name:Type}); the only text that varies is chosen from the closed
//     catalogue below (column names, aggregates, period functions). No request string is ever concatenated.
//   * Output columns are `out_*` / `m_*`: never a column's own name (a ClickHouse alias shadows the column of the same
//     name in WHERE and GROUP BY; data/clickhouse README).
import { validationError } from '../../../lib/errors';
import { METRICS, type Dimension, type Grain, type MetricId, type SourceId } from './catalogue';
import type { MetricQuery } from './query';

interface SourceSpec {
  from: string;
  /** The UTC day the source is bucketed by. */
  day: string;
  where?: string;
  columns: Partial<Record<Dimension | 'currency', string>>;
}

const SOURCES: Readonly<Record<SourceId, SourceSpec>> = {
  bookings: {
    from: 'mart_bookings_daily',
    day: 'day',
    columns: { store: 'store_id', currency: 'currency' },
  },
  refunds: {
    from: 'fct_refund',
    day: "toDate(issued_at, 'UTC')",
    columns: { store: 'store_id', currency: 'currency', refund_reason: 'reason' },
  },
  lines: {
    from: 'fct_order_line',
    day: "toDate(placed_at, 'UTC')",
    where: "order_status != 'cancelled'",
    columns: { store: 'store_id', currency: 'currency', product: 'product_id' },
  },
  customers: { from: 'mart_customers_daily', day: 'day', columns: { store: 'store_id' } },
  cash: {
    from: 'mart_cash_daily',
    day: 'day',
    columns: { store: 'store_id', currency: 'currency', provider: 'provider' },
  },
  ledger: {
    from: 'fct_ledger_line',
    day: 'entry_date',
    where: 'is_revenue',
    columns: { store: 'store_id', currency: 'currency' },
  },
};

const PERIOD: Readonly<Record<Grain, (day: string) => string>> = {
  day: (d) => `toString(${d})`,
  week: (d) => `toString(toMonday(${d}))`,
  month: (d) => `toString(toStartOfMonth(${d}))`,
  total: () => 'CAST(NULL AS Nullable(String))',
};

const OUT: Readonly<Record<Dimension | 'currency', string>> = {
  store: 'out_store',
  currency: 'out_currency',
  product: 'out_product',
  refund_reason: 'out_reason',
  provider: 'out_provider',
};

export interface CompiledSource {
  source: SourceId;
  sql: string;
  params: Record<string, unknown>;
  /** The additive metrics this statement returns as `m_<id>`. */
  metrics: MetricId[];
}

export interface Compiled {
  /** Money is asked for: `currency` is part of every row's key. */
  currencyKey: boolean;
  sources: CompiledSource[];
}

/** The additive metrics a query needs: the requested ones plus the inputs of the derived ones. */
export function additiveMetrics(metrics: readonly MetricId[]): MetricId[] {
  const out = new Set<MetricId>();
  for (const m of metrics) {
    const def = METRICS[m];
    if (def.derived) for (const i of def.derived.inputs) out.add(i);
    else out.add(m);
  }
  return [...out];
}

export function compileMetricQuery(q: MetricQuery, scope: readonly string[]): Compiled {
  if (scope.length === 0)
    throw new Error('compileMetricQuery: an empty scope never reaches the compiler');
  const currencyKey = q.metrics.some((m) => METRICS[m].currency_bound);
  const bySource = new Map<SourceId, MetricId[]>();
  for (const m of additiveMetrics(q.metrics)) {
    const id = METRICS[m].source!.id;
    bySource.set(id, [...(bySource.get(id) ?? []), m]);
  }

  const sources: CompiledSource[] = [];
  for (const [id, metrics] of bySource) {
    const s = SOURCES[id];
    const select: string[] = [`${PERIOD[q.grain](s.day)} AS out_period`];
    const group: string[] = q.grain === 'total' ? [] : ['out_period'];
    const keys: (Dimension | 'currency')[] = [
      ...q.dimensions,
      ...(currencyKey ? (['currency'] as const) : []),
    ];
    for (const k of keys) {
      const col = s.columns[k];
      if (!col) continue; // the validator guarantees every requested dimension; currency is absent only on counts
      select.push(`toString(${col}) AS ${OUT[k]}`);
      group.push(OUT[k]);
    }
    for (const m of metrics) select.push(`${METRICS[m].source!.sql} AS m_${m}`);

    const where = [
      `${s.day} >= {from:Date}`,
      `${s.day} < {to:Date}`,
      'store_id IN {scope:Array(UUID)}',
    ];
    if (s.where) where.push(s.where);
    const params: Record<string, unknown> = { from: q.from, to: q.to, scope: [...scope] };
    const f = q.filters;
    if (f.currencies) {
      if (!s.columns.currency)
        throw validationError('filters.currencies applies to money metrics only', {
          field: 'filters.currencies',
        });
      where.push('currency IN {currencies:Array(String)}');
      params.currencies = f.currencies;
    }
    if (f.product_ids) {
      if (!s.columns.product)
        throw validationError(
          'filters.product_ids needs metrics that accept the product dimension',
          {
            field: 'filters.product_ids',
          },
        );
      where.push('product_id IN {products:Array(UUID)}');
      params.products = f.product_ids;
    }
    if (f.refund_reasons) {
      if (!s.columns.refund_reason)
        throw validationError('filters.refund_reasons applies to refunds_minor only', {
          field: 'filters.refund_reasons',
        });
      where.push('reason IN {reasons:Array(String)}');
      params.reasons = f.refund_reasons;
    }
    const sql =
      `SELECT ${select.join(', ')} FROM ${s.from} WHERE ${where.join(' AND ')}` +
      (group.length > 0 ? ` GROUP BY ${group.join(', ')}` : '');
    sources.push({ source: id, sql, params, metrics });
  }
  return { currencyKey, sources };
}
