// A validated query + the caller's scope → parameterised ClickHouse SQL, one statement per model the query reads.
//
//   * The SCOPE is always in the WHERE: `store_id IN {scope:Array(UUID)}`, from the server, never from the request.
//     A request's `filters.store_ids` only narrows it (the route has already refused an id outside the scope).
//   * Every value is a server-side parameter ({name:Type}); the only text that varies is chosen from the closed
//     catalogue below (column names, aggregates, period functions). No request string is ever concatenated.
//   * Output columns are `out_*` / `m_*`: never a column's own name (a ClickHouse alias shadows the column of the same
//     name in WHERE and GROUP BY; data/clickhouse README).
//   * The `stock` source (BI v2, #871 c) is scoped differently: pool movements (receipts, transfers, cycle counts)
//     carry no store, so a store predicate would hide them from everyone. An organization caller reads it by
//     `organization_id`; a store caller by the stock items its stores' variants map (read from Postgres under RLS),
//     plus pre-pool rows (no stock item) its own stores caused.
//   * BI v2 wave 2 (#935): the `customers_v2` source aggregates PER CUSTOMER KEY first (inner query) and counts keys
//     outside it, so a distinct count, repeat customers and per-customer sums come from one statement and the key
//     never leaves ClickHouse; the `attribution` source always carries the touch model as a parameter; `promotions`
//     is Postgres (promotions.ts), never compiled here.
import { validationError } from '../../../lib/errors';
import { METRICS, type Dimension, type Grain, type MetricId, type SourceId } from './catalogue';
import type { MetricQuery } from './query';

interface SourceSpec {
  from: string;
  /** The UTC day the source is bucketed by. */
  day: string;
  where?: string;
  columns: Partial<Record<Dimension | 'currency', string>>;
  /** `store` (the default): `store_id IN {scope}`; `stock`: the stock scope (see the header). */
  scope?: 'store' | 'stock';
  /** Aggregate per this key first (#935): the inner query's columns `k`, plus these aggregates; metrics read them. */
  perKey?: { key: string; inner: Readonly<Record<string, string>> };
}

/** Who may read the `stock` series: the organization, or the stock items the caller's stores map. */
export type StockScope = { organizationId: string } | { stockItemIds: readonly string[] };

const ORDER_DIMS = {
  country: 'country',
  sales_channel: 'sales_channel_id',
  customer_type: 'customer_type',
} as const;
const SHIP_COLUMNS = { store: 'store_id', warehouse: 'warehouse_id', carrier: 'carrier' } as const;

