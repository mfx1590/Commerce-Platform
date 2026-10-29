// `queryMetrics` as text/csv (#604, the #603 delta): the SAME MetricResult (validated, scoped, capped at `limit`)
// rendered for a spreadsheet, so a CSV can never widen what the JSON answer would show.
//   * Columns: period, currency, the requested dimensions in request order, the requested metrics in request order.
//   * RFC 4180: CRLF line ends; every TEXT cell quoted with `"` doubled; integers bare; null = an empty cell.
//   * CSV injection: a text cell starting with = + - @, a tab or a CR gets a leading `'`, so a spreadsheet never
//     evaluates it as a formula (the only free text that reaches a cell today is `provider`; the guard covers all).
//   * No totals line; `X-Truncated` (set by the route) says more rows matched than `limit`.
import type { Dimension } from './catalogue';
import type { MetricResult } from './execute';

const COLUMN: Readonly<
  Record<Dimension, 'store_id' | 'product_id' | 'refund_reason' | 'provider'>
> = {
  store: 'store_id',
  product: 'product_id',
  refund_reason: 'refund_reason',
  provider: 'provider',
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

export function renderMetricCsv(result: MetricResult): string {
  const { query } = result;
  const dims = query.dimensions.map((d) => COLUMN[d]);
  const header = ['period', 'currency', ...dims, ...query.metrics].map(csvText);
  const lines = [header.join(',')];
  for (const r of result.rows)
    lines.push(
      [r.period, r.currency, ...dims.map((d) => r[d]), ...query.metrics.map((m) => r.values[m])]
        .map(cell)
        .join(','),
    );
  return `${lines.join('\r\n')}\r\n`;
}
