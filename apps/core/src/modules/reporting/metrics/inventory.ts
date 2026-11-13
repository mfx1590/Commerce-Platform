// `getInventoryHealth` (BI v2, #871 a1/a3; the owner's question: "how is our availability, do we need to order
// anything?"). One row per STOCK ITEM; its warehouses are a breakdown.
//
//   * The POSITION (on hand, reserved, available, incoming per stock item × warehouse) is read NOW from Postgres
//     (rpt_stock_position) under the caller's scope: reservations are not stock movements, so the analytics store
//     never knows the current reserved figure (decision 2).
//   * The SALES RATE is read from the analytics store: units on orders that are not cancelled, by the UTC day the
//     order was placed, over the `velocity_days` FULL days before today (today is excluded so the figure does not move
//     during the day), returns not netted, only the stores the rate may count. Days out of stock are not removed, so
//     the rate understates demand after a stock-out: `rate_understated`.
//   * Cover, status and the suggestion are the ITEM's, over its included warehouses (summed available) — never per
//     warehouse with the item's whole rate (#871 review 2).
//   * stock_out = available ≤ 0 whether or not anything sold (review 3): a long stock-out never falls to `ok`, and its
//     suggestion is at least max(0, −available).
//   * `incoming` is not tracked yet (#878): it is 0 because nothing records supplier orders, not because nothing is on
//     order. `incoming_tracked: false` makes the page say so.
//   * Parameters: the request, else the largest setting among the item's CALLER-VISIBLE stores
//     (`settings.analytics.inventory.*`, #871 a4), else the platform default.
//   * A store caller sees the stock items its stores map; on a `shared` item (a store outside its scope sells from it)
//     the position is the pool's, the rate its own stores', and the suggestion is `suggestion_partial`.
//   * With the analytics store down the answer is still 200 from the position alone: `rate_available: false`.
import type { ScopedClient } from '@platform/db';
import { validationError } from '../../../lib/errors';
import { INVENTORY_DEFAULTS, LIMITS } from './catalogue';
import type { MetricsReader } from './execute';

export const INVENTORY_STATUSES = [
  'stock_out',
  'low',
  'reorder',
  'dead',
  'overstock',
  'ok',
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];
type Params = {
  velocity_days: number;
  lead_time_days: number;
  cover_days: number;
  dead_days: number;
};
type ParamKey = keyof Params;
const PARAM_KEYS: readonly ParamKey[] = [
  'velocity_days',
  'lead_time_days',
  'cover_days',
  'dead_days',
];
const RANGES: Readonly<Record<ParamKey, [number, number]>> = {
  velocity_days: [7, 90],
  lead_time_days: [0, 180],
  cover_days: [0, 180],
  dead_days: [14, 365],
};
const SORTS = [
  'days_of_cover',
  'suggested_reorder_units',
  'available',
  'units_sold_per_day_milli',
  'sku',
] as const;

export interface InventoryQuery {
  store_ids?: string[];
  warehouse_ids?: string[];
  category_ids?: string[];
  product_ids?: string[];
  status?: InventoryStatus[];
  q?: string;
  velocity_days?: number;
  lead_time_days?: number;
  cover_days?: number;
  dead_days?: number;
  sort: (typeof SORTS)[number];
  direction: 'asc' | 'desc';
  page: number;
  limit: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuids(v: unknown, field: string, max: number): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max || new Set(v).size !== v.length)
    throw validationError(`${field} is a list of 1–${max} distinct ids`, { field });
  for (const x of v)
    if (typeof x !== 'string' || !UUID.test(x))
      throw validationError(`${field} has an invalid id`, { field });
  return (v as string[]).map((s) => s.toLowerCase());
}

