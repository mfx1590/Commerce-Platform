// BI Q&A's one tool, `query_metrics` (#606, D4/D9): the model chooses metric × dimensions × filters × grain from
// the typed catalogue, and the SERVER validates, scopes and runs it with exactly the functions `queryMetrics` uses
// (parseMetricQuery → scopeForQuery → executeMetricQuery). No SQL exists on this path. The schema the model sees is
// narrowed to the caller (their metrics, their stores), but the narrowing is only a hint: every call is checked
// again here, so a call outside the scope is a tool error and never reaches the analytics store.
//
// BI v2 (#871 e) adds two closed tools on the same rules — `movers` (= listMetricMovers) and `inventory_health`
// (= getInventoryHealth) — and ALIASES: every id the model reads is an alias stable for the whole question (p1… products,
// c1… categories, ch1… sales channels, w1… warehouses, i1… stock items; stores by code). The model never receives a
// product or category title (untrusted text stays out of the prompt); the server substitutes the aliases in the final
// answer with their names (substituteAliases), and the answer carries the legend.
import { AppError } from '../../../lib/errors';
import {
  CUSTOMER_TYPES,
  DIMENSIONS,
  GRAINS,
  isAdditive,
  LIMITS,
  METRIC_IDS,
  METRICS,
  REFUND_REASONS,
  TOUCHES,
  type MetricId,
} from '../metrics/catalogue';
import type { StockScope } from '../metrics/compile';
import {
  type PostgresSourceLoader,
  executeMetricQuery,
  type MetricLabels,
  type MetricResult,
  type MetricsReader,
} from '../metrics/execute';
import {
  INVENTORY_STATUSES,
  parseInventoryQuery,
  type InventoryHealth,
  type InventoryQuery,
} from '../metrics/inventory';
import {
  MOVER_DIMENSIONS,
  moversFromResult,
  moversMetricQuery,
  parseMoversQuery,
} from '../metrics/movers';
import {
  parseCohortQuery,
  type CohortQuery,
  type CustomerCohorts,
  type OperationsBacklog,
} from '../metrics/operations';
import { COMPARE_MODES, parseMetricQuery, type MetricQuery } from '../metrics/query';
import { scopeForQuery, type MetricsCaller } from '../metrics/scope';
import type { AiTool, AiToolCall, AiToolResult, JsonSchemaObject } from './gateway';

export const QUERY_METRICS_TOOL = 'query_metrics';
export const MOVERS_TOOL = 'movers';
export const INVENTORY_TOOL = 'inventory_health';
// BI v2 wave 2 (#935 e): two closed tools over the new operations
export const COHORTS_TOOL = 'customer_cohorts';
export const BACKLOG_TOOL = 'operations_backlog';

/** The id → alias registry of ONE question (every tool call shares it, so an alias means one thing in the answer). */
export class Aliases {
  private readonly byKind = new Map<string, Map<string, string>>();
  /** alias → the id and its kind, for the substitution */
  readonly reverse = new Map<string, { kind: AliasKind; id: string }>();
  /** names already known without a lookup (stock items carry their name) */
  readonly known = new Map<string, string>();
  of(kind: AliasKind, id: string | null): string | null {
    if (id === null) return null;
    const m = this.byKind.get(kind) ?? new Map<string, string>();
    this.byKind.set(kind, m);
    let a = m.get(id);
    if (!a) {
      a = `${ALIAS_PREFIX[kind]}${m.size + 1}`;
      m.set(id, a);
      this.reverse.set(a, { kind, id });
    }
    return a;
  }
}
export type AliasKind =
  | 'product'
  | 'category'
  | 'sales_channel'
  | 'warehouse'
  | 'item'
  // BI v2 wave 2 (#935 e): groups, campaigns and promotions are ids; a utm value is link text, never shown to the model
  | 'customer_group'
  | 'campaign'
  | 'promotion'
  | 'utm';
const ALIAS_PREFIX: Readonly<Record<AliasKind, string>> = {
  product: 'p',
  category: 'c',
  sales_channel: 'ch',
  warehouse: 'w',
  item: 'i',
  customer_group: 'g',
  campaign: 'cp',
  promotion: 'pr',
  utm: 'u',
};

