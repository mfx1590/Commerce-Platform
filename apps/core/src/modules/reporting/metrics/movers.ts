// `listMetricMovers` (BI v2, #871 a3): what changed — the largest risers and fallers of ONE additive metric by ONE
// dimension, between [from, to) and the comparison range (comparisonRange's offset rules).
//
//   * ADDITIVE series metrics only (a sum of minor units or counts; no ratio, no distinct count, no snapshot, no live):
//     a change in a ratio is not a ranking of contributions (#871 review 8). A metric × dimension pair the catalogue
//     does not list is a 400.
//   * RANKED BY ABSOLUTE CHANGE INSIDE ONE CURRENCY BLOCK. Money is never ranked or summed across currencies (EUR cents
//     and yen are not comparable); counts form one block with currency null.
//   * The % is reported, never used to rank, and is null below `min_base` (default 10 for counts, 10 MAJOR units for
//     money: scaled by the currency's ISO 4217 exponent). `is_new` / `is_gone` say what a % cannot.
//   * `share_bp`: this mover's change ÷ the block's total change — "most of the drop came from X" without a % on a
//     tiny base.
// Movers report what changed, never why: the page and BI Q&A's template say so.
import { validationError } from '../../../lib/errors';
import { isAdditive, LIMITS, METRICS, type Dimension, type MetricId } from './catalogue';
import {
  executeMetricQuery,
  type ExecuteOptions,
  type MetricResult,
  type MetricsReader,
} from './execute';
import { comparisonRange, parseMetricQuery, type CompareMode, type MetricQuery } from './query';

export const MOVER_DIMENSIONS = [
  'store',
  'country',
  'sales_channel',
  'product',
  'category',
] as const;
export type MoverDimension = (typeof MOVER_DIMENSIONS)[number];

export interface MoversQuery {
  metric: MetricId;
  dimension: MoverDimension;
  from: string;
  to: string;
  compare: CompareMode;
  filters: MetricQuery['filters'];
  min_base?: number;
  limit: number;
}

export interface Mover {
  key: string;
  current: number;
  previous: number;
  change: number;
  change_bp: number | null;
  is_new: boolean;
  is_gone: boolean;
  share_bp: number | null;
}

export interface MoversResult {
  query: MoversQuery;
  generated_at: string;
  data_as_of: string | null;
  current: { from: string; to: string };
  previous: { from: string; to: string };
  current_incomplete: boolean;
  by_currency: {
    currency: string | null;
    total_current: number | null;
    total_previous: number | null;
    risers: Mover[];
    fallers: Mover[];
  }[];
}

const ROW_KEY: Readonly<
  Record<MoverDimension, 'store_id' | 'country' | 'sales_channel_id' | 'product_id' | 'category_id'>
> = {
  store: 'store_id',
  country: 'country',
  sales_channel: 'sales_channel_id',
  product: 'product_id',
  category: 'category_id',
};

export function parseMoversQuery(body: unknown): MoversQuery {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw validationError('the body must be a MetricMoversQuery object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b))
    if (
      !['metric', 'dimension', 'from', 'to', 'compare', 'filters', 'min_base', 'limit'].includes(k)
    )
      throw validationError(`unknown field ${k}`, { field: k });
  if (typeof b.metric !== 'string' || !(b.metric in METRICS))
    throw validationError('metric is a catalogue metric id', { field: 'metric' });
  const metric = b.metric as MetricId;
  if (!isAdditive(METRICS[metric]))
    throw validationError(`${metric} is not additive: movers rank sums of money or counts only`, {
      field: 'metric',
      metric,
    });
  if (
    typeof b.dimension !== 'string' ||
    !(MOVER_DIMENSIONS as readonly string[]).includes(b.dimension)
  )
    throw validationError(`dimension is one of ${MOVER_DIMENSIONS.join(', ')}`, {
      field: 'dimension',
    });
  const compare = (b.compare ?? 'previous_period') as CompareMode;
  // the period query's own validation: dates, the window, the dimension the metric accepts, filters, compare
  const q = parseMetricQuery({
    metrics: [metric],
    dimensions: [b.dimension],
    grain: 'total',
    from: b.from,
    to: b.to,
    ...(b.filters !== undefined ? { filters: b.filters } : {}),
    compare,
  });
  if (b.min_base !== undefined && (!Number.isSafeInteger(b.min_base) || (b.min_base as number) < 0))
    throw validationError('min_base is a non-negative integer', { field: 'min_base' });
  const limit = b.limit ?? 5;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > LIMITS.max_movers)
    throw validationError(`limit is an integer 1–${LIMITS.max_movers}`, { field: 'limit' });
  return {
    metric,
    dimension: b.dimension as MoverDimension,
    from: q.from,
    to: q.to,
    compare,
    filters: q.filters,
    ...(b.min_base !== undefined ? { min_base: b.min_base as number } : {}),
    limit: limit as number,
  };
}