const SOURCES: Readonly<Record<SourceId, SourceSpec>> = {
  // mart_sales_daily = mart_bookings_daily's figures keyed also by country, channel and customer type (#871 b)
  sales: {
    from: 'mart_sales_daily',
    day: 'day',
    columns: {
      store: 'store_id',
      currency: 'currency',
      ...ORDER_DIMS,
      customer_group: 'customer_group_id',
    },
  },
  refunds: {
    from: 'fct_refund',
    day: "toDate(issued_at, 'UTC')",
    columns: {
      store: 'store_id',
      currency: 'currency',
      refund_reason: 'reason',
      country: 'country',
      sales_channel: 'sales_channel_id',
    },
  },
  lines: {
    from: 'fct_order_line',
    day: "toDate(placed_at, 'UTC')",
    where: "order_status != 'cancelled'",
    columns: {
      store: 'store_id',
      currency: 'currency',
      product: 'product_id',
      category: 'category_id',
      ...ORDER_DIMS,
      customer_group: 'customer_group_id',
    },
  },
  returns: {
    from: 'fct_return_line',
    day: "toDate(received_at, 'UTC')",
    columns: {
      store: 'store_id',
      currency: 'currency',
      product: 'product_id',
      category: 'category_id',
      ...ORDER_DIMS,
    },
  },
  stock: {
    from: 'mart_stock_daily',
    day: 'day',
    columns: { warehouse: 'warehouse_id' },
    scope: 'stock',
  },
  customers: { from: 'mart_customers_daily', day: 'day', columns: { store: 'store_id' } },
  cash: {
    from: 'mart_cash_daily',
    day: 'day',
    columns: { store: 'store_id', currency: 'currency', provider: 'provider' },
  },
  // the live tiles (D6): one row per order.placed event, read FINAL so a redelivered event counts once
  live: {
    from: 'orders_minute_events FINAL',
    day: "toDate(minute, 'UTC')",
    columns: { store: 'store_id', currency: 'currency' },
  },
  ledger: {
    from: 'fct_ledger_line',
    day: 'entry_date',
    where: 'is_revenue',
    columns: { store: 'store_id', currency: 'currency' },
  },
  // ---- BI v2 wave 2 (#935) ----
  customers_v2: {
    from: 'fct_order_sales',
    day: "toDate(placed_at, 'UTC')",
    columns: {
      store: 'store_id',
      currency: 'currency',
      country: 'country',
      sales_channel: 'sales_channel_id',
      customer_group: 'customer_group_id',
    },
    // a key is PER STORE (a customer of two brands is two customers); NULL when the customer was erased
    perKey: {
      key: "concat(toString(store_id), ':', customer_key)",
      inner: { k_orders: 'count()', k_net: 'sum(net_minor)' },
    },
  },
  attribution: {
    from: 'fct_order_touch',
    day: "toDate(placed_at, 'UTC')",
    where: 'touch = {touch:String}',
    columns: {
      store: 'store_id',
      currency: 'currency',
      utm_source: 'utm_source',
      utm_medium: 'utm_medium',
      utm_campaign: 'utm_campaign',
      campaign: 'campaign_id',
    },
  },
  campaigns: {
    from: 'dim_campaign',
    day: "toDate(starts_at, 'UTC')",
    where: 'budget_minor IS NOT NULL AND starts_at IS NOT NULL',
    columns: { store: 'store_id', currency: 'budget_currency', campaign: 'campaign_id' },
  },
  // Postgres (promotions.ts): listed so the column checks below hold; never compiled to ClickHouse
  promotions: {
    from: '',
    day: '',
    columns: { store: 'store_id', currency: 'currency', promotion: 'promotion_id' },
  },
  carts: {
    from: 'stg_cart_abandoned_v1',
    day: "toDate(abandoned_at, 'UTC')",
    columns: { store: 'store_id', currency: 'currency' },
  },
  ship: {
    from: 'fct_order_fulfilment',
    day: "toDate(first_shipped_at, 'UTC')",
    where: 'first_shipped_at IS NOT NULL',
    columns: SHIP_COLUMNS,
  },
  deliver: {
    from: 'fct_order_fulfilment',
    day: "toDate(delivered_at, 'UTC')",
    where: 'delivered_at IS NOT NULL',
    columns: SHIP_COLUMNS,
  },
  shipments: {
    from: 'fct_shipment',
    day: "toDate(shipped_at, 'UTC')",
    where: 'shipped_at IS NOT NULL',
    columns: { ...SHIP_COLUMNS, currency: 'currency' },
  },
  return_requests: {
    from: 'stg_return_requested_v1',
    day: "toDate(requested_at, 'UTC')",
    columns: { store: 'store_id' },
  },
  payments: {
    from: 'fct_payment_event',
    day: "toDate(at, 'UTC')",
    columns: { store: 'store_id', provider: 'provider', failure_reason: 'failure_code' },
  },
  refund_failures: {
    from: 'stg_refund_failed_v1',
    day: "toDate(failed_at, 'UTC')",
    columns: { store: 'store_id' },
  },
};

/** Sources answered by Postgres, not ClickHouse (#935): the executor asks its loader for them. */
export const POSTGRES_SOURCES: ReadonlySet<SourceId> = new Set<SourceId>(['promotions']);

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
  country: 'out_country',
  sales_channel: 'out_channel',
  category: 'out_category',
  customer_type: 'out_ctype',
  warehouse: 'out_warehouse',
  customer_group: 'out_cgroup',
  utm_source: 'out_utm_source',
  utm_medium: 'out_utm_medium',
  utm_campaign: 'out_utm_campaign',
  campaign: 'out_campaign',
  promotion: 'out_promotion',
  carrier: 'out_carrier',
  failure_reason: 'out_failure',
};

/** A filter → the dimension whose column it narrows, its parameter name and type. */
const FILTERS = [
  ['countries', 'country', 'countries', 'Array(String)'],
  ['sales_channel_ids', 'sales_channel', 'channels', 'Array(UUID)'],
  ['category_ids', 'category', 'categories', 'Array(UUID)'],
  ['customer_types', 'customer_type', 'ctypes', 'Array(String)'],
  ['warehouse_ids', 'warehouse', 'warehouses', 'Array(UUID)'],
  // BI v2 wave 2 (#935)
  ['customer_group_ids', 'customer_group', 'cgroups', 'Array(UUID)'],
  ['campaign_ids', 'campaign', 'campaigns', 'Array(UUID)'],
  ['promotion_ids', 'promotion', 'promotions', 'Array(UUID)'],
  ['utm_sources', 'utm_source', 'utm_sources', 'Array(String)'],
  ['utm_mediums', 'utm_medium', 'utm_mediums', 'Array(String)'],
  ['utm_campaigns', 'utm_campaign', 'utm_campaigns', 'Array(String)'],
  ['carriers', 'carrier', 'carriers', 'Array(String)'],
  ['providers', 'provider', 'providers', 'Array(String)'],
] as const;

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
    // #935 c: a per-customer value is only shown with its customer count, so the count is always fetched
    if (def.per_customer) out.add('customers');
  }
  return [...out];
}