/** One inventory_health call: its ref (h1, h2 …), the query and the answer. */
export interface ExecutedInventory {
  ref: string;
  query: InventoryQuery;
  result?: InventoryHealth;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** Rows sent back to the model per call (the full, capped result still goes to the caller). Bounds tokens. */
export const MODEL_ROWS = 200;

/** One call the model made that parsed as a MetricQuery: its result, or why it was refused. */
export interface ExecutedQuery {
  /** `q1`, `q2` … in order: the model cites these; 1-based into the answer's `queries`. */
  ref: string;
  query: MetricQuery;
  result?: MetricResult;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface ToolScope {
  /** the stores this question may read (in scope AND with BI Q&A on), with their codes */
  stores: readonly { id: string; code: string }[];
  finance: boolean;
  window: { from: string; to: string };
}

/** The `query_metrics` tool, narrowed to the caller: their metrics and their stores only. */
export function queryMetricsTool(scope: ToolScope): AiTool {
  // snapshot metrics (stock now) are inventory_health's (#871): queryMetrics refuses them
  const metrics = METRIC_IDS.filter(
    (m) => (scope.finance || !METRICS[m].finance) && METRICS[m].kind !== 'snapshot',
  );
  const ids = scope.stores.map((s) => s.id);
  const inputSchema: JsonSchemaObject = {
    type: 'object',
    additionalProperties: false,
    required: ['metrics', 'dimensions', 'grain', 'from', 'to'],
    properties: {
      metrics: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.max_metrics,
        uniqueItems: true,
        items: { type: 'string', enum: metrics },
      },
      dimensions: {
        type: 'array',
        maxItems: LIMITS.max_dimensions,
        uniqueItems: true,
        items: { type: 'string', enum: [...DIMENSIONS] },
        description:
          'One row per value of each: product = one row per product (the way to rank products); products, categories, channels, warehouses, customer groups, campaigns, promotions and utm values come back as aliases (p1, c1, ch1, w1, g1, cp1, pr1, u1) — write the alias, the server puts the name in; a filter may name an alias an earlier result of this question returned',
      },
      grain: { type: 'string', enum: [...GRAINS] },
      from: { type: 'string', format: 'date', description: 'UTC date, inclusive' },
      to: {
        type: 'string',
        format: 'date',
        description: `UTC date, exclusive; at most ${LIMITS.max_range_days} days after from`,
      },
      filters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          store_ids: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', enum: ids },
          },
          currencies: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
          // #935 e (the #924 gap "aliases are output-only"): id filters take the aliases a result of THIS question
          // returned; the server maps them back to ids (resolveAliasInputs)
          ...aliasFilter('product_ids', 'p', 'products'),
          ...aliasFilter('category_ids', 'c', 'categories'),
          ...aliasFilter('sales_channel_ids', 'ch', 'sales channels'),
          ...aliasFilter('warehouse_ids', 'w', 'warehouses'),
          ...aliasFilter('customer_group_ids', 'g', 'customer groups'),
          ...aliasFilter('campaign_ids', 'cp', 'campaigns'),
          ...aliasFilter('promotion_ids', 'pr', 'promotions'),
          ...aliasFilter('utm_sources', 'u', 'utm sources'),
          ...aliasFilter('utm_mediums', 'u', 'utm mediums'),
          ...aliasFilter('utm_campaigns', 'u', 'utm campaigns'),
          touch: {
            type: 'string',
            enum: [...TOUCHES],
            description:
              'Attribution metrics: the first or the last touch of the order (last by default)',
          },
          refund_reasons: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', enum: [...REFUND_REASONS] },
          },
          countries: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', pattern: '^[A-Z]{2}$' },
            description: 'ISO country codes of the shipping country',
          },
          customer_types: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', enum: [...CUSTOMER_TYPES] },
          },
        },
      },
      compare: {
        type: 'string',
        enum: [...COMPARE_MODES],
        description:
          'Also returns the previous period (same length, just before) or the same dates a year earlier, and the change per currency; a change is never a cause',
      },
      order_by: {
        type: 'object',
        additionalProperties: false,
        required: ['metric'],
        description:
          'Sorts the rows; with a dimension, grain total and limit it gives a top or bottom N',
        properties: {
          metric: { type: 'string', enum: metrics },
          direction: { type: 'string', enum: ['desc', 'asc'] },
        },
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: LIMITS.max_rows,
        description: 'Rows to return: N for a top N',
      },
    },
  };
  const stores = scope.stores.map((s) => `${s.code} = ${s.id}`).join(', ');
  return {
    name: QUERY_METRICS_TOOL,
    description:
      `Runs one typed metrics query over the analytics store and returns its rows and per-currency totals. ` +
      `Stores you may ask about: ${stores}. The question's window is ${scope.window.from} to ${scope.window.to} ` +
      `(UTC, end exclusive) unless the question names another. ${dimensionsLine(metrics)} Money is integer minor ` +
      `units per currency and is never added across currencies. Each result carries a "ref" (q1, q2 …): cite ` +
      `figures by it.`,
    inputSchema,
  };
}