export function parseInventoryQuery(body: unknown): InventoryQuery {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b !== 'object' || Array.isArray(b))
    throw validationError('the body must be an object');
  const known = new Set([
    'store_ids',
    'warehouse_ids',
    'category_ids',
    'product_ids',
    'status',
    'q',
    ...PARAM_KEYS,
    'sort',
    'direction',
    'page',
    'limit',
  ]);
  for (const k of Object.keys(b))
    if (!known.has(k)) throw validationError(`unknown field ${k}`, { field: k });
  const out: InventoryQuery = { sort: 'days_of_cover', direction: 'asc', page: 1, limit: 100 };
  if (b.store_ids !== undefined)
    out.store_ids = uuids(b.store_ids, 'store_ids', LIMITS.max_store_ids);
  if (b.warehouse_ids !== undefined)
    out.warehouse_ids = uuids(b.warehouse_ids, 'warehouse_ids', LIMITS.max_warehouse_ids);
  if (b.category_ids !== undefined)
    out.category_ids = uuids(b.category_ids, 'category_ids', LIMITS.max_category_ids);
  if (b.product_ids !== undefined)
    out.product_ids = uuids(b.product_ids, 'product_ids', LIMITS.max_product_ids);
  if (b.status !== undefined) {
    if (
      !Array.isArray(b.status) ||
      b.status.length < 1 ||
      new Set(b.status).size !== b.status.length ||
      !b.status.every((s) => (INVENTORY_STATUSES as readonly unknown[]).includes(s))
    )
      throw validationError(`status is a list of ${INVENTORY_STATUSES.join(', ')}`, {
        field: 'status',
      });
    out.status = b.status as InventoryStatus[];
  }
  if (b.q !== undefined) {
    if (typeof b.q !== 'string' || b.q.length > 100)
      throw validationError('q is a string of at most 100', { field: 'q' });
    out.q = b.q;
  }
  for (const k of PARAM_KEYS)
    if (b[k] !== undefined) {
      const [lo, hi] = RANGES[k];
      if (!Number.isInteger(b[k]) || (b[k] as number) < lo || (b[k] as number) > hi)
        throw validationError(`${k} is an integer ${lo}–${hi}`, { field: k });
      out[k] = b[k] as number;
    }
  if (b.sort !== undefined) {
    if (!(SORTS as readonly unknown[]).includes(b.sort))
      throw validationError(`sort is one of ${SORTS.join(', ')}`, { field: 'sort' });
    out.sort = b.sort as InventoryQuery['sort'];
  }
  if (b.direction !== undefined) {
    if (b.direction !== 'asc' && b.direction !== 'desc')
      throw validationError('direction is asc or desc', { field: 'direction' });
    out.direction = b.direction;
  }
  if (b.page !== undefined) {
    if (!Number.isInteger(b.page) || (b.page as number) < 1)
      throw validationError('page is an integer ≥ 1', { field: 'page' });
    out.page = b.page as number;
  }
  if (b.limit !== undefined) {
    if (
      !Number.isInteger(b.limit) ||
      (b.limit as number) < 1 ||
      (b.limit as number) > LIMITS.max_inventory_rows
    )
      throw validationError(`limit is an integer 1–${LIMITS.max_inventory_rows}`, {
        field: 'limit',
      });
    out.limit = b.limit as number;
  }
  return out;
}

// ---- the inputs (loaded by loadInventoryInputs, or given by a test) ------------------------------------------------

export interface PositionRow {
  stock_item_id: string;
  sku: string;
  name: string;
  warehouse_id: string;
  warehouse_code: string;
  on_hand: number;
  reserved: number;
  available: number;
  incoming: number;
}

export interface MappingRow {
  stock_item_id: string;
  variant_id: string;
  store_id: string;
  product_id: string;
  category_id: string | null;
}

export interface InventoryInputs {
  positions: PositionRow[];
  /** caller-visible variants → stock items (already narrowed to the queried stores) */
  mappings: MappingRow[];
  /** items a store outside the caller's scope also sells from (store callers only) */
  shared: ReadonlySet<string>;
  /** `settings.analytics.inventory` per caller-visible store */
  settings: ReadonlyMap<string, Partial<Params>>;
  /** the rate inputs; null when the analytics store could not be read */
  sales: {
    /** units per variant per UTC day (YYYY-MM-DD), the last 90 full days, the rate's stores only */
    byDay: { variant_id: string; day: string; units: number }[];
    /** last sale per variant (ISO), any time, the rate's stores only */
    lastSale: ReadonlyMap<string, string>;
    /** days a stock item stocked out (YYYY-MM-DD), the last 90 days */
    stockoutDays: ReadonlyMap<string, readonly string[]>;
    /** last receipt per `item|warehouse` (ISO) */
    lastReceipt: ReadonlyMap<string, string>;
    data_as_of: string | null;
  } | null;
}