export function compileMetricQuery(
  q: MetricQuery,
  scope: readonly string[],
  /** `currencyKey` (#935): the totals query of a money answer keys its counts by currency like the answer does. */
  opts: { stock?: StockScope; currencyKey?: boolean } = {},
): Compiled {
  if (scope.length === 0)
    throw new Error('compileMetricQuery: an empty scope never reaches the compiler');
  const currencyKey = opts.currencyKey ?? q.metrics.some((m) => METRICS[m].currency_bound);
  const bySource = new Map<SourceId, MetricId[]>();
  for (const m of additiveMetrics(q.metrics)) {
    const id = METRICS[m].source!.id;
    bySource.set(id, [...(bySource.get(id) ?? []), m]);
  }

  const sources: CompiledSource[] = [];
  for (const [id, metrics] of bySource) {
    const s = SOURCES[id];
    if (POSTGRES_SOURCES.has(id)) {
      // the filters' column checks still apply (a filter the source cannot narrow is a 400, as for any source)
      checkFilters(q, s);
      continue;
    }
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

    const where = [`${s.day} >= {from:Date}`, `${s.day} < {to:Date}`];
    const params: Record<string, unknown> = { from: q.from, to: q.to, scope: [...scope] };
    if ((s.scope ?? 'store') === 'store') where.push('store_id IN {scope:Array(UUID)}');
    else {
      const st = opts.stock;
      if (!st) throw new Error('compileMetricQuery: the stock source needs a stock scope');
      if ('organizationId' in st) {
        where.push('organization_id = {org:UUID}');
        params.org = st.organizationId;
      } else {
        // the mapped stock items, and pre-pool movements (no stock item) the caller's own stores caused
        where.push(
          '(stock_item_id IN {items:Array(UUID)} OR (stock_item_id IS NULL AND store_id IN {scope:Array(UUID)}))',
        );
        params.items = [...st.stockItemIds];
      }
    }
    if (s.where) where.push(s.where);
    const f = q.filters;
    for (const [filter, dim, param, type] of FILTERS) {
      const values = f[filter];
      if (!values) continue;
      const col = s.columns[dim];
      if (!col)
        throw validationError(`filters.${filter} needs metrics that accept the ${dim} dimension`, {
          field: `filters.${filter}`,
        });
      where.push(`${col} IN {${param}:${type}}`);
      params[param] = values;
    }
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
    if (s.where?.includes('{touch:String}')) params.touch = q.filters.touch ?? 'last';
    let sql: string;
    if (s.perKey) {
      // inner: one row per (period, keys…, customer key) with the per-key aggregates; outer: the metrics over keys
      const inner = select
        .filter((x) => !x.includes(' AS m_'))
        .concat(
          `${s.perKey.key} AS k`,
          Object.entries(s.perKey.inner).map(([alias, agg]) => `${agg} AS ${alias}`),
        );
      const outerKeys = group;
      const outer = [
        // with grain total the period is a constant the outer query does not group by
        q.grain === 'total' ? 'any(out_period) AS out_p' : 'out_period',
        ...select
          .filter((x) => / AS out_/.test(x) && !x.endsWith('AS out_period'))
          .map((x) => x.split(' AS ')[1]!),
        ...metrics.map((m) => `${METRICS[m].source!.sql} AS m_${m}`),
      ];
      sql =
        `SELECT ${outer.join(', ')} FROM (SELECT ${inner.join(', ')} FROM ${s.from} WHERE ${where.join(' AND ')}` +
        ` GROUP BY ${[...group, 'k'].join(', ')})` +
        (outerKeys.length > 0 ? ` GROUP BY ${outerKeys.join(', ')}` : '');
    } else
      sql =
        `SELECT ${select.join(', ')} FROM ${s.from} WHERE ${where.join(' AND ')}` +
        (group.length > 0 ? ` GROUP BY ${group.join(', ')}` : '');
    sources.push({ source: id, sql, params, metrics });
  }
  return { currencyKey, sources };
}

/** Every filter the query carries must narrow a column of the source (else a 400 naming the filter). */
function checkFilters(q: MetricQuery, s: SourceSpec): void {
  const f = q.filters;
  for (const [filter, dim] of FILTERS)
    if (f[filter] && !s.columns[dim])
      throw validationError(`filters.${filter} needs metrics that accept the ${dim} dimension`, {
        field: `filters.${filter}`,
      });
  if (f.currencies && !s.columns.currency)
    throw validationError('filters.currencies applies to money metrics only', {
      field: 'filters.currencies',
    });
  for (const [filter, dim] of [
    ['product_ids', 'product'],
    ['refund_reasons', 'refund_reason'],
  ] as const)
    if (f[filter] && !s.columns[dim])
      throw validationError(`filters.${filter} needs metrics that accept the ${dim} dimension`, {
        field: `filters.${filter}`,
      });
}