/**
 * Which dimensions each of the caller's metrics accepts (#7 of the 2026-11-02 real-model run: the tool offered
 * `product` but never said which metric takes it), grouped by identical dimension sets so the line stays short — it
 * goes with every step.
 */
export function dimensionsLine(metrics: readonly MetricId[]): string {
  const by = new Map<string, MetricId[]>();
  for (const m of metrics) {
    const k = METRICS[m].dimensions.join(', ');
    by.set(k, [...(by.get(k) ?? []), m]);
  }
  const parts = [...by].map(([dims, ms]) => `${ms.join(', ')} take ${dims || 'no dimension'}`);
  return `Dimensions: ${parts.join('; ')}.`;
}

const errorOf = (e: AppError) => ({
  code: e.code,
  message: e.message,
  ...(e.details === undefined ? {} : { details: e.details }),
});

/**
 * The handler the gateway calls for every `query_metrics` call. A call that is not a valid MetricQuery, or that
 * reaches outside the scope, becomes a tool ERROR the model can read (and the analytics store is not touched); a
 * failure of the analytics store itself is thrown: the run ends and the caller answers 503 (nothing partial).
 * Every call that parsed is recorded in `executed`, in order, with the ref the model cites.
 */
export interface ToolDeps {
  reader: MetricsReader;
  caller: MetricsCaller;
  executed: ExecutedQuery[];
  /** store id → code: the model reads rows by store CODE (see below) */
  codes?: ReadonlyMap<string, string>;
  /** the question's alias registry (a fresh one per handler when omitted) */
  aliases?: Aliases;
  /** the `stock` series scope (#871 c); stock metrics are a tool error without it */
  stockScope?: () => Promise<StockScope>;
  /** the Postgres promotions source (#935); promotion metrics are a tool error without it */
  promotions?: PostgresSourceLoader;
  /** getInventoryHealth for this caller, restricted to the question's stores (BI Q&A-off stores excluded) */
  inventory?: (q: InventoryQuery) => Promise<InventoryHealth>;
  inventoryCalls?: ExecutedInventory[];
  /** getCustomerCohorts over the question's stores (#935; the tool is offered only with it) */
  cohorts?: (q: CohortQuery) => Promise<CustomerCohorts>;
  /** getOperationsBacklog over the question's stores (#935; the tool is offered only with it) */
  backlog?: () => Promise<OperationsBacklog>;
}

/** An id filter of the tool schema that takes aliases of one kind (p1, c2 …), never a uuid the model cannot see. */
function aliasFilter(name: string, prefix: string, what: string): Record<string, object> {
  return {
    [name]: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      // an alias, or an id the question itself gave
      items: { type: 'string', pattern: `^(${prefix}\\d+|[0-9a-fA-F-]{36})$` },
      description: `Aliases of ${what} an earlier result of this question returned (${prefix}1, ${prefix}2 …)`,
    },
  };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The filter → the alias kind its values are (#935 e). */
const ALIAS_FILTERS: Readonly<Record<string, AliasKind>> = {
  product_ids: 'product',
  category_ids: 'category',
  sales_channel_ids: 'sales_channel',
  warehouse_ids: 'warehouse',
  customer_group_ids: 'customer_group',
  campaign_ids: 'campaign',
  promotion_ids: 'promotion',
  utm_sources: 'utm',
  utm_mediums: 'utm',
  utm_campaigns: 'utm',
};

/**
 * The aliases a tool call names in its filters, mapped back to the ids (or utm text) they stand for. Only an alias
 * THIS question issued, of the filter's kind, resolves: anything else is a tool error (a 400 the model can read),
 * never a guess. Returns the input with the ids in place.
 */
export function resolveAliasInputs(input: unknown, aliases: Aliases): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const i = input as Record<string, unknown>;
  const filters = i.filters;
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return input;
  const out: Record<string, unknown> = { ...(filters as Record<string, unknown>) };
  for (const [name, kind] of Object.entries(ALIAS_FILTERS)) {
    const values = out[name];
    if (!Array.isArray(values)) continue;
    out[name] = values.map((v) => {
      if (typeof v === 'string' && UUID_SHAPE.test(v)) return v; // an id, not an alias
      const hit = typeof v === 'string' ? aliases.reverse.get(v) : undefined;
      if (!hit || hit.kind !== kind)
        throw new AppError(
          'validation_error',
          `filters.${name}: ${String(v)} is not an alias this question returned`,
          { field: `filters.${name}`, item: v, reason: 'alias_unknown' },
        );
      return hit.id;
    });
  }
  return { ...i, filters: out };
}