export interface InventoryRow {
  stock_item_id: string;
  sku: string;
  name: string;
  store_ids: string[];
  shared: boolean;
  warehouses: {
    warehouse_id: string;
    warehouse_code: string;
    on_hand: number;
    reserved: number;
    available: number;
    incoming: number;
    last_receipt_at: string | null;
  }[];
  on_hand: number;
  reserved: number;
  available: number;
  incoming: number;
  units_sold: number | null;
  units_sold_per_day_milli: number | null;
  rate_understated: boolean | null;
  days_of_cover: number | null;
  last_sale_at: string | null;
  last_receipt_at: string | null;
  status: InventoryStatus | null;
  suggested_reorder_units: number | null;
  suggestion_partial: boolean;
  parameters: Params;
  parameters_source: 'request' | 'store' | 'default';
}

export interface InventoryHealth {
  query: InventoryQuery;
  generated_at: string;
  position_as_of: string;
  data_as_of: string | null;
  rate_available: boolean;
  incoming_tracked: boolean;
  parameters: Record<ParamKey, number | null>;
  summary: Partial<Record<InventoryStatus, number>>;
  total: number;
  rows: InventoryRow[];
}

const DAY_MS = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const shift = (day: string, n: number) =>
  dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));

/** The whole computation, pure: what the owner reads, from the position, the mappings and the sales. */
export function computeInventoryHealth(
  inputs: InventoryInputs,
  q: InventoryQuery,
  opts: { organization: boolean; now: Date },
): InventoryHealth {
  const today = dayOf(opts.now);
  const rateOk = inputs.sales !== null;
  const variantsOf = new Map<string, MappingRow[]>();
  for (const m of inputs.mappings)
    variantsOf.set(m.stock_item_id, [...(variantsOf.get(m.stock_item_id) ?? []), m]);
  const unitsByVariantDay = new Map<string, Map<string, number>>();
  for (const s of inputs.sales?.byDay ?? []) {
    const m = unitsByVariantDay.get(s.variant_id) ?? new Map<string, number>();
    m.set(s.day, (m.get(s.day) ?? 0) + s.units);
    unitsByVariantDay.set(s.variant_id, m);
  }
  const positions = new Map<string, PositionRow[]>();
  for (const p of inputs.positions)
    if (!q.warehouse_ids || q.warehouse_ids.includes(p.warehouse_id))
      positions.set(p.stock_item_id, [...(positions.get(p.stock_item_id) ?? []), p]);
  const needle = q.q?.toLowerCase();

  const rows: InventoryRow[] = [];
  for (const [item, whs] of positions) {
    const maps = variantsOf.get(item) ?? [];
    // an item none of the (queried) stores sells from is an organization-only pool row
    if (maps.length === 0 && (!opts.organization || q.store_ids)) continue;
    if (q.product_ids && !maps.some((m) => q.product_ids!.includes(m.product_id))) continue;
    if (
      q.category_ids &&
      !maps.some((m) => m.category_id && q.category_ids!.includes(m.category_id))
    )
      continue;
    const first = whs[0]!;
    if (
      needle &&
      !first.sku.toLowerCase().includes(needle) &&
      !first.name.toLowerCase().includes(needle)
    )
      continue;
    const stores = [...new Set(maps.map((m) => m.store_id))].sort();

    // parameters: request > the largest among the item's caller-visible stores' settings > default
    const parameters = {} as Params;
    let fromRequest = 0;
    let fromStore = 0;
    for (const k of PARAM_KEYS) {
      if (q[k] !== undefined) {
        parameters[k] = q[k]!;
        fromRequest += 1;
        continue;
      }
      const set = stores
        .map((s) => inputs.settings.get(s)?.[k])
        .filter((v): v is number => v !== undefined);
      if (set.length > 0) {
        parameters[k] = Math.max(...set);
        fromStore += 1;
      } else parameters[k] = INVENTORY_DEFAULTS[k];
    }
    const source =
      fromRequest === PARAM_KEYS.length ? 'request' : fromStore > 0 ? 'store' : 'default';

    const on_hand = whs.reduce((n, w) => n + w.on_hand, 0);
    const reserved = whs.reduce((n, w) => n + w.reserved, 0);
    const available = whs.reduce((n, w) => n + w.available, 0);
    const incoming = whs.reduce((n, w) => n + w.incoming, 0);
    const lastReceipts = whs.map(
      (w) => inputs.sales?.lastReceipt.get(`${item}|${w.warehouse_id}`) ?? null,
    );

    let units: number | null = null;
    let rateMilli: number | null = null;
    let cover: number | null = null;
    let understated: boolean | null = null;
    let lastSale: string | null = null;
    let suggestion: number | null = null;
    let status: InventoryStatus | null = available <= 0 ? 'stock_out' : null;
    if (rateOk) {
      const from = shift(today, -parameters.velocity_days);
      units = 0;
      for (const m of maps)
        for (const [day, u] of unitsByVariantDay.get(m.variant_id) ?? [])
          if (day >= from && day < today) units += u;
      rateMilli = Math.floor((units * 1000) / parameters.velocity_days);
      cover =
        available <= 0
          ? 0
          : units > 0
            ? Math.floor((available * parameters.velocity_days) / units)
            : null;
      understated =
        available <= 0 ||
        (inputs.sales!.stockoutDays.get(item) ?? []).some((d) => d >= from && d < today);
      for (const m of maps) {
        const t = inputs.sales!.lastSale.get(m.variant_id);
        if (t && (lastSale === null || t > lastSale)) lastSale = t;
      }
      const horizon = parameters.lead_time_days + parameters.cover_days;
      const need = Math.ceil((units * horizon) / parameters.velocity_days);
      suggestion = Math.max(0, need - available - incoming);
      const dead =
        on_hand > 0 &&
        (lastSale === null || lastSale.slice(0, 10) < shift(today, -parameters.dead_days));
      if (available <= 0) status = 'stock_out';
      else if (cover !== null && cover < parameters.lead_time_days) status = 'low';
      else if (cover !== null && cover < horizon) status = 'reorder';
      else if (dead) status = 'dead';
      else if (cover !== null && cover > 3 * horizon) status = 'overstock';
      else status = 'ok';
    }
    rows.push({
      stock_item_id: item,
      sku: first.sku,
      name: first.name,
      store_ids: stores,
      shared: inputs.shared.has(item),
      warehouses: whs
        .map((w, i) => ({
          warehouse_id: w.warehouse_id,
          warehouse_code: w.warehouse_code,
          on_hand: w.on_hand,
          reserved: w.reserved,
          available: w.available,
          incoming: w.incoming,
          last_receipt_at: lastReceipts[i]!,
        }))
        .sort((a, b) => a.warehouse_code.localeCompare(b.warehouse_code)),
      on_hand,
      reserved,
      available,
      incoming,
      units_sold: units,
      units_sold_per_day_milli: rateMilli,
      rate_understated: understated,
      days_of_cover: cover,
      last_sale_at: lastSale,
      last_receipt_at: lastReceipts.reduce<string | null>(
        (a, b) => (b !== null && (a === null || b > a) ? b : a),
        null,
      ),
      status,
      suggested_reorder_units: suggestion,
      suggestion_partial: !opts.organization && inputs.shared.has(item),
      parameters,
      parameters_source: source,
    });
  }

  // the counts per status cover every filter but `status` itself (the chips show what each would give)
  const summary: Partial<Record<InventoryStatus, number>> = {};
  for (const r of rows) if (r.status) summary[r.status] = (summary[r.status] ?? 0) + 1;
  const kept = q.status
    ? rows.filter((r) => r.status !== null && q.status!.includes(r.status))
    : rows;
  const sign = q.direction === 'asc' ? 1 : -1;
  const value = (r: InventoryRow): number | string | null =>
    q.sort === 'sku'
      ? r.sku
      : q.sort === 'available'
        ? r.available
        : q.sort === 'days_of_cover'
          ? r.days_of_cover
          : q.sort === 'suggested_reorder_units'
            ? r.suggested_reorder_units
            : r.units_sold_per_day_milli;
  kept.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === y) return a.sku.localeCompare(b.sku);
    if (x === null) return 1; // empty last either way
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sign;
  });
  const start = (q.page - 1) * q.limit;
  return {
    query: q,
    generated_at: opts.now.toISOString(),
    position_as_of: opts.now.toISOString(),
    data_as_of: inputs.sales?.data_as_of ?? null,
    rate_available: rateOk,
    incoming_tracked: false,
    parameters: {
      velocity_days: q.velocity_days ?? null,
      lead_time_days: q.lead_time_days ?? null,
      cover_days: q.cover_days ?? null,
      dead_days: q.dead_days ?? null,
    },
    summary,
    total: kept.length,
    rows: kept.slice(start, start + q.limit),
  };
}

