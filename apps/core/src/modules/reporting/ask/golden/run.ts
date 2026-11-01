// Plays a golden case through askMetrics with the scripted gateway and checks it (cases.ts). The final answer step
// writes the figures of the results the run actually got, in the model's style ("EUR 1234.56 [q1]"), and the checks
// hold any answer — scripted now, a real model's later — to the same rules.
import { AppError } from '../../../../lib/errors';
import { METRICS, type MetricId } from '../../metrics/catalogue';
import type { MetricResult, MetricsReader } from '../../metrics/execute';
import { askMetrics, type AskCaller, type MetricAnswer } from '../ask';
import { scriptedGateways, type ScriptStep } from '../testing/fake-gateway';
import type { GoldenCase, GoldenEnv, Principal } from './cases';

export interface GoldenStores {
  A: { id: string; code: string };
  B: { id: string; code: string };
}

export function callerFor(p: Principal, s: GoldenStores): AskCaller {
  const base = { organizationId: '00000000-0000-4000-8000-000000000001', actorId: `actor-${p}` };
  if (p === 'storeAdminA') return { ...base, stores: [s.A], finance: false };
  return { ...base, stores: [s.A, s.B], finance: p === 'finance' };
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
export function scriptFor(c: GoldenCase, env: GoldenEnv, finalText?: string): ScriptStep[] {
  return [
    ...c.calls(env).map((input): ScriptStep => ({ toolUse: [{ name: 'query_metrics', input }] })),
    (run) => ({ text: finalText ?? answerFrom(run.results) }),
  ];
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
  const gateways = scriptedGateways(scriptFor(c, env, finalText));
  let answer: MetricAnswer;
  try {
    answer = await askMetrics(
      {
        reader,
        gatewayFor: gateways,
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
      if (c.expect.error === 'forbidden' && gateways.runs.length > 0)
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
  // citations resolve, and every figure in the answer is backed by the result it cites
  for (const m of answer.answer.matchAll(/(-?\d+(?:\.\d+)?) \[q(\d+)\]/g)) {
    const x = answer.queries[Number(m[2]) - 1];
    if (!x?.result) {
      problems.push(`[q${m[2]}] cites no result`);
      continue;
    }
    if (!backedValues(x.result, x.query.metrics).has(m[1]!))
      problems.push(`${m[1]} [q${m[2]}] is not in that result`);
  }
  return { problems, answer };
}