/** A utm value as an alias (u1 …): its text is the legend's, the model never reads it. */
function utmAlias(aliases: Aliases, value: string | null): string | null {
  const a = aliases.of('utm', value);
  if (a !== null && value !== null) aliases.known.set(a, value);
  return a;
}

/** A result's rows as the model reads them: no uuid, aliases instead (#680 review; #871 e). */
function modelRows(result: MetricResult, deps: ToolDeps, aliases: Aliases) {
  return result.rows
    .slice(0, MODEL_ROWS)
    .map(
      ({
        store_id,
        product_id,
        category_id,
        sales_channel_id,
        warehouse_id,
        customer_group_id,
        campaign_id,
        promotion_id,
        utm_source,
        utm_medium,
        utm_campaign,
        ...rest
      }) => ({
        ...rest,
        store: store_id === null ? null : (deps.codes?.get(store_id) ?? store_id),
        product: aliases.of('product', product_id),
        category: aliases.of('category', category_id),
        sales_channel: aliases.of('sales_channel', sales_channel_id),
        warehouse: aliases.of('warehouse', warehouse_id),
        // #935 e: ids as aliases; utm text as aliases too (the text is known: the legend shows it after the answer)
        customer_group: aliases.of('customer_group', customer_group_id),
        campaign: aliases.of('campaign', campaign_id),
        promotion: aliases.of('promotion', promotion_id),
        utm_source: utmAlias(aliases, utm_source),
        utm_medium: utmAlias(aliases, utm_medium),
        utm_campaign: utmAlias(aliases, utm_campaign),
      }),
    );
}

/** One handler for every tool, by name (the gateway calls a single handler). */
export function biQaToolHandler(deps: ToolDeps): (call: AiToolCall) => Promise<AiToolResult> {
  const aliases = deps.aliases ?? new Aliases();
  const metrics = queryMetricsHandler({ ...deps, aliases });
  return async (call) => {
    if (call.name === MOVERS_TOOL) return moversHandler({ ...deps, aliases })(call);
    if (call.name === INVENTORY_TOOL) return inventoryHandler({ ...deps, aliases })(call);
    if (call.name === COHORTS_TOOL) return cohortsHandler(deps)(call);
    if (call.name === BACKLOG_TOOL) return backlogHandler({ ...deps, aliases })();
    return metrics(call);
  };
}

