// BI v2 wave 2 (#935 a3): the three operations next to queryMetrics.
//
//   * getCustomerCohorts — ClickHouse. A cohort = the UTC month of a customer key's first order in the store (keys are
//     per store: a customer of two brands is two customers; the key never leaves ClickHouse). Per cohort × months
//     since: the active customers, the retention (active ÷ cohort size) and the LTV to date (cumulative net sales ÷
//     cohort size), in ONE currency per answer. Small cells (#935 c): a cohort under MIN_CUSTOMERS customers is
//     suppressed whole; a cell with 1–4 active customers loses its figures.
//   * getOperationsBacklog — Postgres, now: what is stuck, by age bucket × store × warehouse: paid orders with no
//     shipment and no warehouse (`unassigned`), shipments created and not shipped, returns requested and not
//     received. Read through the caller's scoped client, narrowed to the stores the route resolved.
//   * listMetricDimensionValues — the pickers: the ids and labels the caller may filter by, from Postgres (RLS) for
//     id dimensions and from ClickHouse (the caller's stores only) for countries, carriers and utm values. A
//     promotion is matched and labelled by its NAME only, never a code; utm values follow the answer rules (PII
//     shapes are never offered).
import type { ScopedClient } from '@platform/db';
import { AppError, validationError } from '../../../lib/errors';
import { LIMITS, MIN_CUSTOMERS, type Dimension } from './catalogue';
import { utmValue, type MetricsReader } from './execute';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const unavailable = (err: unknown) =>
  new AppError('unavailable', 'Analytics store unavailable', { reason: (err as Error).name });

function ids(v: unknown, field: string, max: number): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max || new Set(v).size !== v.length)
    throw validationError(`${field} is 1–${max} distinct ids`, { field });
  for (const x of v)
    if (typeof x !== 'string' || !UUID.test(x))
      throw validationError(`${field} has an invalid id`, { field, item: x });
  return v.map((x: string) => x.toLowerCase());
}

function known(b: Record<string, unknown>, fields: readonly string[]) {
  for (const k of Object.keys(b))
    if (!fields.includes(k)) throw validationError(`unknown field ${k}`, { field: k });
}

// ---- getCustomerCohorts ------------------------------------------------------------------------------------------

export interface CohortQuery {
  store_ids?: string[];
  from_month: string;
  to_month: string;
  months: number;
  customer_group_ids?: string[];
  currency: string;
}

export interface CohortCell {
  month_offset: number;
  active: number | null;
  retention_bp: number | null;
  ltv_to_date_minor: number | null;
  suppressed: boolean;
}

export interface CustomerCohorts {
  query: CohortQuery;
  generated_at: string;
  currency: string;
  cohorts: {
    cohort_month: string;
    size: number | null;
    suppressed: boolean;
    cells: CohortCell[];
  }[];
}

const monthIndex = (m: string) => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return y * 12 + (mm - 1);
};
const monthOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

export function parseCohortQuery(body: unknown): CohortQuery {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw validationError('the body must be a CustomerCohortQuery object');
  const b = body as Record<string, unknown>;
  known(b, ['store_ids', 'from_month', 'to_month', 'months', 'customer_group_ids', 'currency']);
  for (const f of ['from_month', 'to_month'] as const)
    if (typeof b[f] !== 'string' || !MONTH.test(b[f] as string))
      throw validationError(`${f} is a YYYY-MM month`, { field: f });
  const from = monthIndex(b.from_month as string);
  const to = monthIndex(b.to_month as string);
  if (to < from)
    throw validationError('to_month must not be before from_month', { field: 'to_month' });
  if (to - from + 1 > LIMITS.max_cohorts)
    throw validationError(`at most ${LIMITS.max_cohorts} cohorts`, { field: 'to_month' });
  const months = b.months ?? 12;
  if (
    !Number.isInteger(months) ||
    (months as number) < 1 ||
    (months as number) > LIMITS.max_cohort_months
  )
    throw validationError(`months is an integer 1–${LIMITS.max_cohort_months}`, {
      field: 'months',
    });
  if (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency))
    throw validationError('currency is an ISO 4217 code (one currency per answer)', {
      field: 'currency',
    });
  return {
    ...(b.store_ids !== undefined
      ? { store_ids: ids(b.store_ids, 'store_ids', LIMITS.max_store_ids) }
      : {}),
    from_month: b.from_month as string,
    to_month: b.to_month as string,
    months: months as number,
    ...(b.customer_group_ids !== undefined
      ? {
          customer_group_ids: ids(
            b.customer_group_ids,
            'customer_group_ids',
            LIMITS.max_customer_group_ids,
          ),
        }
      : {}),
    currency: b.currency,
  };
}

