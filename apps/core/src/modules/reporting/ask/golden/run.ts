// Plays a golden case through askMetrics on the REAL AI gateway (packages/ai `createAiGateway`, purpose `analysis`)
// over its scripted fake transport, and checks it (cases.ts). The final answer step writes the figures of the tool
// results the gateway actually sent back to the model (after its denylist check and redaction), in the model's style
// ("EUR 1234.56 [q1]"), and the checks hold any answer — scripted now, a real model's later — to the same rules.
import { AppError } from '../../../../lib/errors';
import { METRICS, type MetricId } from '../../metrics/catalogue';
import type { MetricResult, MetricsReader } from '../../metrics/execute';
import { askMetrics, type AskCaller, type MetricAnswer } from '../ask';
import {
  createAiGateway,
  createFakeTransport,
  createMemoryAuditSink,
  createMemoryLimiter,
  type AiRequest,
  type FakeScriptStep,
  type FakeTransport,
} from '@platform/ai';
import type { GatewayFactory } from '../gateway';
import type { GoldenCase, GoldenEnv, Principal } from './cases';

export interface GoldenStores {
  A: { id: string; code: string };
  B: { id: string; code: string };
}

export function callerFor(p: Principal, s: GoldenStores): AskCaller {
  const base = { organizationId: '00000000-0000-4000-8000-000000000001', actorId: `actor-${p}` };
  if (p === 'storeAdminA')
    return { ...base, stores: [s.A], finance: false, organizationScope: false };
  // analyst and finance are organization-level relations: HQ principals
  return { ...base, stores: [s.A, s.B], finance: p === 'finance', organizationScope: true };
}

/** The figures a result can back: money as major units with 2 decimals, counts and basis points as integers. */
function backedValues(result: MetricResult, metrics: readonly MetricId[]): Set<string> {
  const out = new Set<string>();
  const add = (m: string, v: number | null | undefined) => {
    if (v === null || v === undefined) return;
    out.add(METRICS[m as MetricId]?.unit === 'minor' ? (v / 100).toFixed(2) : String(v));
  };
  for (const r of result.rows) for (const m of metrics) add(m, r.values[m]);
  for (const t of result.currency_totals) for (const m of metrics) add(m, t.values[m]);
  return out;
}

/** The answer the scripted model gives: every currency total of every result, cited by its ref. */
function answerFrom(results: { parsed: unknown }[]): string {
  const parts: string[] = [];
  for (const { parsed } of results) {
    const r = parsed as {
      ref?: string;
      currency_totals?: { currency: string | null; values: Record<string, number | null> }[];
    };
    if (!r.ref || !r.currency_totals) continue;
    for (const t of r.currency_totals)
      for (const [m, v] of Object.entries(t.values)) {
        if (v === null) continue;
        const shown = METRICS[m as MetricId]?.unit === 'minor' ? (v / 100).toFixed(2) : String(v);
        parts.push(`${m} ${t.currency ?? ''} ${shown} [${r.ref}]`.replace(/\s+/g, ' '));
      }
  }
  return parts.length > 0 ? parts.join('; ') : 'I can only answer questions about these metrics.';
}

/** `finalText` replaces the scripted answer (tests prove the checks catch a wrong one). */
/** The tool results the gateway sent back to the model so far (the user turns of the run), parsed. */
function resultsSent(req: AiRequest): { parsed: unknown }[] {
  return (req.turns ?? []).flatMap((t) =>
    t.role === 'user'
      ? t.toolResults.map((r) => ({ parsed: JSON.parse(r.content) as unknown }))
      : [],
  );
}

export function scriptFor(c: GoldenCase, env: GoldenEnv, finalText?: string): FakeScriptStep[] {
  return [
    ...c
      .calls(env)
      .map((input): FakeScriptStep => ({ toolUse: [{ name: 'query_metrics', input }] })),
    (req: AiRequest) => ({ text: finalText ?? answerFrom(resultsSent(req)) }),
  ];
}

