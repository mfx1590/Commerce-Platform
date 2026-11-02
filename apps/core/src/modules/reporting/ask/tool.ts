// BI Q&A's one tool, `query_metrics` (#606, D4/D9): the model chooses metric × dimensions × filters × grain from
// the typed catalogue, and the SERVER validates, scopes and runs it with exactly the functions `queryMetrics` uses
// (parseMetricQuery → scopeForQuery → executeMetricQuery). No SQL exists on this path. The schema the model sees is
// narrowed to the caller (their metrics, their stores), but the narrowing is only a hint: every call is checked
// again here, so a call outside the scope is a tool error and never reaches the analytics store.
import { AppError } from '../../../lib/errors';
import {
  DIMENSIONS,
  GRAINS,
  LIMITS,
  METRIC_IDS,
  METRICS,
  REFUND_REASONS,
} from '../metrics/catalogue';
import { executeMetricQuery, type MetricResult, type MetricsReader } from '../metrics/execute';
import { parseMetricQuery, type MetricQuery } from '../metrics/query';
import { scopeForQuery, type MetricsCaller } from '../metrics/scope';
import type { AiTool, AiToolCall, AiToolResult, JsonSchemaObject } from './gateway';

export const QUERY_METRICS_TOOL = 'query_metrics';

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
  const metrics = METRIC_IDS.filter((m) => scope.finance || !METRICS[m].finance);
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
        },
      },
      order_by: {
        type: 'object',
        additionalProperties: false,
        required: ['metric'],
        properties: {
          metric: { type: 'string', enum: metrics },
          direction: { type: 'string', enum: ['desc', 'asc'] },
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: LIMITS.max_rows },
    },
  };
  const stores = scope.stores.map((s) => `${s.code} = ${s.id}`).join(', ');
  return {
    name: QUERY_METRICS_TOOL,
    description:
      `Runs one typed metrics query over the analytics store and returns its rows and per-currency totals. ` +
      `Stores you may ask about: ${stores}. The question's window is ${scope.window.from} to ${scope.window.to} ` +
      `(UTC, end exclusive) unless the question names another. Money is integer minor units per currency and is ` +
      `never added across currencies. Each result carries a "ref" (q1, q2 …): cite figures by it.`,
    inputSchema,
  };
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
export function queryMetricsHandler(deps: {
  reader: MetricsReader;
  caller: MetricsCaller;
  executed: ExecutedQuery[];
  /** store id → code: the model reads rows by store CODE (see below) */
  codes?: ReadonlyMap<string, string>;
}): (call: AiToolCall) => Promise<AiToolResult> {
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
    const result = await executeMetricQuery(deps.reader, query, scope);
    deps.executed.push({ ref, query, result });
    // what the model reads names each store by its CODE, not its uuid: packages/ai redacts what is sent, and its phone
    // pattern currently eats digit runs inside a uuid ("5a1b2c3d-[phone]-…"). The ids stay where the model needs them
    // (the tool schema's enum, not redacted) and in the caller's full result.
    const rows = result.rows.slice(0, MODEL_ROWS).map(({ store_id, ...rest }) => ({
      ...rest,
      store: store_id === null ? null : (deps.codes?.get(store_id) ?? store_id),
    }));
    return {
      content: JSON.stringify({
        ref,
        truncated: result.truncated || rows.length < result.rows.length,
        rows,
        currency_totals: result.currency_totals,
        data_as_of: result.data_as_of,
      }),
    };
  };
}