/** The two statements (exported for the test: every value a parameter, the scope always bound). */
export function cohortSql(q: CohortQuery, scope: readonly string[]) {
  const cohort = `toStartOfMonth(first_order_at)`;
  const where = [
    'store_id IN {scope:Array(UUID)}',
    'customer_key IS NOT NULL',
    'currency = {currency:String}',
    `${cohort} >= toDate({from:String})`,
    `${cohort} < toDate({to:String})`,
    `dateDiff('month', ${cohort}, toStartOfMonth(placed_at)) < {months:UInt32}`,
  ];
  const params: Record<string, unknown> = {
    scope: [...scope],
    currency: q.currency,
    from: `${q.from_month}-01`,
    to: `${monthOf(monthIndex(q.to_month) + 1)}-01`,
    months: q.months,
  };
  if (q.customer_group_ids) {
    where.push('customer_group_id IN {groups:Array(UUID)}');
    params.groups = q.customer_group_ids;
  }
  // a key is per store (a customer of two brands is two customers)
  const key = `concat(toString(store_id), ':', customer_key)`;
  return {
    cells:
      `SELECT toString(${cohort}) AS out_cohort, ` +
      `toUInt32(dateDiff('month', ${cohort}, toStartOfMonth(placed_at))) AS out_offset, ` +
      `uniqExact(${key}) AS m_active, sum(net_minor) AS m_net FROM fct_order_sales WHERE ${where.join(' AND ')} ` +
      `GROUP BY out_cohort, out_offset`,
    sizes:
      `SELECT toString(${cohort}) AS out_cohort, uniqExact(${key}) AS m_size FROM fct_order_sales ` +
      `WHERE ${where.join(' AND ')} GROUP BY out_cohort`,
    params,
  };
}

const ratio = (num: number, den: number, scale = 1) =>
  den === 0 ? null : Math.round((num * scale) / den);

export async function getCustomerCohorts(
  reader: MetricsReader,
  q: CohortQuery,
  scope: readonly string[],
  now: Date = new Date(),
): Promise<CustomerCohorts> {
  const { cells, sizes, params } = cohortSql(q, scope);
  let cellRows: {
    out_cohort: string;
    out_offset: number | string;
    m_active: string | number;
    m_net: string | number;
  }[];
  let sizeRows: { out_cohort: string; m_size: string | number }[];
  try {
    [cellRows, sizeRows] = await Promise.all([
      reader
        .query({
          query: cells,
          format: 'JSONEachRow',
          query_params: params,
          use_multipart_params: true,
        })
        .then((r) => r.json<(typeof cellRows)[number]>()),
      reader
        .query({
          query: sizes,
          format: 'JSONEachRow',
          query_params: params,
          use_multipart_params: true,
        })
        .then((r) => r.json<(typeof sizeRows)[number]>()),
    ]);
  } catch (err) {
    throw unavailable(err);
  }
  const size = new Map(sizeRows.map((r) => [r.out_cohort.slice(0, 7), Number(r.m_size)]));
  const byCell = new Map(
    cellRows.map((r) => [
      `${r.out_cohort.slice(0, 7)}|${Number(r.out_offset)}`,
      { active: Number(r.m_active), net: Number(r.m_net) },
    ]),
  );
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const cohorts: CustomerCohorts['cohorts'] = [];
  for (let i = monthIndex(q.from_month); i <= monthIndex(q.to_month); i++) {
    const month = monthOf(i);
    const n = size.get(month) ?? 0;
    const small = n < MIN_CUSTOMERS;
    let cumulative = 0;
    // #951 review 3: the LTV to date is cumulative, so once a cell is hidden every LATER LTV includes that cell's net
    // and two neighbours would give it back ((ltv[k+1] − ltv[k−1]) × size). The variant chosen: the LTV row is
    // withheld from the first hidden cell on (active and retention of later cells stay: counts of ≥ 5 or 0).
    let ltvWithheld = small;
    const out: CohortCell[] = [];
    for (let k = 0; k < q.months && i + k <= current; k++) {
      const c = byCell.get(`${month}|${k}`) ?? { active: 0, net: 0 };
      cumulative += c.net;
      const hide = small || (c.active > 0 && c.active < MIN_CUSTOMERS);
      if (hide) ltvWithheld = true;
      out.push({
        month_offset: k,
        active: hide ? null : c.active,
        retention_bp: hide ? null : ratio(c.active, n, 10_000),
        ltv_to_date_minor: ltvWithheld ? null : ratio(cumulative, n),
        suppressed: hide,
      });
    }
    cohorts.push({ cohort_month: month, size: small ? null : n, suppressed: small, cells: out });
  }
  return { query: q, generated_at: now.toISOString(), currency: q.currency, cohorts };
}

