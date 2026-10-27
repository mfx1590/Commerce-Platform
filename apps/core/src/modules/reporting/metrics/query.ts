// `queryMetrics` request → a normalised, validated query, or `400 validation_error` naming the field. The route also
// validates the body against the contract's `MetricQuery` schema; this is the semantic layer on top (a dimension a
// metric does not accept, the window, `order_by` among the metrics) and a second line of defence.
import { validationError } from '../../../lib/errors';
import {
  DIMENSIONS,
  GRAINS,
  LIMITS,
  METRIC_IDS,
  METRICS,
  REFUND_REASONS,
  type Dimension,
  type Grain,
  type MetricId,
} from './catalogue';

export interface MetricQuery {
  metrics: MetricId[];
  dimensions: Dimension[];
  grain: Grain;
  from: string;
  to: string;
  filters: {
    store_ids?: string[];
    currencies?: string[];
    product_ids?: string[];
    refund_reasons?: string[];
  };
  order_by?: { metric: MetricId; direction: 'desc' | 'asc' };
  limit: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDay(s: unknown): s is string {
  if (typeof s !== 'string' || !DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function list<T extends string>(
  v: unknown,
  field: string,
  max: number,
  ok: (x: string) => x is T,
): T[] {
  if (!Array.isArray(v)) throw validationError(`${field} must be an array`, { field });
  if (v.length > max) throw validationError(`${field} has at most ${max} items`, { field });
  if (new Set(v).size !== v.length) throw validationError(`${field} must not repeat`, { field });
  for (const x of v)
    if (typeof x !== 'string' || !ok(x))
      throw validationError(`${field} has an invalid item`, { field, item: x });
  return v as T[];
}

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (x: string): x is T =>
    (values as readonly string[]).includes(x);
const uuid = (x: string): x is string => UUID.test(x);
const currency = (x: string): x is string => CURRENCY.test(x);

export function parseMetricQuery(body: unknown): MetricQuery {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw validationError('the body must be a MetricQuery object');
  const b = body as Record<string, unknown>;
  const known = new Set([
    'metrics',
    'dimensions',
    'grain',
    'from',
    'to',
    'filters',
    'order_by',
    'limit',
  ]);
  for (const k of Object.keys(b))
    if (!known.has(k)) throw validationError(`unknown field ${k}`, { field: k });

  const metrics = list(b.metrics, 'metrics', LIMITS.max_metrics, oneOf(METRIC_IDS));
  if (metrics.length === 0)
    throw validationError('metrics needs at least one metric', { field: 'metrics' });
  const dimensions =
    b.dimensions === undefined
      ? []
      : list(b.dimensions, 'dimensions', LIMITS.max_dimensions, oneOf(DIMENSIONS));
  if (typeof b.grain !== 'string' || !oneOf(GRAINS)(b.grain))
    throw validationError(`grain is one of ${GRAINS.join(', ')}`, { field: 'grain' });
  if (!isDay(b.from)) throw validationError('from is a YYYY-MM-DD date', { field: 'from' });
  if (!isDay(b.to)) throw validationError('to is a YYYY-MM-DD date', { field: 'to' });
  const days = (Date.parse(`${b.to}T00:00:00Z`) - Date.parse(`${b.from}T00:00:00Z`)) / 86_400_000;
  if (days <= 0) throw validationError('to must be after from', { field: 'to' });
  if (days > LIMITS.max_range_days)
    throw validationError(`[from, to) spans at most ${LIMITS.max_range_days} days`, {
      field: 'to',
    });

  // every dimension must be accepted by every requested metric
  for (const m of metrics)
    for (const d of dimensions)
      if (!METRICS[m].dimensions.includes(d))
        throw validationError(`${m} does not accept the ${d} dimension`, {
          metric: m,
          dimension: d,
        });
  // live metrics (D6) answer only per day or for the whole window
  for (const m of metrics) {
    const grains = METRICS[m].grains;
    if (grains && !grains.includes(b.grain as Grain))
      throw validationError(`${m} accepts only the grains ${grains.join(', ')}`, {
        metric: m,
        grain: b.grain,
      });
  }
  // a count without a currency next to money would put per-currency and currency-less rows in one answer
  const money = metrics.some((m) => METRICS[m].currency_bound);
  const customerCounts = metrics.filter((m) => METRICS[m].source?.id === 'customers');
  if (money && customerCounts.length > 0)
    throw validationError(
      `${customerCounts[0]} is not per currency; query it without money metrics`,
      {
        metric: customerCounts[0],
      },
    );

  const filters: MetricQuery['filters'] = {};
  if (b.filters !== undefined) {
    if (!b.filters || typeof b.filters !== 'object' || Array.isArray(b.filters))
      throw validationError('filters must be an object', { field: 'filters' });
    const f = b.filters as Record<string, unknown>;
    for (const k of Object.keys(f))
      if (!['store_ids', 'currencies', 'product_ids', 'refund_reasons'].includes(k))
        throw validationError(`unknown filter ${k}`, { field: `filters.${k}` });
    if (f.store_ids !== undefined)
      filters.store_ids = list(f.store_ids, 'filters.store_ids', LIMITS.max_store_ids, uuid).map(
        (s) => s.toLowerCase(),
      );
    if (f.currencies !== undefined)
      filters.currencies = list(
        f.currencies,
        'filters.currencies',
        LIMITS.max_currencies,
        currency,
      );
    if (f.product_ids !== undefined)
      filters.product_ids = list(
        f.product_ids,
        'filters.product_ids',
        LIMITS.max_product_ids,
        uuid,
      ).map((s) => s.toLowerCase());
    if (f.refund_reasons !== undefined)
      filters.refund_reasons = list(
        f.refund_reasons,
        'filters.refund_reasons',
        REFUND_REASONS.length,
        oneOf(REFUND_REASONS),
      );
  }

  let order_by: MetricQuery['order_by'];
  if (b.order_by !== undefined) {
    const o = b.order_by as Record<string, unknown>;
    if (
      !o ||
      typeof o !== 'object' ||
      typeof o.metric !== 'string' ||
      !metrics.includes(o.metric as MetricId)
    )
      throw validationError('order_by.metric must be one of the requested metrics', {
        field: 'order_by.metric',
      });
    const direction = o.direction ?? 'desc';
    if (direction !== 'desc' && direction !== 'asc')
      throw validationError('order_by.direction is desc or asc', { field: 'order_by.direction' });
    order_by = { metric: o.metric as MetricId, direction };
  }
  const limit = b.limit ?? LIMITS.max_rows;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.max_rows)
    throw validationError(`limit is an integer 1–${LIMITS.max_rows}`, { field: 'limit' });

  return {
    metrics,
    dimensions,
    grain: b.grain,
    from: b.from,
    to: b.to,
    filters,
    ...(order_by ? { order_by } : {}),
    limit,
  };
}
