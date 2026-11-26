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
  'live_orders',
  'live_placed_minor',
  // BI v2 (#871, catalogue version 2)
  'net_sales_minor',
  'gross_sales_minor',
  'discounts_minor',
  'shipping_minor',
  'tax_minor',
  'items_per_order_bp',
  'placed_orders',
  'cancelled_orders',
  'cancellation_rate_bp',
  'returned_units',
  'return_rate_bp',
  'product_net_ex_tax_minor',
  'product_gross_minor',
  'product_discount_minor',
  'product_orders',
  'product_returned_units',
  'product_return_rate_bp',
  'stock_on_hand',
  'stock_reserved',
  'stock_available',
  'stock_incoming',
  'units_sold_per_day_milli',
  'days_of_cover',
  'suggested_reorder_units',
  'stockout_events',
  'units_received',
  'units_adjusted',
  // BI v2 wave 2 (#935, catalogue version 3): customers
  'customers',
  'repeat_customers',
  'customer_orders',
  'customer_net_sales_minor',
  'repeat_rate_bp',
  'orders_per_customer_bp',
  'revenue_per_customer_minor',
  'unknown_customer_orders',
  // marketing and promotions
  'attributed_orders',
  'attributed_net_sales_minor',
  'unattributed_orders',
  'campaign_net_sales_minor',
  'campaign_budget_minor',
  'promotion_orders',
  'promotion_discount_minor',
  'abandoned_carts',
  'abandoned_value_minor',
  // operations
  'orders_shipped',
  'hours_to_ship_p50',
  'hours_to_ship_p90',
  'orders_delivered',
  'hours_to_deliver_p50',
  'hours_to_deliver_p90',
  'shipping_cost_minor',
  'shipping_cost_unknown',
  'return_requests',
  'payments_authorized',
  'payments_captured',
  'payments_failed',
  'payments_with_outcome',
  'payment_failure_rate_bp',
  'refunds_failed',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const DIMENSIONS = [
  'store',
  'product',
  'refund_reason',
  'provider',
  // BI v2 (#871)
  'country',
  'sales_channel',
  'category',
  'customer_type',
  'warehouse',
  // BI v2 wave 2 (#935)
  'customer_group',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'campaign',
  'promotion',
  'carrier',
  'failure_reason',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const GRAINS = ['day', 'week', 'month', 'total'] as const;
export type Grain = (typeof GRAINS)[number];

export const REFUND_REASONS = ['return', 'cancellation', 'goodwill', 'chargeback'] as const;
export const CUSTOMER_TYPES = ['new', 'returning', 'unknown'] as const;
/** The attribution touch models (#935): which touch of an order an attribution metric reads. */
export const TOUCHES = ['first', 'last'] as const;
/** Below this many customers a per-customer value is suppressed (#935 c, decision 2). */
export const MIN_CUSTOMERS = 5;

/** The platform defaults of the inventory parameters (#871 a4): a store's settings override them, a request both. */
export const INVENTORY_DEFAULTS = {
  velocity_days: 28,
  lead_time_days: 14,
  cover_days: 28,
  dead_days: 60,
} as const;

export const LIMITS = {
  max_range_days: 366,
  max_metrics: 5,
  max_dimensions: 2,
  max_rows: 1000,
  max_store_ids: 50,
  max_currencies: 10,
  max_product_ids: 100,
  // BI v2 (#871)
  max_countries: 50,
  max_sales_channel_ids: 50,
  max_category_ids: 100,
  max_warehouse_ids: 50,
  max_movers: 20,
  max_inventory_rows: 500,
  // BI v2 wave 2 (#935)
  max_csv_rows: 10_000,
  max_customer_group_ids: 50,
  max_campaign_ids: 50,
  max_promotion_ids: 50,
  max_utm_values: 50,
  max_carriers: 20,
  max_providers: 10,
  /** utm values shown per dimension and answer; the rest are `other` (decision 5). */
  utm_top: 50,
  max_cohorts: 24,
  max_cohort_months: 24,
  max_dimension_values: 50,
} as const;

/** The models a metric reads (one compiled query per source per request). */
export type SourceId =
  | 'sales'
  | 'refunds'
  | 'lines'
  | 'returns'
  | 'stock'
  | 'customers'
  | 'cash'
  | 'ledger'
  | 'live'
  // BI v2 wave 2 (#935)
  | 'customers_v2'
  | 'attribution'
  | 'campaigns'
  | 'promotions'
  | 'carts'
  | 'ship'
  | 'deliver'
  | 'shipments'
  | 'return_requests'
  | 'payments'
  | 'refund_failures';

export interface MetricDefinition {
  id: MetricId;
  label: string;
  description: string;
  unit: 'minor' | 'count' | 'bp' | 'milli' | 'hours';
  /**
   * `snapshot` metrics describe now (inventory, #871): getInventoryHealth serves them, queryMetrics refuses them.
   * `distribution` (#935): a quantile over the rows' group, hours with one decimal, no currency; its total is its own
   * query over every row in scope, never a sum or an average of rows; movers refuse it.
   */
  kind?: 'series' | 'snapshot' | 'distribution';
  /** The calculation in plain words, shown with the definition. */
  formula?: string;
  /**
   * How a per-currency total is formed: `sum` of the rows (default); `none` (a distinct count: not summable); or
   * `query` (#935): its own query over every row in scope (distinct customers and payments, quantiles).
   */
  total?: 'sum' | 'none' | 'query';
  /** A per-customer value (#935 c): null and `suppressed` when the row counts fewer than MIN_CUSTOMERS customers. */
  per_customer?: boolean;
  /** Money: rows always carry `currency` and nothing is summed across currencies. */
  currency_bound: boolean;
  /** `finance` on `organization:hq` required (as getHqFinanceReport). */
  finance: boolean;
  available: boolean;
  dimensions: readonly Dimension[];
  /** An additive metric: its source, and the aggregate over that source's model. */
  source?: { id: SourceId; sql: string };
  /** Grains the metric accepts; every grain when omitted. */
  grains?: readonly Grain[];
  /** A ratio computed from other metrics per row and per currency total (never summed). */
  derived?: { inputs: readonly MetricId[] };
}

function snapshot(
  id: MetricId,
  label: string,
  description: string,
  formula?: string,
  unit: MetricDefinition['unit'] = 'count',
): MetricDefinition {
  return {
    id,
    label,
    description,
    ...(formula ? { formula } : {}),
    unit,
    kind: 'snapshot',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'warehouse', 'category', 'product'],
  };
}