// ---- getOperationsBacklog ----------------------------------------------------------------------------------------

export const BACKLOG_KINDS = ['unassigned', 'shipment_not_shipped', 'return_not_received'] as const;
export const AGE_BUCKETS = ['lt_1d', 'd1_2', 'd3_7', 'gt_7d'] as const;

export interface BacklogQuery {
  store_ids?: string[];
}

export interface OperationsBacklog {
  generated_at: string;
  buckets: readonly string[];
  rows: {
    kind: (typeof BACKLOG_KINDS)[number];
    store_id: string;
    warehouse_id: string | null;
    bucket: (typeof AGE_BUCKETS)[number];
    count: number;
  }[];
  totals: { kind: string; bucket: string; count: number }[];
}

export function parseBacklogQuery(body: unknown): BacklogQuery {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body))
    throw validationError('the body must be an OperationsBacklogQuery object');
  const b = body as Record<string, unknown>;
  known(b, ['store_ids']);
  return b.store_ids === undefined
    ? {}
    : { store_ids: ids(b.store_ids, 'store_ids', LIMITS.max_store_ids) };
}

export const BACKLOG_SQL = `
SELECT x.kind AS kind, x.store_id::text AS store_id, x.warehouse_id::text AS warehouse_id,
       CASE WHEN x.age < interval '1 day' THEN 'lt_1d'
            WHEN x.age < interval '3 days' THEN 'd1_2'
            WHEN x.age < interval '8 days' THEN 'd3_7'
            ELSE 'gt_7d' END AS bucket,
       count(*)::int AS count
FROM (
  SELECT 'unassigned' AS kind, o.store_id, NULL::uuid AS warehouse_id, $2::timestamptz - o.placed_at AS age
  FROM "order" o
  WHERE o.store_id = ANY($1::uuid[]) AND o.status <> 'cancelled'
    AND o.payment_status IN ('authorized', 'captured', 'partially_refunded')
    AND NOT EXISTS (SELECT 1 FROM shipment s WHERE s.order_id = o.id AND s.status <> 'cancelled')
  UNION ALL
  SELECT 'shipment_not_shipped', s.store_id, s.warehouse_id, $2::timestamptz - s.created_at
  FROM shipment s
  WHERE s.store_id = ANY($1::uuid[]) AND s.status IN ('pending', 'picking', 'packed', 'label_created')
  UNION ALL
  SELECT 'return_not_received', r.store_id, r.warehouse_id, $2::timestamptz - r.requested_at
  FROM "return" r
  WHERE r.store_id = ANY($1::uuid[]) AND r.status IN ('requested', 'approved')
) x
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4`;

export async function getOperationsBacklog(
  pg: Pick<ScopedClient, 'query'>,
  stores: readonly string[],
  now: Date = new Date(),
): Promise<OperationsBacklog> {
  const r = await pg.query<OperationsBacklog['rows'][number]>(BACKLOG_SQL, [
    [...stores],
    now.toISOString(),
  ]);
  const totals = new Map<string, number>();
  for (const row of r.rows)
    totals.set(
      `${row.kind}|${row.bucket}`,
      (totals.get(`${row.kind}|${row.bucket}`) ?? 0) + row.count,
    );
  return {
    generated_at: now.toISOString(),
    buckets: AGE_BUCKETS,
    rows: r.rows,
    totals: [...totals].map(([k, count]) => {
      const [kind, bucket] = k.split('|') as [string, string];
      return { kind, bucket, count };
    }),
  };
}

// ---- listMetricDimensionValues -------------------------------------------------------------------------------------

export const PICKER_DIMENSIONS = [
  'store',
  'country',
  'sales_channel',
  'category',
  'product',
  'warehouse',
  'customer_group',
  'campaign',
  'promotion',
  'carrier',
  'utm_source',
  'utm_medium',
  'utm_campaign',
] as const satisfies readonly Dimension[];
export type PickerDimension = (typeof PICKER_DIMENSIONS)[number];

export interface DimensionValuesQuery {
  dimension: PickerDimension;
  q?: string;
  store_ids?: string[];
  limit: number;
}

export function parseDimensionValuesQuery(query: Record<string, unknown>): DimensionValuesQuery {
  known(query, ['dimension', 'q', 'store_ids', 'limit']);
  const d = query.dimension;
  if (typeof d !== 'string' || !(PICKER_DIMENSIONS as readonly string[]).includes(d))
    throw validationError(`dimension is one of ${PICKER_DIMENSIONS.join(', ')}`, {
      field: 'dimension',
    });
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 80))
    throw validationError('q is at most 80 characters', { field: 'q' });
  const raw = query.store_ids;
  const list =
    raw === undefined
      ? undefined
      : Array.isArray(raw)
        ? raw
        : String(raw).split(',').filter(Boolean);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.max_dimension_values)
    throw validationError(`limit is an integer 1–${LIMITS.max_dimension_values}`, {
      field: 'limit',
    });
  return {
    dimension: d as PickerDimension,
    ...(typeof query.q === 'string' && query.q.trim() !== '' ? { q: query.q.trim() } : {}),
    ...(list ? { store_ids: ids(list, 'store_ids', LIMITS.max_store_ids) } : {}),
    limit,
  };
}

