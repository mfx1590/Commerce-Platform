// The metrics catalogue (#603, D4): the closed vocabulary of `queryMetrics`. Every metric names the ClickHouse model it
// reads (#601/#602/#623, data/clickhouse), the dimensions it accepts and its unit. Nothing outside this file can
// become SQL: the compiler maps ids from here to fixed SQL fragments, and every value a request carries travels as a
// server-side parameter.

export const METRIC_IDS = [
  'orders',
  'bookings_minor',
  'net_bookings_minor',
  'aov_minor',
  'refunds_minor',
  'refund_rate_bp',
  'units',
  'product_net_minor',
  'new_customers',
  'returning_customers',
  'captured_minor',
  'fee_minor',
  'recognised_minor',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const DIMENSIONS = ['store', 'product', 'refund_reason', 'provider'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const GRAINS = ['day', 'week', 'month', 'total'] as const;
export type Grain = (typeof GRAINS)[number];

export const REFUND_REASONS = ['return', 'cancellation', 'goodwill', 'chargeback'] as const;

export const LIMITS = {
  max_range_days: 366,
  max_metrics: 5,
  max_dimensions: 2,
  max_rows: 1000,
  max_store_ids: 50,
  max_currencies: 10,
  max_product_ids: 100,
} as const;

/** The models a metric reads (one compiled query per source per request). */
export type SourceId = 'bookings' | 'refunds' | 'lines' | 'customers' | 'cash' | 'ledger';

export interface MetricDefinition {
  id: MetricId;
  label: string;
  description: string;
  unit: 'minor' | 'count' | 'bp';
  /** Money: rows always carry `currency` and nothing is summed across currencies. */
  currency_bound: boolean;
  /** `finance` on `organization:hq` required (as getHqFinanceReport). */
  finance: boolean;
  available: boolean;
  dimensions: readonly Dimension[];
  /** An additive metric: its source, and the aggregate over that source's model. */
  source?: { id: SourceId; sql: string };
  /** A ratio computed from other metrics per row and per currency total (never summed). */
  derived?: { inputs: readonly MetricId[] };
}

export const METRICS: Readonly<Record<MetricId, MetricDefinition>> = {
  orders: {
    id: 'orders',
    label: 'Orders',
    description:
      'Orders by placement day; cancelled and failed-payment orders excluded (the rules of rpt_sales_daily).',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store'],
    source: { id: 'bookings', sql: 'sum(orders)' },
  },
  bookings_minor: {
    id: 'bookings_minor',
    label: 'Bookings',
    description: 'Order totals by placement day; cancelled and failed-payment orders excluded.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store'],
    source: { id: 'bookings', sql: 'sum(total_minor)' },
  },
  net_bookings_minor: {
    id: 'net_bookings_minor',
    label: 'Net bookings',
    description:
      'Bookings minus the succeeded refunds of the orders placed that day (cohort-attributed).',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store'],
    source: { id: 'bookings', sql: 'sum(net_minor)' },
  },
  aov_minor: {
    id: 'aov_minor',
    label: 'Average order value',
    description:
      'Bookings divided by orders per currency, integer half-up; null when there are no orders.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store'],
    derived: { inputs: ['bookings_minor', 'orders'] },
  },
  refunds_minor: {
    id: 'refunds_minor',
    label: 'Refunds',
    description: 'Succeeded refunds by the day they were issued.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'refund_reason'],
    source: { id: 'refunds', sql: 'sum(amount_minor)' },
  },
  refund_rate_bp: {
    id: 'refund_rate_bp',
    label: 'Refund rate',
    description:
      'Refunds × 10 000 / bookings over the same rows, in basis points; null when bookings are 0.',
    unit: 'bp',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store'],
    derived: { inputs: ['refunds_minor', 'bookings_minor'] },
  },
  units: {
    id: 'units',
    label: 'Units sold',
    description: 'Line quantities of orders that are not cancelled.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'product'],
    source: { id: 'lines', sql: 'sum(quantity)' },
  },
  product_net_minor: {
    id: 'product_net_minor',
    label: 'Product sales',
    description: 'Line totals of orders that are not cancelled.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'product'],
    source: { id: 'lines', sql: 'sum(total_minor)' },
  },
  new_customers: {
    id: 'new_customers',
    label: 'New customers',
    description:
      'Customers whose first order in the store was that day; an erased customer counts as unknown.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store'],
    source: { id: 'customers', sql: 'sum(new_customers)' },
  },
  returning_customers: {
    id: 'returning_customers',
    label: 'Returning customers',
    description: 'Customers who ordered again that day after an earlier first order in the store.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store'],
    source: { id: 'customers', sql: 'sum(returning_customers)' },
  },
  captured_minor: {
    id: 'captured_minor',
    label: 'Captured',
    description: 'Payments captured, by capture day and provider.',
    unit: 'minor',
    currency_bound: true,
    finance: true,
    available: true,
    dimensions: ['store', 'provider'],
    source: { id: 'cash', sql: 'sum(captured_minor)' },
  },
  fee_minor: {
    id: 'fee_minor',
    label: 'PSP fees',
    description: 'The PSP fees known so far (unknown fees are not estimated).',
    unit: 'minor',
    currency_bound: true,
    finance: true,
    available: true,
    dimensions: ['store', 'provider'],
    source: { id: 'cash', sql: 'sum(fee_minor)' },
  },
  recognised_minor: {
    id: 'recognised_minor',
    label: 'Recognised revenue',
    description:
      "The ledger's posted revenue (4000 + 4010 + 4090) by entry date, as last pulled by reconcile (#602).",
    unit: 'minor',
    currency_bound: true,
    finance: true,
    available: true,
    dimensions: ['store'],
    source: { id: 'ledger', sql: 'sum(revenue_minor)' },
  },
};

/** What `listMetrics` answers for a caller (finance metrics only for finance principals). */
export function catalogueFor(opts: { finance: boolean; stores: { id: string; code: string }[] }) {
  return {
    version: 1,
    max_range_days: LIMITS.max_range_days,
    max_metrics: LIMITS.max_metrics,
    max_dimensions: LIMITS.max_dimensions,
    max_rows: LIMITS.max_rows,
    grains: [...GRAINS],
    stores: opts.stores,
    metrics: METRIC_IDS.map((id) => METRICS[id])
      .filter((m) => opts.finance || !m.finance)
      .map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        unit: m.unit,
        currency_bound: m.currency_bound,
        finance: m.finance,
        available: m.available,
        dimensions: [...m.dimensions],
      })),
  };
}
