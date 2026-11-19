/**
 * The query bodies of the three BI v2 views (#871), built from the URL state and the catalogue.
 * Pure. Every body carries the same window, comparison and filters, so the CSV of a block is the
 * same question as the block.
 */

import {
  chunk,
  filtersOf,
  offered,
  type BiState,
  type MetricCatalogue,
  type MetricId,
  type MetricQuery,
  type MoversQuery,
} from './model';

/** The Overview headline, in the order the cards show them (net sales first). */
export const OVERVIEW_METRICS: readonly MetricId[] = [
  'net_sales_minor',
  'gross_sales_minor',
  'discounts_minor',
  'shipping_minor',
  'tax_minor',
  'refunds_minor',
  'net_bookings_minor',
  'orders',
  'units',
  'aov_minor',
  'items_per_order_bp',
];

/** The breakdown table's columns. */
export const BREAKDOWN_METRICS: readonly MetricId[] = [
  'net_sales_minor',
  'orders',
  'units',
  'aov_minor',
];

/** Products & categories: what a product is ranked and shown by. */
export const PRODUCT_METRICS: readonly MetricId[] = [
  'product_net_ex_tax_minor',
  'units',
  'product_returned_units',
  'product_return_rate_bp',
];
export const PRODUCT_RANKS = [
  'product_net_ex_tax_minor',
  'units',
  'product_return_rate_bp',
] as const;
export type ProductRank = (typeof PRODUCT_RANKS)[number];
export const PRODUCT_LIMIT = 20;

const compareOf = (state: BiState): Pick<MetricQuery, 'compare'> =>
  state.compare === 'none' ? {} : { compare: state.compare };

function base(state: BiState, storeId?: string): Pick<MetricQuery, 'from' | 'to' | 'filters'> {
  const filters = filtersOf(state, storeId);
  return {
    from: state.window.from,
    to: state.window.to,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  };
}

/** The headline as total-grain queries of at most the catalogue's `max_metrics` each. */
export function overviewQueries(
  catalogue: MetricCatalogue,
  state: BiState,
  storeId?: string,
): { queries: MetricQuery[]; missing: MetricId[] } {
  const { metrics, missing } = offered(catalogue, OVERVIEW_METRICS);
  return {
    queries: chunk(metrics, catalogue.max_metrics).map((group) => ({
      metrics: group,
      dimensions: [],
      grain: 'total' as const,
      limit: Math.min(100, catalogue.max_rows),
      ...base(state, storeId),
      ...compareOf(state),
    })),
    missing,
  };
}

/** The breakdown by the chosen dimension (the store view never breaks down by store). */
export function breakdownQuery(
  catalogue: MetricCatalogue,
  state: BiState,
  storeId?: string,
): { query: MetricQuery | null; missing: MetricId[] } {
  const { metrics, missing } = offered(catalogue, BREAKDOWN_METRICS, state.by);
  if (metrics.length === 0) return { query: null, missing };
  return {
    query: {
      metrics: metrics.slice(0, catalogue.max_metrics),
      dimensions: [state.by],
      grain: 'total' as const,
      ...base(state, storeId),
      ...compareOf(state),
      order_by: { metric: metrics[0]!, direction: 'desc' },
      limit: Math.min(100, catalogue.max_rows),
    },
    missing,
  };
}

/** "What changed": net sales by the chosen breakdown, ranked by absolute change per currency. */
export function moversQuery(state: BiState, storeId?: string): MoversQuery | null {
  if (state.compare === 'none') return null;
  const filters = filtersOf(state, storeId);
  return {
    metric: 'net_sales_minor',
    dimension: state.by,
    from: state.window.from,
    to: state.window.to,
    compare: state.compare,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    limit: 5,
  };
}

/** Best (desc) or worst (asc) products by `rank`, with names from the answer's labels. */
export function productsQuery(
  catalogue: MetricCatalogue,
  state: BiState,
  rank: ProductRank,
  direction: 'asc' | 'desc',
  storeId?: string,
): { query: MetricQuery | null; missing: MetricId[] } {
  const { metrics, missing } = offered(catalogue, PRODUCT_METRICS, 'product');
  if (!metrics.includes(rank)) return { query: null, missing: [...missing] };
  return {
    query: {
      metrics: metrics.slice(0, catalogue.max_metrics),
      dimensions: ['product'],
      grain: 'total' as const,
      ...base(state, storeId),
      ...compareOf(state),
      order_by: { metric: rank, direction },
      limit: PRODUCT_LIMIT,
    },
    missing,
  };
}

/** The category roll-up of the same product metrics. */
export function categoriesQuery(
  catalogue: MetricCatalogue,
  state: BiState,
  storeId?: string,
): { query: MetricQuery | null; missing: MetricId[] } {
  const { metrics, missing } = offered(catalogue, PRODUCT_METRICS, 'category');
  if (metrics.length === 0) return { query: null, missing };
  return {
    query: {
      metrics: metrics.slice(0, catalogue.max_metrics),
      dimensions: ['category'],
      grain: 'total' as const,
      ...base(state, storeId),
      ...compareOf(state),
      order_by: { metric: metrics[0]!, direction: 'desc' },
      limit: Math.min(100, catalogue.max_rows),
    },
    missing,
  };
}