/** Postgres pickers: id + label; `$1` the stores, `$2` the search (NULL for none, LIKE-escaped), `$3` the limit. */
const PG_PICKERS: Partial<Record<PickerDimension, string>> = {
  store: `SELECT id::text AS vid, name AS label FROM store WHERE id = ANY($1::uuid[])`,
  sales_channel: `SELECT id::text AS vid, name AS label FROM sales_channel WHERE store_id = ANY($1::uuid[])`,
  category: `SELECT id::text AS vid, name AS label FROM product_category WHERE store_id = ANY($1::uuid[])`,
  product: `SELECT id::text AS vid, title AS label FROM product WHERE store_id = ANY($1::uuid[])`,
  // warehouses belong to the organization: RLS decides which the caller sees
  warehouse: `SELECT id::text AS vid, code AS label FROM warehouse WHERE $1::uuid[] IS NOT NULL`,
  customer_group: `SELECT id::text AS vid, name AS label FROM customer_group WHERE store_id = ANY($1::uuid[])`,
  campaign: `SELECT id::text AS vid, name AS label FROM campaign WHERE store_id = ANY($1::uuid[])`,
  // by NAME only: a code is never matched, never returned
  promotion: `SELECT id::text AS vid, name AS label FROM promotion WHERE store_id = ANY($1::uuid[])`,
};

/** ClickHouse pickers: the distinct values in the caller's stores (no id: the value is its own label). */
const CH_PICKERS: Partial<Record<PickerDimension, string>> = {
  country: `SELECT country AS v, count() AS n FROM fct_order WHERE store_id IN {scope:Array(UUID)} AND country != '' GROUP BY v`,
  carrier: `SELECT toString(carrier) AS v, count() AS n FROM fct_shipment WHERE store_id IN {scope:Array(UUID)} AND carrier != '' GROUP BY v`,
  utm_source: `SELECT utm_source AS v, count() AS n FROM stg_attribution_v1 WHERE store_id IN {scope:Array(UUID)} AND utm_source IS NOT NULL GROUP BY v`,
  utm_medium: `SELECT utm_medium AS v, count() AS n FROM stg_attribution_v1 WHERE store_id IN {scope:Array(UUID)} AND utm_medium IS NOT NULL GROUP BY v`,
  utm_campaign: `SELECT utm_campaign AS v, count() AS n FROM stg_attribution_v1 WHERE store_id IN {scope:Array(UUID)} AND utm_campaign IS NOT NULL GROUP BY v`,
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listMetricDimensionValues(
  deps: { pg: Pick<ScopedClient, 'query'>; reader: MetricsReader },
  q: DimensionValuesQuery,
  stores: readonly string[],
): Promise<{ dimension: PickerDimension; values: { id: string; label: string }[] }> {
  const pgSql = PG_PICKERS[q.dimension];
  if (pgSql) {
    const r = await deps.pg.query<{ id: string; label: string }>(
      `SELECT vid AS id, label FROM (${pgSql}) v WHERE ($2::text IS NULL OR label ILIKE '%' || $2 || '%') ORDER BY label, vid LIMIT $3`,
      [[...stores], q.q === undefined ? null : likeEscape(q.q), q.limit],
    );
    return { dimension: q.dimension, values: r.rows };
  }
  let rows: { v: string; n: string | number }[];
  try {
    rows = await (
      await deps.reader.query({
        query: CH_PICKERS[q.dimension]!,
        format: 'JSONEachRow',
        query_params: { scope: [...stores] },
        use_multipart_params: true,
      })
    ).json();
  } catch (err) {
    throw unavailable(err);
  }
  const utm = q.dimension.startsWith('utm_');
  const needle = q.q?.toLowerCase();
  const values = rows
    // utm: PII-shaped values are never offered, and only a store's top values are (decision 5)
    .filter((r) => !utm || utmValue(r.v) !== 'other')
    .sort((a, b) => Number(b.n) - Number(a.n) || (a.v < b.v ? -1 : 1))
    .slice(0, utm ? LIMITS.utm_top : undefined)
    .filter((r) => needle === undefined || r.v.toLowerCase().includes(needle))
    .slice(0, q.limit)
    .map((r) => ({ id: r.v, label: r.v }));
  return { dimension: q.dimension, values };
}
