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
import { COMPARE_MODES, parseMetricQuery, type MetricQuery } from '../metrics/query';
import { scopeForQuery, type MetricsCaller } from '../metrics/scope';
import type { AiTool, AiToolCall, AiToolResult, JsonSchemaObject } from './gateway';

export const QUERY_METRICS_TOOL = 'query_metrics';
export const MOVERS_TOOL = 'movers';
export const INVENTORY_TOOL = 'inventory_health';

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
          'One row per value of each: product = one row per product (the way to rank products); products, categories, channels and warehouses come back as aliases (p1, c1, ch1, w1) — write the alias, the server puts the name in',
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
          product_ids: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', format: 'uuid' },
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
    return metrics(call);
  };
}

export function queryMetricsHandler(deps: ToolDeps): (call: AiToolCall) => Promise<AiToolResult> {
  const aliases = deps.aliases ?? new Aliases();
  return async (call) => {
    let query: MetricQuery;
    try {
      query = parseMetricQuery(call.input);
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
