/** Shared fixtures for the BI v2 tests (#871): a catalogue, answers, an inventory page. */
import type {
  InventoryHealth,
  MetricCatalogue,
  MetricId,
  MetricResult,
  Movers,
} from '@/app/(hq)/bi/_v2/model';

export const STORE_A = '00000000-0000-4000-8000-000000000031';
export const STORE_B = '00000000-0000-4000-8000-000000000032';
export const CAT = '40000000-0000-4000-8000-000000000001';
export const PROD = '20000000-0000-4000-8000-000000000001';
export const PROD_2 = '20000000-0000-4000-8000-000000000002';
export const ITEM = '71000000-0000-4000-8000-000000000001';
export const WH = '00000000-0000-4000-8000-000000000021';

const def = (
  id: MetricId,
  label: string,
  unit: 'minor' | 'count' | 'bp' | 'milli',
  dims: string[],
) => ({
  id,
  label,
  description: `${label}: the catalogue's written definition.`,
  unit,
  currency_bound: unit === 'minor',
  finance: false,
  available: true,
  dimensions: dims,
  formula: unit === 'bp' ? `${id} = a ÷ b × 10 000` : null,
});

const ALL = ['store', 'country', 'sales_channel', 'category', 'product'];

export function catalogue(overrides: Partial<MetricCatalogue> = {}): MetricCatalogue {
  return {
    version: 2,
    max_range_days: 366,
    max_metrics: 6,
    max_dimensions: 2,
    max_rows: 1000,
    grains: ['day', 'week', 'month', 'total'],
    stores: [
      { id: STORE_A, code: 'brand-a' },
      { id: STORE_B, code: 'brand-b' },
    ],
    metrics: [
      def('net_sales_minor', 'Net sales', 'minor', ALL),
      def('gross_sales_minor', 'Gross sales', 'minor', ['store', 'country', 'sales_channel']),
      def('discounts_minor', 'Discounts', 'minor', ['store', 'country', 'sales_channel']),
      def('shipping_minor', 'Shipping charged', 'minor', ['store', 'country', 'sales_channel']),
      def('tax_minor', 'Tax', 'minor', ['store', 'country', 'sales_channel']),
      def('refunds_minor', 'Refunds', 'minor', ['store']),
      def('net_bookings_minor', 'Net bookings', 'minor', ['store']),
      def('orders', 'Orders', 'count', ALL),
      def('units', 'Units', 'count', ALL),
      def('aov_minor', 'Average order value', 'minor', ['store', 'country', 'sales_channel']),
      def('items_per_order_bp', 'Items per order', 'bp', ['store']),
      def('product_net_ex_tax_minor', 'Product net sales', 'minor', ['product', 'category']),
      def('product_returned_units', 'Units returned', 'count', ['product', 'category']),
      def('product_return_rate_bp', 'Return rate', 'bp', ['product', 'category']),
    ] as MetricCatalogue['metrics'],
    inventory_defaults: { velocity_days: 28, lead_time_days: 14, cover_days: 30, dead_days: 60 },
    ...overrides,
  };
}

/** A total-grain answer of `metrics` in JPY (and the counts with it), compared. */
export function totals(
  metrics: MetricId[],
  values: Record<string, number>,
  previous: Record<string, number> = {},
  extra: Partial<MetricResult> = {},
): MetricResult {
  return {
    query: {
      metrics,
      dimensions: [],
      grain: 'total',
      from: '2026-11-01',
      to: '2026-11-15',
      limit: 100,
    },
    generated_at: '2026-11-15T09:00:00Z',
    data_as_of: '2026-11-15T08:55:00Z',
    truncated: false,
    rows: [],
    currency_totals: [
      { currency: 'JPY', values: Object.fromEntries(metrics.map((m) => [m, values[m] ?? null])) },
    ],
    compare: {
      mode: 'previous_period',
      from: '2026-10-18',
      to: '2026-11-01',
      offset: 'P14D',
      current_incomplete: false,
      truncated: false,
      rows: [],
      changes: metrics.map((metric) => {
        const now = values[metric] ?? null;
        const before = previous[metric] ?? null;
        return {
          currency: 'JPY',
          metric,
          current: now,
          previous: before,
          change: now !== null && before !== null ? now - before : null,
          change_bp: now !== null && before ? Math.round(((now - before) / before) * 10000) : null,
        };
      }),
    },
    ...extra,
  } as MetricResult;
}

export function movers(): Movers {
  return {
    query: { metric: 'net_sales_minor', dimension: 'store', from: '2026-11-01', to: '2026-11-15' },
    generated_at: '2026-11-15T09:00:00Z',
    data_as_of: null,
    current: { from: '2026-11-01', to: '2026-11-15' },
    previous: { from: '2026-10-18', to: '2026-11-01' },
    current_incomplete: false,
    by_currency: [
      {
        currency: 'JPY',
        total_current: 300000,
        total_previous: 250000,
        risers: [
          {
            key: STORE_A,
            current: 200000,
            previous: 120000,
            change: 80000,
            change_bp: 6667,
            is_new: false,
            is_gone: false,
            share_bp: 6667,
          },
        ],
        fallers: [
          {
            key: STORE_B,
            current: 100000,
            previous: 130000,
            change: -30000,
            change_bp: -2308,
            is_new: false,
            is_gone: false,
            share_bp: 3333,
          },
        ],
      },
    ],
    labels: { store: { [STORE_A]: 'Brand A', [STORE_B]: 'Brand B' } },
  } as unknown as Movers;
}

export function inventory(overrides: Partial<InventoryHealth> = {}): InventoryHealth {
  return {
    query: {},
    generated_at: '2026-11-15T09:00:00Z',
    position_as_of: '2026-11-15T09:00:00Z',
    data_as_of: '2026-11-15T08:55:00Z',
    rate_available: true,
    incoming_tracked: false,
    parameters: { velocity_days: 28, lead_time_days: 14, cover_days: 30, dead_days: 60 },
    summary: { stock_out: 1, low: 2, reorder: 3, dead: 4, overstock: 0, ok: 10 },
    total: 1,
    rows: [
      {
        stock_item_id: ITEM,
        sku: 'TEE-M-RED',
        name: 'Tee M red',
        store_ids: [STORE_A, STORE_B],
        shared: true,
        warehouses: [
          {
            warehouse_id: WH,
            warehouse_code: 'wh-eu',
            on_hand: 12,
            reserved: 4,
            available: 8,
            incoming: 0,
            last_receipt_at: null,
          },
        ],
        on_hand: 12,
        reserved: 4,
        available: 8,
        incoming: 0,
        units_sold: 56,
        units_sold_per_day_milli: 2000,
        rate_understated: true,
        days_of_cover: 4,
        last_sale_at: '2026-11-14T10:00:00Z',
        last_receipt_at: null,
        status: 'low',
        suggested_reorder_units: 80,
        suggestion_partial: true,
        parameters: { velocity_days: 28, lead_time_days: 14, cover_days: 30, dead_days: 60 },
        parameters_source: 'default',
      },
    ],
    ...overrides,
  } as unknown as InventoryHealth;
}