/** The ISO 4217 exponent of a currency (EUR 2, JPY 0); 2 for one the runtime does not know. */
export function currencyExponent(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** The default minimum base: 10 for counts; 10 major units in the block's currency for money. */
export function defaultMinBase(currency: string | null): number {
  return currency === null ? 10 : 10 * 10 ** currencyExponent(currency);
}

const bp = (num: number, den: number): number => Math.round((num * 10_000) / den);

/** The ranking itself, pure: current and previous values per (currency, key) → the blocks. */
export function rankMovers(
  current: ReadonlyMap<string | null, ReadonlyMap<string, number>>,
  previous: ReadonlyMap<string | null, ReadonlyMap<string, number>>,
  opts: {
    limit: number;
    minBase?: number;
    /** The metric's full totals per currency (rows without a key included); the keyed sums when omitted. */
    totals?: {
      current: ReadonlyMap<string | null, number>;
      previous: ReadonlyMap<string | null, number>;
    };
  },
): MoversResult['by_currency'] {
  const currencies = [...new Set([...current.keys(), ...previous.keys()])].sort((a, b) =>
    String(a ?? '').localeCompare(String(b ?? '')),
  );
  return currencies.map((currency) => {
    const cur = current.get(currency) ?? new Map<string, number>();
    const prev = previous.get(currency) ?? new Map<string, number>();
    const minBase = opts.minBase ?? defaultMinBase(currency);
    const totalCurrent =
      opts.totals?.current.get(currency) ?? [...cur.values()].reduce((n, v) => n + v, 0);
    const totalPrevious =
      opts.totals?.previous.get(currency) ?? [...prev.values()].reduce((n, v) => n + v, 0);
    const totalChange = totalCurrent - totalPrevious;
    const movers: Mover[] = [...new Set([...cur.keys(), ...prev.keys()])].map((key) => {
      const c = cur.get(key) ?? 0;
      const p = prev.get(key) ?? 0;
      const change = c - p;
      return {
        key,
        current: c,
        previous: p,
        change,
        change_bp: p > 0 && p >= minBase ? bp(change, p) : null,
        is_new: p === 0 && c > 0,
        is_gone: p > 0 && c === 0,
        share_bp: totalChange === 0 ? null : bp(change, totalChange),
      };
    });
    // ties: the larger current value, then the key, so the order is stable
    const byKey = (a: Mover, b: Mover) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const risers = movers
      .filter((m) => m.change > 0)
      .sort((a, b) => b.change - a.change || b.current - a.current || byKey(a, b))
      .slice(0, opts.limit);
    const fallers = movers
      .filter((m) => m.change < 0)
      .sort((a, b) => a.change - b.change || b.previous - a.previous || byKey(a, b))
      .slice(0, opts.limit);
    return {
      currency,
      total_current: totalCurrent,
      total_previous: totalPrevious,
      risers,
      fallers,
    };
  });
}

/** The equivalent compare query of a movers question (also what BI Q&A records in its answer). */
export function moversMetricQuery(mq: MoversQuery): MetricQuery {
  return {
    metrics: [mq.metric],
    dimensions: [mq.dimension as Dimension],
    grain: 'total',
    from: mq.from,
    to: mq.to,
    filters: mq.filters,
    limit: LIMITS.max_rows,
    compare: mq.compare,
  };
}

export async function listMetricMovers(
  reader: MetricsReader,
  mq: MoversQuery,
  scope: readonly string[],
  opts: ExecuteOptions = {},
): Promise<MoversResult> {
  // every key of BOTH ranges, merged in full: a 1 000-row slice (sorted by key) would drop real movers and turn
  // a key present in only one slice into a false is_new / is_gone (#924 review)
  const r = await executeMetricQuery(reader, moversMetricQuery(mq), scope, {
    ...opts,
    noLimit: true,
  });
  return moversFromResult(mq, r, (opts.now ?? (() => new Date()))());
}

/** The ranking of an executed compare query (pure). */
export function moversFromResult(mq: MoversQuery, r: MetricResult, now: Date): MoversResult {
  const col = ROW_KEY[mq.dimension];
  const index = (rows: MetricResult['rows']) => {
    const m = new Map<string | null, Map<string, number>>();
    for (const row of rows) {
      const k = row[col];
      if (k === null) continue; // no key (e.g. a line whose product was never published): not a mover
      const block = m.get(row.currency) ?? new Map<string, number>();
      block.set(k, (block.get(k) ?? 0) + (row.values[mq.metric] ?? 0));
      m.set(row.currency, block);
    }
    return m;
  };
  const range = comparisonRange({ from: mq.from, to: mq.to, grain: 'total' }, mq.compare);
  return {
    query: mq,
    generated_at: now.toISOString(),
    data_as_of: r.data_as_of,
    current: { from: mq.from, to: mq.to },
    previous: { from: range.from, to: range.to },
    current_incomplete: r.compare!.current_incomplete,
    by_currency: rankMovers(index(r.rows), index(r.compare!.rows), {
      limit: mq.limit,
      totals: {
        current: new Map(r.currency_totals.map((t) => [t.currency, t.values[mq.metric] ?? 0])),
        previous: new Map(
          r.compare!.currency_totals.map((t) => [t.currency, t.values[mq.metric] ?? 0]),
        ),
      },
      ...(mq.min_base !== undefined ? { minBase: mq.min_base } : {}),
    }),
  };
}