export function queryMetricsHandler(deps: ToolDeps): (call: AiToolCall) => Promise<AiToolResult> {
  const aliases = deps.aliases ?? new Aliases();
  return async (call) => {
    let query: MetricQuery;
    try {
      query = parseMetricQuery(resolveAliasInputs(call.input, aliases));
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return { isError: true, content: JSON.stringify({ error: errorOf(e) }) };
    }
    const ref = `q${deps.executed.length + 1}`;
    let scope: readonly string[];
    try {
      scope = await scopeForQuery(query, deps.caller);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      deps.executed.push({ ref, query, error: errorOf(e) });
      return { isError: true, content: JSON.stringify({ ref, error: errorOf(e) }) };
    }
    const needsStock = query.metrics.some((m) => METRICS[m].source?.id === 'stock');
    if (needsStock && !deps.stockScope) {
      const e = new AppError('validation_error', 'stock series are not available here', {
        reason: 'stock_unavailable',
      });
      deps.executed.push({ ref, query, error: errorOf(e) });
      return { isError: true, content: JSON.stringify({ ref, error: errorOf(e) }) };
    }
    let stock: StockScope | undefined;
    try {
      stock = needsStock ? await deps.stockScope!() : undefined;
    } catch (e) {
      // a scope the series cannot carry (#908) is a tool error the model can read, never a broken run
      if (!(e instanceof AppError)) throw e;
      deps.executed.push({ ref, query, error: errorOf(e) });
      return { isError: true, content: JSON.stringify({ ref, error: errorOf(e) }) };
    }
    const result = await executeMetricQuery(deps.reader, query, scope, {
      ...(stock ? { stock } : {}),
      ...(deps.promotions ? { promotions: deps.promotions } : {}),
    });
    deps.executed.push({ ref, query, result });
    // What the model reads carries no uuid (#680 review): each store by its CODE, everything else by an alias stable
    // for the whole question (#871 e). The ids stay where they matter: the tool schema's store enum (what the model
    // filters by) and the caller's full result.
    const rows = modelRows(result, deps, aliases);
    const prev = result.compare
      ? modelRows({ ...result, rows: result.compare.rows }, deps, aliases)
      : null;
    return {
      content: JSON.stringify({
        ref,
        truncated: result.truncated || rows.length < result.rows.length,
        rows,
        currency_totals: result.currency_totals,
        ...(result.compare
          ? {
              compare: {
                mode: result.compare.mode,
                from: result.compare.from,
                to: result.compare.to,
                current_incomplete: result.compare.current_incomplete,
                rows: prev,
                changes: result.compare.changes,
              },
            }
          : {}),
        data_as_of: result.data_as_of,
      }),
    };
  };
}

// ---- movers (#871 a3/e) -----------------------------------------------------------------------------------------

export function moversTool(scope: ToolScope): AiTool {
  const metrics = METRIC_IDS.filter(
    (m) => (scope.finance || !METRICS[m].finance) && isAdditive(METRICS[m]),
  );
  return {
    name: MOVERS_TOOL,
    description:
      'What changed: the largest risers and fallers of ONE additive metric by ONE dimension, against the previous ' +
      'period (or the same dates a year earlier), per currency. Ranked by absolute change; change_bp (the % × 100) ' +
      'is null on a small or zero base — then say "new", "gone" or "small base", never a percentage. Movers say WHAT ' +
      'changed, never WHY: do not state a cause the data does not hold. Keys come back as aliases or store codes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['metric', 'dimension', 'from', 'to'],
      properties: {
        metric: { type: 'string', enum: metrics },
        dimension: { type: 'string', enum: [...MOVER_DIMENSIONS] },
        from: { type: 'string', format: 'date' },
        to: { type: 'string', format: 'date', description: 'exclusive' },
        compare: { type: 'string', enum: [...COMPARE_MODES] },
        limit: { type: 'integer', minimum: 1, maximum: LIMITS.max_movers },
      },
    },
  };
}

function moversHandler(deps: ToolDeps & { aliases: Aliases }) {
  return async (call: AiToolCall): Promise<AiToolResult> => {
    let mq;
    try {
      mq = parseMoversQuery(call.input);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return { isError: true, content: JSON.stringify({ error: errorOf(e) }) };
    }
    const query = moversMetricQuery(mq);
    const ref = `q${deps.executed.length + 1}`;
    let scope: readonly string[];
    try {
      scope = await scopeForQuery(query, deps.caller);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      deps.executed.push({ ref, query, error: errorOf(e) });
      return { isError: true, content: JSON.stringify({ ref, error: errorOf(e) }) };
    }
    // ranked over EVERY key of both ranges (#924 review); the answer records the equivalent compare query with its
    // rows capped at the query's limit, as any query result is (the ranking above is not affected by the cap)
    const full = await executeMetricQuery(deps.reader, query, scope, {
      noLimit: true,
      ...(deps.promotions ? { promotions: deps.promotions } : {}),
    });
    const r = moversFromResult(mq, full, new Date());
    const cap = <T>(rows: T[]) => rows.slice(0, query.limit);
    deps.executed.push({
      ref,
      query,
      result: {
        ...full,
        truncated: full.rows.length > query.limit,
        rows: cap(full.rows),
        compare: full.compare
          ? {
              ...full.compare,
              truncated: full.compare.rows.length > query.limit,
              rows: cap(full.compare.rows),
            }
          : null,
      },
    });
    const kind: AliasKind | null =
      mq.dimension === 'product'
        ? 'product'
        : mq.dimension === 'category'
          ? 'category'
          : mq.dimension === 'sales_channel'
            ? 'sales_channel'
            : null;
    const key = (k: string) =>
      mq.dimension === 'store' ? (deps.codes?.get(k) ?? k) : kind ? deps.aliases.of(kind, k)! : k;
    return {
      content: JSON.stringify({
        ref,
        current: r.current,
        previous: r.previous,
        current_incomplete: r.current_incomplete,
        by_currency: r.by_currency.map((b) => ({
          ...b,
          risers: b.risers.map((m) => ({ ...m, key: key(m.key) })),
          fallers: b.fallers.map((m) => ({ ...m, key: key(m.key) })),
        })),
        data_as_of: r.data_as_of,
      }),
    };
  };
}

