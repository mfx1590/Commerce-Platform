// BI Q&A, `askMetrics` (#606, contract #668): a question → the AI gateway's tool loop with `query_metrics` → an answer
// that cites the queries it ran. Everything the question can read is decided here, BEFORE the model sees anything:
//   * `store_ids` outside the caller's scope → 403, nothing sent (the same rule as queryMetrics);
//   * stores with `settings.ai.bi_qa = false` are left out (absent = ON, owner decision 2026-11-01) and listed in
//     `excluded_store_ids` — only stores the caller may see are ever listed; none left → 403 `bi_qa_off`;
//   * an organization-level principal → the organization's AI budget and audit (`storeId: null`, decision (a)); anyone
//     else names exactly one store (`store_required` otherwise) and is charged to it — decided by the PRINCIPAL, never
//     by how many stores happen to be in scope (#677 review; the rule in #673).
// The tool then re-checks every call (tool.ts), so even a model that ignores its schema cannot leave the scope.
// BI v2 (#871 e): three closed tools (query_metrics, movers, inventory_health) share one alias registry per question;
// the final answer has its aliases replaced by names (under the caller's scope) and carries the legend. Stores with
// BI Q&A off are out of every tool, the inventory's pooled sales rate included.
import { AppError } from '../../../lib/errors';
import { LIMITS } from '../metrics/catalogue';
import type { StockScope } from '../metrics/compile';
import type { MetricLabels, MetricsReader, PostgresSourceLoader } from '../metrics/execute';
import type { InventoryHealth, InventoryQuery } from '../metrics/inventory';
import type { CohortQuery, CustomerCohorts, OperationsBacklog } from '../metrics/operations';
import type { MetricId } from '../metrics/catalogue';
import { aiErrorToAppError, type AiToolRun, type GatewayFactory } from './gateway';
import {
  Aliases,
  biQaToolHandler,
  backlogTool,
  cohortsTool,
  inventoryTool,
  moversTool,
  queryMetricsTool,
  substituteAliases,
  type ExecutedBacklog,
  type ExecutedCohorts,
  type ExecutedInventory,
  type ExecutedQuery,
} from './tool';

// v2 (#682, the first real-model run): the answer's language, ONE labelled derived figure, top-N by dimension;
// v3 (#684, the re-run): every number not copied from a result is labelled — a count difference too (#17)
export const BI_QA_TEMPLATE = 'bi-qa-answer@3' as const;
/** The answer's language when the question's own cannot be told, and the fallback for a missing or bad locale. */
export const DEFAULT_LOCALE = 'en';
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
  /** the admin's locale as the client sent it (an Accept-Language value); canonicalised, `en` when unusable */
  locale?: string | undefined;
}

/** a language tag longer than this is not a locale anyone sends (language-script-region is at most 12) */
const MAX_LOCALE_LENGTH = 35;

/**
 * The first language tag of an Accept-Language value, rebuilt from its language, script and region only
 * (`en-gb` → `en-GB`, `de-u-nu-arab` → `de`), else `en`. Extension and private-use subtags (`en-x-…`) are dropped
 * (#683 review: they pass words through), so no text from the header reaches the prompt.
 */
