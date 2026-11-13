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
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const GRAINS = ['day', 'week', 'month', 'total'] as const;
export type Grain = (typeof GRAINS)[number];

export const REFUND_REASONS = ['return', 'cancellation', 'goodwill', 'chargeback'] as const;
export const CUSTOMER_TYPES = ['new', 'returning', 'unknown'] as const;

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
} as const;

/** The models a metric reads (one compiled query per source per request). */
export type SourceId =
  'sales' | 'refunds' | 'lines' | 'returns' | 'stock' | 'customers' | 'cash' | 'ledger' | 'live';

export interface MetricDefinition {
  id: MetricId;
  label: string;
  description: string;
  unit: 'minor' | 'count' | 'bp' | 'milli';
  /** `snapshot` metrics describe now (inventory, #871): getInventoryHealth serves them, queryMetrics refuses them. */
  kind?: 'series' | 'snapshot';
  /** The calculation in plain words, shown with the definition. */
  formula?: string;
  /** How a per-currency total is formed: `sum` of the rows (default), or `none` (a distinct count: not summable). */
  total?: 'sum' | 'none';
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
    description: 'The warehouse of the stock movement.',
    filter: 'warehouse_ids',
    max: LIMITS.max_warehouse_ids,
  },
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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
    source: { id: 'sales', sql: 'sum(total_minor)' },
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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
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
    dimensions: ['store', 'refund_reason', 'country', 'sales_channel'],
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
    description: 'Line quantities of orders that are not cancelled.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    source: { id: 'lines', sql: 'sum(quantity)' },
  },
  product_net_minor: {
    id: 'product_net_minor',
    label: 'Product sales',
    description:
      'Line totals of orders that are not cancelled, tax included on both price bases (exclusive stores add it, inclusive stores have it inside).',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
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
      'What customers paid for products after discounts, before tax and without shipping: per order line, its total minus its tax, summed. Comparable across stores whatever their price basis. Orders that are not cancelled, by placement day.',
    formula: 'Σ over order lines (line total − line tax)',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    source: { id: 'lines', sql: 'sum(total_minor - tax_minor)' },
  },
  gross_sales_minor: {
    id: 'gross_sales_minor',
    label: 'Gross sales',
    description:
      "Items at their unit prices before discounts and shipping. Includes tax on tax-inclusive stores and excludes it on tax-exclusive ones: read it within one store's price basis.",
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
    source: { id: 'sales', sql: 'sum(gross_minor)' },
  },
  discounts_minor: {
    id: 'discounts_minor',
    label: 'Discounts',
    description:
      'Discounts allocated to the order lines. Free shipping is not included: it shows as shipping 0, and the value of the shipping given away is not recorded.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
    source: { id: 'sales', sql: 'sum(discount_minor)' },
  },
  shipping_minor: {
    id: 'shipping_minor',
    label: 'Shipping charged',
    description: 'Shipping charged to customers; 0 for free shipping.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
    source: { id: 'sales', sql: 'sum(shipping_minor)' },
  },
  tax_minor: {
    id: 'tax_minor',
    label: 'Tax',
    description:
      'Tax on the orders: added to the total on tax-exclusive stores, inside it on tax-inclusive ones.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
    source: { id: 'sales', sql: 'sum(placed_orders)' },
  },
  cancelled_orders: {
    id: 'cancelled_orders',
    label: 'Cancelled orders',
    description: 'Orders placed in the period and since cancelled.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
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
    dimensions: ['store', 'country', 'sales_channel', 'customer_type'],
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
      'Per order line, its total minus its tax: after discounts, before tax, on both price bases.',
    formula: 'Σ (line total − line tax)',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    source: { id: 'lines', sql: 'sum(total_minor - tax_minor)' },
  },
  product_gross_minor: {
    id: 'product_gross_minor',
    label: 'Product sales (gross)',
    description: 'Unit price × quantity before discounts (tax inside on tax-inclusive stores).',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    source: { id: 'lines', sql: 'sum(unit_price_minor * quantity)' },
  },
  product_discount_minor: {
    id: 'product_discount_minor',
    label: 'Product discounts',
    description: 'Discounts allocated to the order lines.',
    unit: 'minor',
    currency_bound: true,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
    source: { id: 'lines', sql: 'sum(discount_minor)' },
  },
  product_orders: {
    id: 'product_orders',
    label: 'Orders with the product',
    description:
      'Distinct orders containing the product (or a product of the category). A distinct count: it is not added up across rows, so a total is not given.',
    unit: 'count',
    currency_bound: false,
    finance: false,
    available: true,
    dimensions: ['store', 'product', 'country', 'sales_channel', 'category', 'customer_type'],
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
};

/** What `listMetrics` answers for a caller (finance metrics only for finance principals). */
export function catalogueFor(opts: { finance: boolean; stores: { id: string; code: string }[] }) {
  return {
    version: 2,
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