// ---- inventory_health (#871 a1/e: the owner's "do we need to order anything?") ----------------------------------

export function inventoryTool(): AiTool {
  return {
    name: INVENTORY_TOOL,
    description:
      'Stock now, per stock item (warehouses as a breakdown): available, days of cover at the recent sales rate, a ' +
      'status (stock_out, low, reorder, dead, overstock, ok) and a suggested reorder quantity = max(0, ' +
      'ceil(rate × (lead time + cover days)) − available − incoming). Incoming is NOT tracked yet (always 0): say that ' +
      'the suggestion assumes nothing is on order and that supplier orders must be subtracted by hand. Name the ' +
      'parameters used. Flag rate_understated (sales were limited by stock) and suggestion_partial (other brands share ' +
      'the stock; HQ’s view is the full one). Items and warehouses come back as aliases (i1, w1).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: [...INVENTORY_STATUSES] },
        },
        velocity_days: { type: 'integer', minimum: 7, maximum: 90 },
        lead_time_days: { type: 'integer', minimum: 0, maximum: 180 },
        cover_days: { type: 'integer', minimum: 0, maximum: 180 },
        dead_days: { type: 'integer', minimum: 14, maximum: 365 },
        sort: {
          type: 'string',
          enum: [
            'days_of_cover',
            'suggested_reorder_units',
            'available',
            'units_sold_per_day_milli',
            'sku',
          ],
        },
        limit: { type: 'integer', minimum: 1, maximum: MODEL_ROWS },
      },
    },
  };
}

function inventoryHandler(deps: ToolDeps & { aliases: Aliases }) {
  return async (call: AiToolCall): Promise<AiToolResult> => {
    const calls = deps.inventoryCalls ?? [];
    const ref = `h${calls.length + 1}`;
    let q: InventoryQuery;
    try {
      q = parseInventoryQuery(call.input ?? {});
      if (!deps.inventory)
        throw new AppError('validation_error', 'inventory is not available here', {
          reason: 'inventory_unavailable',
        });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      return { isError: true, content: JSON.stringify({ ref, error: errorOf(e) }) };
    }
    const result = await deps.inventory({ ...q, limit: Math.min(q.limit, MODEL_ROWS) });
    calls.push({ ref, query: q, result });
    const rows = result.rows.map((r) => {
      const alias = deps.aliases.of('item', r.stock_item_id)!;
      deps.aliases.known.set(alias, `${r.name} (${r.sku})`);
      return {
        item: alias,
        warehouses: r.warehouses.map((w) => {
          const wa = deps.aliases.of('warehouse', w.warehouse_id)!;
          deps.aliases.known.set(wa, w.warehouse_code);
          return {
            warehouse: wa,
            available: w.available,
            on_hand: w.on_hand,
            reserved: w.reserved,
          };
        }),
        available: r.available,
        incoming: r.incoming,
        units_sold: r.units_sold,
        units_sold_per_day_milli: r.units_sold_per_day_milli,
        days_of_cover: r.days_of_cover,
        status: r.status,
        suggested_reorder_units: r.suggested_reorder_units,
        rate_understated: r.rate_understated,
        shared: r.shared,
        suggestion_partial: r.suggestion_partial,
        parameters: r.parameters,
      };
    });
    return {
      content: JSON.stringify({
        ref,
        incoming_tracked: result.incoming_tracked,
        rate_available: result.rate_available,
        summary: result.summary,
        total: result.total,
        rows,
        data_as_of: result.data_as_of,
      }),
    };
  };
}