/** Additive series metrics (a sum of minor units or counts): the only ones listMetricMovers ranks (#871 a3). */
export function isAdditive(m: MetricDefinition): boolean {
  return (
    (m.kind ?? 'series') === 'series' &&
    !m.derived &&
    (m.unit === 'minor' || m.unit === 'count') &&
    m.total !== 'none' &&
    m.total !== 'query' &&
    m.source !== undefined &&
    m.source.id !== 'live'
  );
}

export const DIMENSION_INFO: Readonly<
  Record<
    Dimension,
    { label: string; description: string; filter: string | null; max: number | null }
  >
> = {
  store: {
    label: 'Brand',
    description: 'The store (brand) the order belongs to.',
    filter: 'store_ids',
    max: LIMITS.max_store_ids,
  },
  product: {
    label: 'Product',
    description: 'The product of the order line.',
    filter: 'product_ids',
    max: LIMITS.max_product_ids,
  },
  refund_reason: {
    label: 'Refund reason',
    description: 'Why the refund was issued.',
    filter: 'refund_reasons',
    max: REFUND_REASONS.length,
  },
  provider: {
    label: 'Payment provider',
    description: 'The PSP that captured the payment.',
    filter: null,
    max: null,
  },
  country: {
    label: 'Country',
    description: 'The shipping country of the order (ISO code).',
    filter: 'countries',
    max: LIMITS.max_countries,
  },
  sales_channel: {
    label: 'Sales channel',
    description: 'The sales channel the order came through.',
    filter: 'sales_channel_ids',
    max: LIMITS.max_sales_channel_ids,
  },
  category: {
    label: 'Category',
    description:
      'The product’s category as of its last publish (a later move shows after the next publish).',
    filter: 'category_ids',
    max: LIMITS.max_category_ids,
  },
  customer_type: {
    label: 'Customer type',
    description: 'New (first order in the store), returning, or unknown (an erased customer).',
    filter: 'customer_types',
    max: CUSTOMER_TYPES.length,
  },
  warehouse: {
    label: 'Warehouse',
    description:
      'The warehouse of the stock movement, or of the shipment (the first one that left an order).',
    filter: 'warehouse_ids',
    max: LIMITS.max_warehouse_ids,
  },
  customer_group: {
    label: 'Customer group',
    description:
      'The customer’s CURRENT group (there is no group history: a customer moved to another group shows there for past orders too). Empty for no group and for an erased customer.',
    filter: 'customer_group_ids',
    max: LIMITS.max_customer_group_ids,
  },
  utm_source: {
    label: 'Source (utm_source)',
    description:
      'The link’s utm_source, lower-cased and trimmed. The 50 largest values by orders are shown; the rest, and anything that looks like personal data, are `other`.',
    filter: 'utm_sources',
    max: LIMITS.max_utm_values,
  },
  utm_medium: {
    label: 'Medium (utm_medium)',
    description: 'The link’s utm_medium, normalised like the source.',
    filter: 'utm_mediums',
    max: LIMITS.max_utm_values,
  },
  utm_campaign: {
    label: 'Campaign tag (utm_campaign)',
    description: 'The link’s utm_campaign, normalised like the source.',
    filter: 'utm_campaigns',
    max: LIMITS.max_utm_values,
  },
  campaign: {
    label: 'Campaign',
    description: 'The marketing campaign the touch or the budget belongs to.',
    filter: 'campaign_ids',
    max: LIMITS.max_campaign_ids,
  },
  promotion: {
    label: 'Promotion',
    description:
      'The promotion applied to the order (automatic or by code), labelled by its name, never a code.',
    filter: 'promotion_ids',
    max: LIMITS.max_promotion_ids,
  },
  carrier: {
    label: 'Carrier',
    description: 'The carrier of the shipment (the first one that left an order), lower-cased.',
    filter: 'carriers',
    max: LIMITS.max_carriers,
  },
  failure_reason: {
    label: 'Failure code',
    description:
      'The PSP’s failure code of a failed payment; free text and anything that is not a code is `other`.',
    filter: null,
    max: null,
  },
};