// ---- the loader: Postgres (position, mappings, settings) + ClickHouse (sales, stock-outs, receipts) -----------------

export interface InventoryLoadDeps {
  /** the caller's scoped client (RLS) */
  pg: Pick<ScopedClient, 'query'>;
  /**
   * An organization-level read used for ONE fact only, for store callers: which visible items another store also
   * sells from (a boolean per item; never which store). Omitted for organization callers.
   */
  orgPg?: Pick<ScopedClient, 'query'>;
  reader: MetricsReader;
  /** the stores whose variants count (caller-visible, narrowed by store_ids) */
  stores: readonly string[];
  /** the stores whose sales count toward the rate (= stores, minus BI Q&A-excluded ones on the Ask path) */
  rateStores: readonly string[];
  organization: boolean;
  now: Date;
}

const LOOKBACK_DAYS = 90; // the largest velocity window

export async function loadInventoryInputs(
  d: InventoryLoadDeps,
  q: InventoryQuery,
): Promise<InventoryInputs> {
  const fence =
    d.organization && !q.store_ids
      ? ''
      : 'WHERE EXISTS (SELECT 1 FROM product_variant v WHERE v.store_id = ANY($1::uuid[]) AND v.stock_item_id = s.stock_item_id)';
  const [positions, mappings, settings] = await Promise.all([
    d.pg.query<PositionRow>(
      `SELECT s.stock_item_id::text AS stock_item_id, s.sku, si.name, s.warehouse_id::text AS warehouse_id,
              s.warehouse_code, s.on_hand, s.reserved, s.available, s.incoming
         FROM rpt_stock_position s JOIN stock_item si ON si.id = s.stock_item_id ${fence}`,
      fence ? [[...d.stores]] : [],
    ),
    d.pg.query<MappingRow>(
      `SELECT v.stock_item_id::text AS stock_item_id, v.id::text AS variant_id, v.store_id::text AS store_id,
              v.product_id::text AS product_id, p.category_id::text AS category_id
         FROM product_variant v JOIN product p ON p.id = v.product_id
        WHERE v.store_id = ANY($1::uuid[])`,
      [[...d.stores]],
    ),
    d.pg.query<{ id: string; inv: Partial<Params> | null }>(
      `SELECT id::text AS id, settings -> 'analytics' -> 'inventory' AS inv FROM store WHERE id = ANY($1::uuid[])`,
      [[...d.stores]],
    ),
  ]);
  const num = (r: Record<string, unknown>, k: string) => Number(r[k]);
  const pos = positions.rows.map((r) => ({
    ...r,
    on_hand: num(r as never, 'on_hand'),
    reserved: num(r as never, 'reserved'),
    available: num(r as never, 'available'),
    incoming: num(r as never, 'incoming'),
  }));
  const items = [...new Set(pos.map((p) => p.stock_item_id))];
  let shared = new Set<string>();
  if (!d.organization && d.orgPg && items.length > 0) {
    const r = await d.orgPg.query<{ stock_item_id: string }>(
      `SELECT DISTINCT stock_item_id::text AS stock_item_id FROM product_variant
        WHERE stock_item_id = ANY($1::uuid[]) AND NOT (store_id = ANY($2::uuid[]))`,
      [items, [...d.stores]],
    );
    shared = new Set(r.rows.map((x) => x.stock_item_id));
  }
  const settingsMap = new Map<string, Partial<Params>>();
  for (const s of settings.rows) {
    const v: Partial<Params> = {};
    for (const k of PARAM_KEYS) {
      const x = s.inv?.[k];
      if (Number.isInteger(x) && (x as number) >= RANGES[k][0] && (x as number) <= RANGES[k][1])
        v[k] = x as number;
    }
    settingsMap.set(s.id, v);
  }

  let sales: InventoryInputs['sales'] = null;
  if (d.rateStores.length > 0 || items.length > 0)
    try {
      const today = dayOf(d.now);
      const run = async <T>(query: string, params: Record<string, unknown>) =>
        (await d.reader.query({ query, format: 'JSONEachRow', query_params: params })).json<T>();
      const stores =
        d.rateStores.length > 0 ? [...d.rateStores] : ['00000000-0000-0000-0000-000000000000'];
      const [byDay, last, stock, asOf] = await Promise.all([
        run<{ v: string; d: string; u: string }>(
          `SELECT toString(variant_id) AS v, toString(toDate(placed_at, 'UTC')) AS d, sum(quantity) AS u
             FROM fct_order_line
            WHERE order_status != 'cancelled' AND variant_id IS NOT NULL AND store_id IN {stores:Array(UUID)}
              AND toDate(placed_at, 'UTC') >= {from:Date} AND toDate(placed_at, 'UTC') < {today:Date}
            GROUP BY v, d`,
          { stores, from: shift(today, -LOOKBACK_DAYS), today },
        ),
        run<{ v: string; t: string }>(
          `SELECT toString(variant_id) AS v, toString(max(placed_at)) AS t FROM fct_order_line
            WHERE order_status != 'cancelled' AND variant_id IS NOT NULL AND store_id IN {stores:Array(UUID)}
            GROUP BY v`,
          { stores },
        ),
        items.length === 0
          ? Promise.resolve([] as { i: string; w: string; d: string; s: string; r: string }[])
          : run<{ i: string; w: string; d: string; s: string; r: string }>(
              `SELECT toString(stock_item_id) AS i, toString(warehouse_id) AS w, toString(day) AS d,
                      sum(stockout_events) AS s, sum(units_received) AS r
                 FROM mart_stock_daily
                WHERE stock_item_id IN {items:Array(UUID)} AND (stockout_events > 0 OR units_received > 0)
                GROUP BY i, w, d`,
              { items },
            ),
        run<{ t: string | null }>(
          'SELECT if(count() = 0, NULL, toString(max(ingested_at))) AS t FROM raw_events',
          {},
        ),
      ]);
      const iso = (t: string) => `${t.replace(' ', 'T')}Z`;
      const stockoutDays = new Map<string, string[]>();
      const lastReceipt = new Map<string, string>();
      for (const r of stock) {
        if (Number(r.s) > 0) stockoutDays.set(r.i, [...(stockoutDays.get(r.i) ?? []), r.d]);
        if (Number(r.r) > 0) {
          const k = `${r.i}|${r.w}`;
          const t = `${r.d}T00:00:00.000Z`;
          if (!lastReceipt.has(k) || t > lastReceipt.get(k)!) lastReceipt.set(k, t);
        }
      }
      sales = {
        byDay:
          d.rateStores.length > 0
            ? byDay.map((r) => ({ variant_id: r.v, day: r.d, units: Number(r.u) }))
            : [],
        lastSale: new Map(d.rateStores.length > 0 ? last.map((r) => [r.v, iso(r.t)]) : []),
        stockoutDays,
        lastReceipt,
        data_as_of: asOf[0]?.t ? iso(asOf[0].t) : null,
      };
    } catch {
      sales = null; // the analytics store is unavailable: the position is still the answer (rate_available false)
    }
  return { positions: pos, mappings: mappings.rows, shared, settings: settingsMap, sales };
}