// ---- the substitution: aliases → names, in the final answer only -------------------------------------------------

const ALIAS = /\b(ch|cp|pr|[pcwigu])(\d+)\b/g;

/**
 * The model wrote aliases; the owner reads names. Every whole-token alias the question issued is replaced by its label
 * (resolved under the caller's scope; a stock item by its name and sku). An alias the question never issued, or one
 * without a label, stays as written. Returns the text and the legend (alias → name) the answer carries.
 */
export async function substituteAliases(
  text: string,
  aliases: Aliases,
  resolve: (ids: Partial<Record<keyof MetricLabels, Set<string>>>) => Promise<MetricLabels>,
): Promise<{ text: string; legend: Record<string, string> }> {
  const want: Partial<Record<keyof MetricLabels, Set<string>>> = {};
  for (const [alias, { kind, id }] of aliases.reverse) {
    if (kind === 'item' || kind === 'utm' || aliases.known.has(alias)) continue;
    (want[kind] ??= new Set()).add(id);
  }
  const labels = Object.keys(want).length > 0 ? await resolve(want) : {};
  const legend: Record<string, string> = {};
  for (const [alias, { kind, id }] of aliases.reverse) {
    const name =
      aliases.known.get(alias) ??
      (kind === 'item' || kind === 'utm' ? undefined : labels[kind]?.[id]);
    if (name !== undefined) legend[alias] = name;
  }
  return { text: text.replace(ALIAS, (m) => legend[m] ?? m), legend };
}

// ---- BI v2 wave 2 (#935 e): cohorts and the operations backlog -----------------------------------------------------

export function cohortsTool(): AiTool {
  return {
    name: COHORTS_TOOL,
    description:
      'Customer cohorts in ONE currency: customers grouped by the month of their first order in a store (a customer ' +
      'of two brands is two customers), and per month since then the active customers, the retention (active ÷ ' +
      'cohort size, basis points) and the net sales per customer to date (LTV to date, minor units). Cells of fewer ' +
      'than 5 customers are suppressed (null): say so, never guess them. Months are YYYY-MM.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['from_month', 'to_month', 'currency'],
      properties: {
        from_month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        to_month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        months: { type: 'integer', minimum: 1, maximum: 24 },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      },
    },
  };
}

function cohortsHandler(deps: ToolDeps) {
  return async (call: AiToolCall): Promise<AiToolResult> => {
    try {
      if (!deps.cohorts)
        throw new AppError('validation_error', 'cohorts are not available here', {
          reason: 'cohorts_unavailable',
        });
      // the stores are the question's: the tool takes no store ids
      const q = parseCohortQuery(call.input ?? {});
      const r = await deps.cohorts(q);
      return { content: JSON.stringify({ currency: r.currency, cohorts: r.cohorts }) };
    } catch (e) {
      if (!(e instanceof AppError) || e.code === 'unavailable') throw e;
      return { isError: true, content: JSON.stringify({ error: errorOf(e) }) };
    }
  };
}

export function backlogTool(): AiTool {
  return {
    name: BACKLOG_TOOL,
    description:
      'What is stuck NOW, by age (lt_1d, d1_2 = 1–2 days, d3_7, gt_7d) per store and warehouse: `unassigned` (paid ' +
      'orders with no shipment and no warehouse), `shipment_not_shipped` (shipments created, not shipped) and ' +
      '`return_not_received` (returns requested, not received). Warehouses come back as aliases (w1).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  };
}

function backlogHandler(deps: ToolDeps & { aliases: Aliases }) {
  return async (): Promise<AiToolResult> => {
    if (!deps.backlog)
      return {
        isError: true,
        content: JSON.stringify({
          error: { code: 'validation_error', message: 'the backlog is not available here' },
        }),
      };
    const r = await deps.backlog();
    return {
      content: JSON.stringify({
        buckets: r.buckets,
        rows: r.rows.map((x) => ({
          kind: x.kind,
          store: deps.codes?.get(x.store_id) ?? x.store_id,
          warehouse: deps.aliases.of('warehouse', x.warehouse_id),
          bucket: x.bucket,
          count: x.count,
        })),
        totals: r.totals,
      }),
    };
  };
}