// ---- BI v2 wave 2 (#935 a1, catalogue version 3) ---------------------------------------------------------------------

type Wave2Id = (typeof METRIC_IDS)[number] &
  (
    | 'customers'
    | 'repeat_customers'
    | 'customer_orders'
    | 'customer_net_sales_minor'
    | 'repeat_rate_bp'
    | 'orders_per_customer_bp'
    | 'revenue_per_customer_minor'
    | 'unknown_customer_orders'
    | 'attributed_orders'
    | 'attributed_net_sales_minor'
    | 'unattributed_orders'
    | 'campaign_net_sales_minor'
    | 'campaign_budget_minor'
    | 'promotion_orders'
    | 'promotion_discount_minor'
    | 'abandoned_carts'
    | 'abandoned_value_minor'
    | 'orders_shipped'
    | 'hours_to_ship_p50'
    | 'hours_to_ship_p90'
    | 'orders_delivered'
    | 'hours_to_deliver_p50'
    | 'hours_to_deliver_p90'
    | 'shipping_cost_minor'
    | 'shipping_cost_unknown'
    | 'return_requests'
    | 'payments_authorized'
    | 'payments_captured'
    | 'payments_failed'
    | 'payments_with_outcome'
    | 'payment_failure_rate_bp'
    | 'refunds_failed'
  );

const CURRENT_GROUP =
  ' A customer group is the customer’s CURRENT group (no history); an erased customer has none.';
const CUSTOMER_DIMS = ['store', 'country', 'sales_channel', 'customer_group'] as const;
const SMALL = ` Shown only for at least ${MIN_CUSTOMERS} customers. A row of fewer is hidden whole, together with the smallest other rows until the hidden ones cover ${MIN_CUSTOMERS} customers, so no total or difference in the answer gives it back; when even that is impossible the totals are hidden too.`;
const ATTRIBUTION_DIMS = ['store', 'utm_source', 'utm_medium', 'utm_campaign', 'campaign'] as const;
const SHIP_DIMS = ['store', 'warehouse', 'carrier'] as const;
const PAYMENT_DIMS = ['store', 'provider'] as const;

function w2(
  id: Wave2Id,
  label: string,
  description: string,
  unit: MetricDefinition['unit'],
  dimensions: readonly Dimension[],
  rest: Partial<MetricDefinition>,
): MetricDefinition {
  return {
    id,
    label,
    description,
    unit,
    currency_bound: unit === 'minor',
    finance: false,
    available: true,
    dimensions,
    ...rest,
  };
}

