// `queryMetrics` as text/csv (#604, the #603 delta): the SAME MetricResult (validated, scoped, capped at `limit`)
// rendered for a spreadsheet, so a CSV can never widen what the JSON answer would show.
//   * Columns: period, currency, the requested dimensions in request order, the requested metrics in request order.
//   * RFC 4180: CRLF line ends; every TEXT cell quoted with `"` doubled; integers bare; null = an empty cell.
//   * CSV injection: a text cell starting with = + - @, a tab or a CR gets a leading `'`, so a spreadsheet never
//     evaluates it as a formula (the only free text that reaches a cell today is `provider`; the guard covers all).
//   * No totals line; `X-Truncated` (set by the route) says more rows matched than `limit`.
import type { Dimension } from './catalogue';
import type { DimensionColumn, MetricLabels, MetricResult } from './execute';
import type { InventoryHealth } from './inventory';

const COLUMN: Readonly<Record<Dimension, DimensionColumn>> = {
  store: 'store_id',
  product: 'product_id',
  refund_reason: 'refund_reason',
  provider: 'provider',
  country: 'country',
  sales_channel: 'sales_channel_id',
  category: 'category_id',
  customer_type: 'customer_type',
  warehouse: 'warehouse_id',
};

/** The label map of a dimension (only id-valued dimensions have one). */
const LABELLED: Partial<Record<Dimension, keyof MetricLabels>> = {
  store: 'store',
  product: 'product',
  category: 'category',
  sales_channel: 'sales_channel',
  warehouse: 'warehouse',
};

const FORMULA_START = /^[=+\-@\t\r]/;

/** One text cell: neutralised against formula injection, then quoted (RFC 4180). */
export function csvText(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`csv: a non-integer value ${v}`);
    return String(v);
  }
  return csvText(v);
}

/**
 * With `labels` (BI v2, #871: opt-in, `?labels=true`), one `<dimension>_label` column per labelled dimension is
 * appended AFTER the documented columns, so the default CSV stays byte-for-byte what 0.4.28 documents.
 */
export function renderMetricCsv(result: MetricResult, opts: { labels?: boolean } = {}): string {
  const { query } = result;
  const dims = query.dimensions.map((d) => COLUMN[d]);
  const labelled = opts.labels ? query.dimensions.filter((d) => LABELLED[d] !== undefined) : [];
  const header = [
    'period',
    'currency',
    ...dims,
    ...query.metrics,
    ...labelled.map((d) => `${d}_label`),
  ].map(csvText);
  const lines = [header.join(',')];
  for (const r of result.rows)
    lines.push(
      [
        r.period,
        r.currency,
        ...dims.map((d) => r[d]),
        ...query.metrics.map((m) => r.values[m]),
        ...labelled.map((d) => {
          const id = r[COLUMN[d]];
          return id === null ? null : (result.labels?.[LABELLED[d]!]?.[id] ?? null);
        }),
      ]
        .map(cell)
        .join(','),
    );
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * `getInventoryHealth` as text/csv (#871 a3): one line per stock item × included warehouse, the item's figures repeated
 * on each, the page's rows in the page's order. The reorder list a supplier can be sent.
 */
export function renderInventoryCsv(result: InventoryHealth): string {
  const header = [
    'sku',
    'name',
    'warehouse_code',
    'warehouse_on_hand',
    'warehouse_reserved',
    'warehouse_available',
    'on_hand',
    'reserved',
    'available',
    'incoming',
    'units_sold',
    'units_sold_per_day_milli',
    'days_of_cover',
    'status',
    'suggested_reorder_units',
    'suggestion_partial',
    'rate_understated',
    'velocity_days',
    'lead_time_days',
    'cover_days',
  ];
  const lines = [header.map(csvText).join(',')];
  for (const r of result.rows)
    for (const w of r.warehouses)
      lines.push(
        [
          r.sku,
          r.name,
          w.warehouse_code,
          w.on_hand,
          w.reserved,
          w.available,
          r.on_hand,
          r.reserved,
          r.available,
          r.incoming,
          r.units_sold,
          r.units_sold_per_day_milli,
          r.days_of_cover,
          r.status,
          r.suggested_reorder_units,
          String(r.suggestion_partial),
          r.rate_understated === null ? null : String(r.rate_understated),
          r.parameters.velocity_days,
          r.parameters.lead_time_days,
          r.parameters.cover_days,
        ]
          .map(cell)
          .join(','),
      );
  return `${lines.join('\r\n')}\r\n`;
}
