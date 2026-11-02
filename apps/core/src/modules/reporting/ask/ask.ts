// BI Q&A, `askMetrics` (#606, contract #668): a question → the AI gateway's tool loop with `query_metrics` → an answer
// that cites the queries it ran. Everything the question can read is decided here, BEFORE the model sees anything:
//   * `store_ids` outside the caller's scope → 403, nothing sent (the same rule as queryMetrics);
//   * stores with `settings.ai.bi_qa = false` are left out (absent = ON, owner decision 2026-11-01) and listed in
//     `excluded_store_ids` — only stores the caller may see are ever listed; none left → 403 `bi_qa_off`;
//   * an organization-level principal → the organization's AI budget and audit (`storeId: null`, decision (a)); anyone
//     else names exactly one store (`store_required` otherwise) and is charged to it — decided by the PRINCIPAL, never
//     by how many stores happen to be in scope (#677 review; the rule in #673).
// The tool then re-checks every call (tool.ts), so even a model that ignores its schema cannot leave the scope.
import { AppError } from '../../../lib/errors';
import { LIMITS } from '../metrics/catalogue';
import type { MetricsReader } from '../metrics/execute';
import type { MetricId } from '../metrics/catalogue';
import { aiErrorToAppError, type AiToolRun, type GatewayFactory } from './gateway';
import { queryMetricsHandler, queryMetricsTool, type ExecutedQuery } from './tool';

export const BI_QA_TEMPLATE = 'bi-qa-answer@1' as const;
/** Tool calls one question may make (the gateway enforces it; #669 caps it at 8). */
export const MAX_TOOL_CALLS = 5;
const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export interface AskInput {
  question: string;
  store_ids?: string[];
  from?: string;
  to?: string;
}

export interface AskCaller {
  organizationId: string;
  /** staff_user.id: the audit's actor and the only one who may rate the answer */
  actorId: string;
  /** every store the caller may view, with its code */
  stores: readonly { id: string; code: string }[];
  /** `finance` on organization:hq */
  finance: boolean;
  /** an organization-level principal (hasOrganizationAccess): the only one who asks over several stores */
  organizationScope: boolean;
}

export interface AskDeps {
  reader: MetricsReader;
  gatewayFor: GatewayFactory;
  /** `settings.ai.bi_qa` per store id; a store missing from the map counts as ON */
  biQaSwitches: (storeIds: readonly string[]) => Promise<ReadonlyMap<string, boolean>>;
  now?: () => Date;
}

/** The contract's MetricAnswer (#668). */
export interface MetricAnswer {
  conversation_id: string;
  answer: string;
  queries: {
    query: ExecutedQuery['query'];
    result?: ExecutedQuery['result'];
    error?: ExecutedQuery['error'];
  }[];
  chart: { query_index: number; metric: MetricId } | null;
  excluded_store_ids: string[];
  model: string;
  template: { id: string; version: number };
  created_at: string;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const isDay = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const invalid = (message: string, field: string) =>
  new AppError('validation_error', message, { field });

/** The question's default window: the last 30 UTC days up to and including today. */
export function askWindow(input: AskInput, now: Date): { from: string; to: string } {
  const today = Date.parse(`${day(now.getTime())}T00:00:00Z`);
  const from = input.from ?? day(today - DEFAULT_WINDOW_DAYS * DAY_MS);
  const to = input.to ?? day(today + DAY_MS);
  if (!isDay(from)) throw invalid('from must be a date (YYYY-MM-DD)', 'from');
  if (!isDay(to)) throw invalid('to must be a date (YYYY-MM-DD)', 'to');
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  if (span <= 0) throw invalid('to must be after from', 'to');
  if (span > LIMITS.max_range_days)
    throw invalid(`at most ${LIMITS.max_range_days} days from from to to`, 'to');
  return { from, to };
}

/** The query and metric the admin draws: the first query that ran at day grain, its first metric. */
export function chartHint(queries: readonly ExecutedQuery[]): MetricAnswer['chart'] {
  const i = queries.findIndex((q) => q.result !== undefined && q.query.grain === 'day');
  return i < 0 ? null : { query_index: i, metric: queries[i]!.query.metrics[0]! };
}

export async function askMetrics(
  deps: AskDeps,
  caller: AskCaller,
  input: AskInput,
): Promise<MetricAnswer> {
  const now = (deps.now ?? (() => new Date()))();
  const window = askWindow(input, now);

  // the scope, checked before anything is sent: a store outside it is a 403, never a silent narrowing
  if (caller.stores.length === 0)
    throw new AppError('forbidden', 'no visible store', { relation: 'viewer', object: 'store:*' });
  const byId = new Map(caller.stores.map((s) => [s.id, s]));
  for (const id of input.store_ids ?? [])
    if (!byId.has(id))
      throw new AppError('forbidden', `requires viewer on store:${id}`, {
        relation: 'viewer',
        object: `store:${id}`,
      });
  const asked = input.store_ids ? input.store_ids.map((id) => byId.get(id)!) : [...caller.stores];
  // a store principal with several stores names ONE (the store view always sends its own): no store question is ever
  // charged to, or audited as, the organization
  if (!caller.organizationScope && asked.length !== 1)
    throw new AppError('validation_error', 'name exactly one store in store_ids', {
      field: 'store_ids',
      reason: 'store_required',
    });

  // the per-store switch (absent = ON); only stores the caller may see can be excluded, so none other is named
  const switches = await deps.biQaSwitches(asked.map((s) => s.id));
  const on = asked.filter((s) => switches.get(s.id) !== false);
  const excluded = asked.filter((s) => switches.get(s.id) === false).map((s) => s.id);
  if (on.length === 0)
    throw new AppError('forbidden', 'BI Q&A is switched off for these stores', {
      reason: 'bi_qa_off',
    });

  const gateway = deps.gatewayFor({
    organizationId: caller.organizationId,
    storeId: caller.organizationScope ? null : on[0]!.id,
    actorId: caller.actorId,
  });
  const executed: ExecutedQuery[] = [];
  let run: AiToolRun;
  try {
    run = await gateway.runTools(
      BI_QA_TEMPLATE,
      {
        question: input.question,
        today: day(now.getTime()),
        window: `${window.from}..${window.to}`,
        // the template's format: code and id, one per line (bi-qa-answer@1)
        stores: on.map((s) => `${s.code} ${s.id}`).join('\n'),
        currencyNote:
          'Amounts are integer minor units per currency; never add different currencies together.',
      },
      {
        tools: [queryMetricsTool({ stores: on, finance: caller.finance, window })],
        handle: queryMetricsHandler({
          reader: deps.reader,
          caller: { stores: on.map((s) => s.id), finance: () => caller.finance },
          executed,
          codes: new Map(on.map((s) => [s.id, s.code])),
        }),
        maxToolCalls: MAX_TOOL_CALLS,
      },
    );
  } catch (err) {
    throw aiErrorToAppError(err) ?? err;
  }

  return {
    conversation_id: run.conversationId,
    answer: run.text,
    queries: executed.map(({ query, result, error }) => ({
      query,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    })),
    chart: chartHint(executed),
    excluded_store_ids: excluded,
    model: run.servedModel,
    template: run.template,
    created_at: now.toISOString(),
  };
}