const WAVE2: Readonly<Record<Wave2Id, MetricDefinition>> = {
  // customers (source customers_v2 = fct_order_sales, one customer = one pseudonymous key per store, never across
  // brands; the key never leaves ClickHouse: the source aggregates per key first, then counts keys)
  customers: w2(
    'customers',
    'Customers',
    'Distinct customers with an order in the period, per store (a customer of two brands is two customers). Erased customers are not counted.' +
      CURRENT_GROUP,
    'count',
    CUSTOMER_DIMS,
    { source: { id: 'customers_v2', sql: 'countIf(k IS NOT NULL)' }, total: 'query' },
  ),
  repeat_customers: w2(
    'repeat_customers',
    'Repeat customers',
    'Customers with 2 or more orders in the period (in the same row).' + CURRENT_GROUP,
    'count',
    CUSTOMER_DIMS,
    {
      source: { id: 'customers_v2', sql: 'countIf(k IS NOT NULL AND k_orders >= 2)' },
      total: 'query',
    },
  ),
  customer_orders: w2(
    'customer_orders',
    'Orders of known customers',
    'Orders counted in sales (not cancelled, payment not only failed) whose customer is known (not erased).',
    'count',
    CUSTOMER_DIMS,
    { source: { id: 'customers_v2', sql: 'sumIf(k_orders, k IS NOT NULL)' } },
  ),
  customer_net_sales_minor: w2(
    'customer_net_sales_minor',
    'Net sales of known customers',
    'Net sales (order totals − refunds) of the orders of known customers, per currency.' + SMALL,
    'minor',
    CUSTOMER_DIMS,
    { source: { id: 'customers_v2', sql: 'sumIf(k_net, k IS NOT NULL)' }, per_customer: true },
  ),
  repeat_rate_bp: w2(
    'repeat_rate_bp',
    'Repeat purchase rate',
    'Repeat customers ÷ customers, in basis points.' + SMALL,
    'bp',
    CUSTOMER_DIMS,
    {
      derived: { inputs: ['repeat_customers', 'customers'] },
      formula: 'repeat customers ÷ customers',
      per_customer: true,
    },
  ),
  orders_per_customer_bp: w2(
    'orders_per_customer_bp',
    'Orders per customer',
    'Orders of known customers ÷ customers, × 10 000.' + SMALL,
    'bp',
    CUSTOMER_DIMS,
    {
      derived: { inputs: ['customer_orders', 'customers'] },
      formula: 'orders of known customers ÷ customers',
      per_customer: true,
    },
  ),
  revenue_per_customer_minor: w2(
    'revenue_per_customer_minor',
    'Revenue per customer',
    'Net sales of known customers ÷ customers, per currency (integer half-up).' + SMALL,
    'minor',
    CUSTOMER_DIMS,
    {
      derived: { inputs: ['customer_net_sales_minor', 'customers'] },
      formula: 'net sales of known customers ÷ customers',
      per_customer: true,
    },
  ),
  unknown_customer_orders: w2(
    'unknown_customer_orders',
    'Orders without a customer',
    'Orders counted in sales whose customer was erased (no key).',
    'count',
    ['store', 'country', 'sales_channel'],
    { source: { id: 'customers_v2', sql: 'sumIf(k_orders, k IS NULL)' } },
  ),
  // marketing (source attribution = fct_order_touch: every counted order once per touch model; `touch` picks one)
  attributed_orders: w2(
    'attributed_orders',
    'Attributed orders',
    'Orders counted in sales with a touch of the chosen model (filters.touch: first or last; last when omitted).',
    'count',
    ATTRIBUTION_DIMS,
    { source: { id: 'attribution', sql: 'countIf(attributed = 1)' } },
  ),
  attributed_net_sales_minor: w2(
    'attributed_net_sales_minor',
    'Attributed net sales',
    'Net sales (order totals − refunds) of the attributed orders, per currency.',
    'minor',
    ATTRIBUTION_DIMS,
    { source: { id: 'attribution', sql: 'sumIf(net_minor, attributed = 1)' } },
  ),
  unattributed_orders: w2(
    'unattributed_orders',
    'Orders without a source',
    'Orders counted in sales with no touch of the chosen model.',
    'count',
    ['store'],
    { source: { id: 'attribution', sql: 'countIf(attributed = 0)' } },
  ),
  campaign_net_sales_minor: w2(
    'campaign_net_sales_minor',
    'Campaign net sales',
    'Net sales of orders attributed to a campaign (the chosen touch) and placed between the campaign’s start and end.',
    'minor',
    ['store', 'campaign'],
    { source: { id: 'attribution', sql: 'sumIf(net_minor, in_campaign = 1)' } },
  ),
  campaign_budget_minor: w2(
    'campaign_budget_minor',
    'Campaign budget (planned)',
    'The PLANNED budget of each campaign, counted once and in full in the period that contains its start (never spread over days); spend is not recorded (#873). A campaign without a budget has none.',
    'minor',
    ['store', 'campaign'],
    { source: { id: 'campaigns', sql: 'sum(budget_minor)' } },
  ),
  // promotions (source promotions = Postgres order.metadata.promotions: the frozen per-promotion allocation, automatic
  // and code promotions alike; stacked promotions each counted with their own share)
  promotion_orders: w2(
    'promotion_orders',
    'Orders with the promotion',
    'Orders (not cancelled) whose applied promotions include it; an order with two stacked promotions counts in both.',
    'count',
    ['store', 'promotion'],
    { source: { id: 'promotions', sql: 'promotion_orders' } },
  ),
  promotion_discount_minor: w2(
    'promotion_discount_minor',
    'Discount given',
    'The promotion’s own share of the line discounts of those orders, per currency. Free shipping is not included.',
    'minor',
    ['store', 'promotion'],
    { source: { id: 'promotions', sql: 'promotion_discount_minor' } },
  ),
  abandoned_carts: w2(
    'abandoned_carts',
    'Abandoned carts (all currencies)',
    'Carts marked abandoned, by the UTC day of abandonment, in every currency. Recovery is a separate figure over the store’s default-currency carts only (getAbandonedCartReport); never divide one by the other.',
    'count',
    ['store'],
    { source: { id: 'carts', sql: 'count()' } },
  ),
  abandoned_value_minor: w2(
    'abandoned_value_minor',
    'Abandoned value',
    'The totals of the abandoned carts, per currency.',
    'minor',
    ['store'],
    { source: { id: 'carts', sql: 'sum(total_minor)' } },
  ),
  // operations
  orders_shipped: w2(
    'orders_shipped',
    'Orders shipped',
    'Orders (not cancelled) whose first shipment left in the period; warehouse and carrier are that shipment’s.',
    'count',
    SHIP_DIMS,
    { source: { id: 'ship', sql: 'count()' } },
  ),
  hours_to_ship_p50: w2(
    'hours_to_ship_p50',
    'Time to ship (median)',
    'Hours from placement to the first shipment that left, the median over the orders shipped in the period. The total is the median over every order in scope, never an average of rows.',
    'hours',
    SHIP_DIMS,
    {
      kind: 'distribution',
      total: 'query',
      source: { id: 'ship', sql: 'round(quantileExact(0.5)(hours_to_ship), 1)' },
    },
  ),
  hours_to_ship_p90: w2(
    'hours_to_ship_p90',
    'Time to ship (90th percentile)',
    'Hours from placement to the first shipment that left: 9 orders in 10 shipped within this.',
    'hours',
    SHIP_DIMS,
    {
      kind: 'distribution',
      total: 'query',
      source: { id: 'ship', sql: 'round(quantileExact(0.9)(hours_to_ship), 1)' },
    },
  ),
  orders_delivered: w2(
    'orders_delivered',
    'Orders delivered',
    'Orders whose LAST shipment was delivered in the period, counted only once EVERY shipment of the order is delivered.',
    'count',
    SHIP_DIMS,
    { source: { id: 'deliver', sql: 'count()' } },
  ),
  hours_to_deliver_p50: w2(
    'hours_to_deliver_p50',
    'Time to deliver (median)',
    'Hours from placement to the last delivery, over orders fully delivered in the period. Orders still in transit are left out (they show in the backlog).',
    'hours',
    SHIP_DIMS,
    {
      kind: 'distribution',
      total: 'query',
      source: { id: 'deliver', sql: 'round(quantileExact(0.5)(hours_to_deliver), 1)' },
    },
  ),
  hours_to_deliver_p90: w2(
    'hours_to_deliver_p90',
    'Time to deliver (90th percentile)',
    'Hours from placement to the last delivery: 9 fully delivered orders in 10 arrived within this.',
    'hours',
    SHIP_DIMS,
    {
      kind: 'distribution',
      total: 'query',
      source: { id: 'deliver', sql: 'round(quantileExact(0.9)(hours_to_deliver), 1)' },
    },
  ),
  shipping_cost_minor: w2(
    'shipping_cost_minor',
    'Shipping cost',
    'The carrier cost of the shipments that left in the period, per currency (shipments without a known cost are counted apart).',
    'minor',
    SHIP_DIMS,
    { source: { id: 'shipments', sql: 'sum(coalesce(cost_minor, 0))' } },
  ),
  shipping_cost_unknown: w2(
    'shipping_cost_unknown',
    'Shipments without a cost',
    'Shipments that left with no known carrier cost.',
    'count',
    SHIP_DIMS,
    { source: { id: 'shipments', sql: 'countIf(cost_minor IS NULL)' } },
  ),
  return_requests: w2(
    'return_requests',
    'Return requests',
    'Returns requested in the period. Reasons are not shown until they are a closed list (#937).',
    'count',
    ['store'],
    { source: { id: 'return_requests', sql: 'uniqExact(return_id)' }, total: 'query' },
  ),
  payments_authorized: w2(
    'payments_authorized',
    'Payments authorised',
    'Distinct payments authorised in the period.',
    'count',
    PAYMENT_DIMS,
    {
      source: { id: 'payments', sql: "uniqExactIf(payment_id, outcome = 'authorized')" },
      total: 'query',
    },
  ),
  payments_captured: w2(
    'payments_captured',
    'Payments captured',
    'Distinct payments captured in the period.',
    'count',
    PAYMENT_DIMS,
    {
      source: { id: 'payments', sql: "uniqExactIf(payment_id, outcome = 'captured')" },
      total: 'query',
    },
  ),
  payments_failed: w2(
    'payments_failed',
    'Payments with a failure',
    'Distinct payments with at least one failure in the period: a failed authorisation OR capture (the event does not say which). Retries on the same payment count once; a retry that creates a new payment is a new payment.',
    'count',
    [...PAYMENT_DIMS, 'failure_reason'],
    {
      source: { id: 'payments', sql: "uniqExactIf(payment_id, outcome = 'failed')" },
      total: 'query',
    },
  ),
  payments_with_outcome: w2(
    'payments_with_outcome',
    'Payments with an outcome',
    'Distinct payments authorised, captured or failed in the period (the failure rate’s base).',
    'count',
    PAYMENT_DIMS,
    { source: { id: 'payments', sql: 'uniqExact(payment_id)' }, total: 'query' },
  ),
  payment_failure_rate_bp: w2(
    'payment_failure_rate_bp',
    'Payment failure rate',
    'Payments with a failure ÷ payments with any outcome in the period, in basis points.',
    'bp',
    PAYMENT_DIMS,
    {
      derived: { inputs: ['payments_failed', 'payments_with_outcome'] },
      formula: 'payments with a failure ÷ payments with an outcome',
    },
  ),
  refunds_failed: w2(
    'refunds_failed',
    'Failed refunds',
    'Distinct refunds the PSP refused in the period.',
    'count',
    ['store'],
    { source: { id: 'refund_failures', sql: 'uniqExact(refund_id)' }, total: 'query' },
  ),
};

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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(orders)' },
  },
  bookings_minor: {
    id: 'bookings_minor',
    label: 'Bookings',
    description:
      'Order totals by placement day; cancelled and failed-payment orders excluded. On tax-exclusive stores the total is gross − discounts + shipping + tax; on tax-inclusive stores gross − discounts + shipping, with the tax inside.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(total_minor)' },
  },
  net_bookings_minor: {
    id: 'net_bookings_minor',
    label: 'Net bookings',
    description:
      'Bookings minus the succeeded refunds of the orders placed that day (cohort-attributed). Orders whose payment only failed are left out, as are cancelled ones (they count only in cancelled orders / orders placed).',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(net_minor)' },
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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    derived: { inputs: ['bookings_minor', 'orders'] },
  },
  refunds_minor: {
    id: 'refunds_minor',
    label: 'Refunds',
    description:
      'Succeeded refunds by the day they were issued. By product or category: a refund for a return is split over the returned lines (by their paid value); a refund with no return has no product (shown as none), never guessed.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'refund_reason', 'country', 'sales_channel', 'product', 'category'],
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
    dimensions: ['store', 'country', 'sales_channel'],
    derived: { inputs: ['refunds_minor', 'bookings_minor'] },
  },
  units: {
    id: 'units',
    label: 'Units sold',
    description:
      'Line quantities of orders that are not cancelled. Counts orders whose payment failed (only cancelled orders are left out), unlike the order-level figures (orders, bookings, AOV, gross sales, discounts, shipping, tax), which leave failed-payment orders out.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: [
      'store',
      'product',
      'country',
      'sales_channel',
      'category',
      'customer_type',
      'customer_group',
    ],
    source: { id: 'lines', sql: 'sum(quantity)' },
  },
  product_net_minor: {
    id: 'product_net_minor',
    label: 'Product sales',
    description:
      'Line totals of orders that are not cancelled, tax included on both price bases (exclusive stores add it, inclusive stores have it inside). Counts orders whose payment failed (only cancelled orders are left out), unlike the order-level figures (orders, bookings, AOV, gross sales, discounts, shipping, tax), which leave failed-payment orders out.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: [
      'store',
      'product',
      'country',
      'sales_channel',
      'category',
      'customer_type',
      'customer_group',
    ],
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
  live_orders: {
    id: 'live_orders',
    label: 'Orders (live)',
    description:
      'Live, not bookings: orders as they are placed, cancellations included, for the live tiles; use orders for the books.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store'],
    grains: ['day', 'total'],
    source: { id: 'live', sql: 'uniqExact(order_id)' },
  },
  live_placed_minor: {
    id: 'live_placed_minor',
    label: 'Placed (live)',
    description:
      'Live, not bookings: order totals as they are placed, cancellations included; use bookings_minor for the books.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store'],
    grains: ['day', 'total'],
    source: { id: 'live', sql: 'sum(total_minor)' },
  },

  // ---- BI v2 (#871): Overview ---------------------------------------------------------------------------------
  net_sales_minor: {
    id: 'net_sales_minor',
    label: 'Net sales',
    description:
      'What customers paid for products after discounts, before tax and without shipping: per order line, its total minus its tax, summed. Comparable across stores whatever their price basis. Orders that are not cancelled, by placement day. Counts orders whose payment failed (only cancelled orders are left out), unlike the order-level figures (orders, bookings, AOV, gross sales, discounts, shipping, tax), which leave failed-payment orders out.',
    formula: 'Σ over order lines (line total − line tax)',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: [
      'store',
      'product',
      'country',
      'sales_channel',
      'category',
      'customer_type',
      'customer_group',
    ],
    source: { id: 'lines', sql: 'sum(total_minor - tax_minor)' },
  },
  gross_sales_minor: {
    id: 'gross_sales_minor',
    label: 'Gross sales',
    description:
      "Items at their unit prices before discounts and shipping. Includes tax on tax-inclusive stores and excludes it on tax-exclusive ones: read it within one store's price basis. Orders whose payment only failed are left out, as are cancelled ones (they count only in cancelled orders / orders placed).",
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(gross_minor)' },
  },
  discounts_minor: {
    id: 'discounts_minor',
    label: 'Discounts',
    description:
      'Discounts allocated to the order lines. Free shipping is not included: it shows as shipping 0, and the value of the shipping given away is not recorded. Orders whose payment only failed are left out, as are cancelled ones (they count only in cancelled orders / orders placed).',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(discount_minor)' },
  },
  shipping_minor: {
    id: 'shipping_minor',
    label: 'Shipping charged',
    description:
      'Shipping charged to customers; 0 for free shipping. Orders whose payment only failed are left out, as are cancelled ones (they count only in cancelled orders / orders placed).',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(shipping_minor)' },
  },
  tax_minor: {
    id: 'tax_minor',
    label: 'Tax',
    description:
      'Tax on the orders: added to the total on tax-exclusive stores, inside it on tax-inclusive ones. Orders whose payment only failed are left out, as are cancelled ones (they count only in cancelled orders / orders placed).',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(tax_minor)' },
  },
  items_per_order_bp: {
    id: 'items_per_order_bp',
    label: 'Items per order',
    description: 'Units sold divided by orders, × 10 000 (1.85 items = 18 500).',
    formula: 'units ÷ orders × 10 000',
    unit: 'bp',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    derived: { inputs: ['units', 'orders'] },
  },
  placed_orders: {
    id: 'placed_orders',
    label: 'Orders placed',
    description:
      'Every order placed in the period, cancelled ones included; orders whose payment only failed are left out.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(placed_orders)' },
  },
  cancelled_orders: {
    id: 'cancelled_orders',
    label: 'Cancelled orders',
    description:
      'Orders placed in the period and since cancelled. Orders whose payment only failed are left out, as are cancelled ones (they count only in cancelled orders / orders placed).',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    source: { id: 'sales', sql: 'sum(cancelled_orders)' },
  },
  cancellation_rate_bp: {
    id: 'cancellation_rate_bp',
    label: 'Cancellation rate',
    description: 'Cancelled orders divided by orders placed, in basis points.',
    formula: 'cancelled orders ÷ orders placed × 10 000',
    unit: 'bp',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type', 'customer_group'],
    derived: { inputs: ['cancelled_orders', 'placed_orders'] },
  },
  returned_units: {
    id: 'returned_units',
    label: 'Units returned',
    description: 'Units received back from customers, by the UTC day they arrived.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    source: { id: 'returns', sql: 'sum(quantity)' },
  },
  return_rate_bp: {
    id: 'return_rate_bp',
    label: 'Return rate',
    description:
      'Units returned in the period divided by units sold in the period. They are not the same orders: a return this month may belong to last month’s sale.',
    formula: 'units returned ÷ units sold × 10 000',
    unit: 'bp',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    derived: { inputs: ['returned_units', 'units'] },
  },
  // ---- BI v2: Products and categories --------------------------------------------------------------------------
  product_net_ex_tax_minor: {
    id: 'product_net_ex_tax_minor',
    label: 'Product net sales',
    description:
      'Per order line, its total minus its tax: after discounts, before tax, on both price bases. Counts orders whose payment failed (only cancelled orders are left out), unlike the order-level figures (orders, bookings, AOV, gross sales, discounts, shipping, tax), which leave failed-payment orders out.',
    formula: 'Σ (line total − line tax)',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: [
      'store',
      'product',
      'country',
      'sales_channel',
      'category',
      'customer_type',
      'customer_group',
    ],
    source: { id: 'lines', sql: 'sum(total_minor - tax_minor)' },
  },
  product_gross_minor: {
    id: 'product_gross_minor',
    label: 'Product sales (gross)',
    description:
      'Unit price × quantity before discounts (tax inside on tax-inclusive stores). Counts orders whose payment failed (only cancelled orders are left out), unlike the order-level figures (orders, bookings, AOV, gross sales, discounts, shipping, tax), which leave failed-payment orders out.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: [
      'store',
      'product',
      'country',
      'sales_channel',
      'category',
      'customer_type',
      'customer_group',
    ],
    source: { id: 'lines', sql: 'sum(unit_price_minor * quantity)' },
  },
  product_discount_minor: {
    id: 'product_discount_minor',
    label: 'Product discounts',
    description:
      'Discounts allocated to the order lines. Counts orders whose payment failed (only cancelled orders are left out), unlike the order-level figures (orders, bookings, AOV, gross sales, discounts, shipping, tax), which leave failed-payment orders out.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: [
      'store',
      'product',
      'country',
      'sales_channel',
      'category',
      'customer_type',
      'customer_group',
    ],
    source: { id: 'lines', sql: 'sum(discount_minor)' },
  },
  product_orders: {
    id: 'product_orders',
    label: 'Orders with the product',
    description:
      'Distinct orders containing the product (or a product of the category). A distinct count: it is not added up across rows, so a total is not given. Counts orders whose payment failed (only cancelled orders are left out), unlike the order-level figures (orders, bookings, AOV, gross sales, discounts, shipping, tax), which leave failed-payment orders out.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: [
      'store',
      'product',
      'country',
      'sales_channel',
      'category',
      'customer_type',
      'customer_group',
    ],
    source: { id: 'lines', sql: 'uniqExact(order_id)' },
    total: 'none',
  },
  product_returned_units: {
    id: 'product_returned_units',
    label: 'Product units returned',
    description: 'Units of the product received back, by the UTC day they arrived.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    source: { id: 'returns', sql: 'sum(quantity)' },
  },
  product_return_rate_bp: {
    id: 'product_return_rate_bp',
    label: 'Product return rate',
    description:
      'Its units returned divided by its units sold, in the period (not the same orders).',
    formula: 'product units returned ÷ units sold × 10 000',
    unit: 'bp',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    derived: { inputs: ['product_returned_units', 'units'] },
  },
  // ---- BI v2: Inventory, snapshot (getInventoryHealth; queryMetrics refuses them) ---------------------------------
  stock_on_hand: snapshot(
    'stock_on_hand',
    'On hand',
    'Units in the warehouses (per warehouse, and their sum for the item).',
  ),
  stock_reserved: snapshot(
    'stock_reserved',
    'Reserved',
    'Units held for placed orders not yet shipped.',
  ),
  stock_available: snapshot(
    'stock_available',
    'Available',
    'On hand minus reserved; negative when oversold.',
  ),
  stock_incoming: snapshot(
    'stock_incoming',
    'Incoming',
    'Units expected from purchase orders. Not tracked yet: always 0, because nothing records orders placed with suppliers. 0 does NOT mean nothing is on order.',
  ),
  units_sold_per_day_milli: snapshot(
    'units_sold_per_day_milli',
    'Sales rate',
    'Units on orders that are not cancelled, by the UTC day the order was placed, over the full days before today in the sales window, divided by the window, × 1 000. Returns are not netted; days out of stock are not removed, so the rate understates demand after a stock-out (flagged on the row).',
    'units sold in the window ÷ window days × 1 000',
    'milli',
  ),
  days_of_cover: snapshot(
    'days_of_cover',
    'Days of cover',
    'Available (summed over the warehouses) divided by the sales rate, rounded down; 0 when available is 0 or less; empty when nothing sold.',
    'available ÷ sales rate',
  ),
  suggested_reorder_units: snapshot(
    'suggested_reorder_units',
    'Suggested reorder',
    'How much to order so the stock covers the lead time plus the cover days at the current sales rate. Incoming is not tracked yet, so this assumes nothing is on order: subtract what you have already ordered from suppliers.',
    'max(0, ⌈sales rate × (lead time + cover days)⌉ − available − incoming)',
  ),
  // ---- BI v2: Inventory, series (source stock: organization-wide, or the stock items the caller's stores map) ------
  stockout_events: {
    id: 'stockout_events',
    label: 'Stock-outs',
    description:
      'Times a movement took a stock item’s on-hand in a warehouse from above 0 to 0 or below.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['warehouse'],
    source: { id: 'stock', sql: 'sum(stockout_events)' },
  },
  units_received: {
    id: 'units_received',
    label: 'Units received',
    description: 'Receipts and transfers into the warehouses (positive movements).',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['warehouse'],
    source: { id: 'stock', sql: 'sum(units_received)' },
  },
  units_adjusted: {
    id: 'units_adjusted',
    label: 'Units adjusted',
    description: 'The net of stock adjustments and cycle counts (signed).',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['warehouse'],
    source: { id: 'stock', sql: 'sum(units_adjusted)' },
  },
  ...WAVE2,
};

/** What `listMetrics` answers for a caller (finance metrics only for finance principals). */
export function catalogueFor(opts: { finance: boolean; stores: { id: string; code: string }[] }) {
  return {
    version: 3,
    max_range_days: LIMITS.max_range_days,
    max_metrics: LIMITS.max_metrics,
    max_dimensions: LIMITS.max_dimensions,
    max_rows: LIMITS.max_rows,
    grains: [...GRAINS],
    stores: opts.stores,
    dimensions: DIMENSIONS.map((id) => ({
      id,
      label: DIMENSION_INFO[id].label,
      description: DIMENSION_INFO[id].description,
      filter: DIMENSION_INFO[id].filter,
      max_filter_values: DIMENSION_INFO[id].max,
    })),
    inventory_defaults: { ...INVENTORY_DEFAULTS },
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
        kind: m.kind ?? 'series',
        additive: isAdditive(m),
        formula: m.formula ?? null,
      })),
  };
}