export function canonicalLocale(raw: string | undefined): string {
  const first = raw?.split(',')[0]?.split(';')[0]?.trim();
  if (!first || first === '*' || first.length > MAX_LOCALE_LENGTH) return DEFAULT_LOCALE;
  try {
    const l = new Intl.Locale(first);
    const tag = [l.language, l.script, l.region].filter((s) => s !== undefined).join('-');
    return Intl.getCanonicalLocales(tag)[0] ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export interface AskDeps {
  reader: MetricsReader;
  gatewayFor: GatewayFactory;
  /** `settings.ai.bi_qa` per store id; a store missing from the map counts as ON */
  biQaSwitches: (storeIds: readonly string[]) => Promise<ReadonlyMap<string, boolean>>;
  now?: () => Date;
  /** BI v2 (#871): the `stock` series scope for these stores; stock series are a tool error without it */
  stockScope?: (storeIds: readonly string[]) => Promise<StockScope>;
  /** BI v2 wave 2 (#935): the Postgres promotions source under the caller's scope */
  promotions?: PostgresSourceLoader;
  /** BI v2 wave 2 (#935 e): getCustomerCohorts and getOperationsBacklog over these stores */
  cohorts?: (storeIds: readonly string[], q: CohortQuery) => Promise<CustomerCohorts>;
  backlog?: (storeIds: readonly string[]) => Promise<OperationsBacklog>;
  /** BI v2: getInventoryHealth over these stores only (the inventory_health tool is offered only with it) */
  inventory?: (storeIds: readonly string[], q: InventoryQuery) => Promise<InventoryHealth>;
  /** BI v2: names for the aliases the answer uses, under the caller's scope (aliases stay when omitted) */
  labels?: (ids: Partial<Record<keyof MetricLabels, Set<string>>>) => Promise<MetricLabels>;
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
  /** BI v2 (#871): the inventory_health calls the answer cites (h1, h2 …) */
  inventory?: { ref: string; query: InventoryQuery; result?: InventoryHealth }[];
  /** BI v2 wave 2 (#951 review 6): the customer_cohorts and operations_backlog calls the answer cites (k1 …, b1 …) */
  cohorts?: ExecutedCohorts[];
  backlog?: ExecutedBacklog[];
  /** BI v2: alias → name for every alias the question issued (the answer's text already uses the names) */
  labels?: Record<string, string>;
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
  const inventoryCalls: ExecutedInventory[] = [];
  const cohortCalls: ExecutedCohorts[] = [];
  const backlogCalls: ExecutedBacklog[] = [];
  const aliases = new Aliases();
  const onIds = on.map((s) => s.id);
  const tools = [
    queryMetricsTool({ stores: on, finance: caller.finance, window }),
    moversTool({ stores: on, finance: caller.finance, window }),
    ...(deps.inventory ? [inventoryTool()] : []),
    ...(deps.cohorts ? [cohortsTool()] : []),
    ...(deps.backlog ? [backlogTool()] : []),
  ];
  let run: AiToolRun;
  try {
    run = await gateway.runTools(
      BI_QA_TEMPLATE,
      {
        question: input.question,
        locale: canonicalLocale(caller.locale),
        today: day(now.getTime()),
        window: `${window.from}..${window.to}`,
        // the template's format: code and id, one per line (bi-qa-answer@1 and @2)
        stores: on.map((s) => `${s.code} ${s.id}`).join('\n'),
        currencyNote:
          'Amounts are integer minor units per currency; never add different currencies together.',
      },
      {
        tools,
        handle: biQaToolHandler({
          reader: deps.reader,
          caller: { stores: onIds, finance: () => caller.finance },
          executed,
          codes: new Map(on.map((s) => [s.id, s.code])),
          aliases,
          ...(deps.stockScope ? { stockScope: () => deps.stockScope!(onIds) } : {}),
          ...(deps.promotions ? { promotions: deps.promotions } : {}),
          ...(deps.cohorts
            ? { cohorts: (q: CohortQuery) => deps.cohorts!(onIds, q), cohortCalls }
            : {}),
          ...(deps.backlog ? { backlog: () => deps.backlog!(onIds), backlogCalls } : {}),
          ...(deps.inventory
            ? { inventory: (q: InventoryQuery) => deps.inventory!(onIds, q), inventoryCalls }
            : {}),
        }),
        maxToolCalls: MAX_TOOL_CALLS,
      },
    );
  } catch (err) {
    throw aiErrorToAppError(err) ?? err;
  }

  const named = await substituteAliases(run.text, aliases, deps.labels ?? (async () => ({})));
  return {
    conversation_id: run.conversationId,
    answer: named.text,
    queries: executed.map(({ query, result, error }) => ({
      query,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    })),
    chart: chartHint(executed),
    ...(inventoryCalls.length > 0 ? { inventory: inventoryCalls } : {}),
    ...(cohortCalls.length > 0 ? { cohorts: cohortCalls } : {}),
    ...(backlogCalls.length > 0 ? { backlog: backlogCalls } : {}),
    ...(Object.keys(named.legend).length > 0 ? { labels: named.legend } : {}),
    excluded_store_ids: excluded,
    model: run.servedModel,
    template: run.template,
    created_at: now.toISOString(),
  };
}