/** The production gateway with only the provider replaced: memory limiter and audit, AI switched on. */
function realGateway(transport: FakeTransport): GatewayFactory {
  const limiter = createMemoryLimiter();
  const audit = createMemoryAuditSink();
  return (scope) =>
    createAiGateway({
      ...scope,
      purpose: 'analysis',
      transport,
      limiter,
      audit,
      env: { AI_ENABLED: '1' },
    });
}

export interface GoldenOutcome {
  problems: string[];
  answer?: MetricAnswer;
}

export async function runGoldenCase(
  c: GoldenCase,
  env: GoldenEnv,
  stores: GoldenStores,
  reader: MetricsReader,
  finalText?: string,
): Promise<GoldenOutcome> {
  const problems: string[] = [];
  const transport = createFakeTransport({ script: scriptFor(c, env, finalText) });
  let answer: MetricAnswer;
  try {
    answer = await askMetrics(
      {
        reader,
        gatewayFor: realGateway(transport),
        biQaSwitches: async () => new Map(),
        now: () => new Date('2026-10-31T12:00:00Z'),
      },
      callerFor(c.principal, stores),
      { question: c.question, ...(c.storeIds ? { store_ids: c.storeIds(env) } : {}) },
    );
  } catch (err) {
    if ('error' in c.expect) {
      if (!(err instanceof AppError) || err.code !== c.expect.error)
        problems.push(
          `expected ${c.expect.error}, got ${(err as Error).name}: ${(err as Error).message}`,
        );
      if (c.expect.error === 'forbidden' && transport.calls.length > 0)
        problems.push('a model call before the 403');
      return { problems };
    }
    return { problems: [`unexpected ${(err as Error).name}: ${(err as Error).message}`] };
  }
  if ('error' in c.expect)
    return { problems: [`expected ${c.expect.error}, got an answer`], answer };

  const ran = answer.queries.filter((x) => x.result !== undefined);
  if (ran.length !== c.expect.ran)
    problems.push(`ran ${ran.length} queries, expected ${c.expect.ran}`);
  const refused = answer.queries.filter((x) => x.error).map((x) => x.error!.code);
  if (JSON.stringify(refused) !== JSON.stringify(c.expect.refused ?? []))
    problems.push(
      `refused ${JSON.stringify(refused)}, expected ${JSON.stringify(c.expect.refused ?? [])}`,
    );
  if (c.expect.chart && answer.chart === null) problems.push('no chart for a day-grain answer');
  // scope: every row of every result is a store the asker may read
  const allowed = new Set(callerFor(c.principal, stores).stores.map((s) => s.id));
  for (const x of ran)
    for (const r of x.result!.rows)
      if (r.store_id !== null && !allowed.has(r.store_id))
        problems.push(`a row of store ${r.store_id}`);
  // every citation resolves, and a cited figure is in the result it cites
  for (const m of answer.answer.matchAll(/(-?\d+(?:\.\d+)?) \[q(\d+)\]/g)) {
    const x = answer.queries[Number(m[2]) - 1];
    if (!x?.result) {
      problems.push(`[q${m[2]}] cites no result`);
      continue;
    }
    if (!backedValues(x.result, x.query.metrics).has(m[1]!))
      problems.push(`${m[1]} [q${m[2]}] is not in that result`);
  }
  for (const m of answer.answer.matchAll(/\[q(\d+)\]/g))
    if (!answer.queries[Number(m[1]) - 1]?.result) problems.push(`[q${m[1]}] cites no result`);
  // EVERY numeric token (citations aside) is backed by some result the run returned: no figure from nowhere,
  // cited or not (#677 review)
  const anyResult = new Set(
    answer.queries.flatMap((x) => (x.result ? [...backedValues(x.result, x.query.metrics)] : [])),
  );
  for (const m of answer.answer.replace(/\[q\d+\]/g, ' ').matchAll(/-?\d+(?:\.\d+)?/g))
    if (!anyResult.has(m[0])) problems.push(`${m[0]} is in no result`);
  return { problems: [...new Set(problems)], answer };
}
