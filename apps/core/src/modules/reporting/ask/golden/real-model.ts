// The golden questions against the REAL model (#606 acceptance: "a real-model run once the owner provides a key").
// Opt-in (golden.test.ts: AI_REAL_MODEL=1 with the machine and the key): the model chooses its own queries, so the
// scripted expectations that pin WHICH queries ran do not apply; what must hold for any model does:
//   * no unexpected error (a question the scope refuses before the model — store B in the body — still refuses);
//   * no row of a store outside the asker's scope; an analyst never gets a finance figure;
//   * every citation resolves; every figure in the answer is in some result (money in major units with 2 decimals,
//     counts as integers, rates also as a percentage) — thousands separators and ISO dates are not figures.
import { AppError } from '../../../../lib/errors';
import { METRICS } from '../../metrics/catalogue';
import type { MetricsReader } from '../../metrics/execute';
import { askMetrics, type MetricAnswer } from '../ask';
import type { GatewayFactory } from '../gateway';
import type { GoldenCase, GoldenEnv } from './cases';
import { backedValues, callerFor, type GoldenStores } from './run';

export interface RealOutcome {
  id: number;
  question: string;
  problems: string[];
  /** queries that ran / were refused, for the report */
  ran: number;
  refused: number;
  answer?: string;
  error?: string;
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';

/**
 * The figures of an answer — what must be backed by a result. Not figures: the citations, ISO dates and timestamps,
 * years, and days of the month next to a month name ("Oct 3", "3 Oct", "1–31 October", "Oct 1, 2 and 3:" — a real
 * model writes dates in prose; the first real-model run, 2026-11-02, flagged 13 correct answers on dates alone).
 * Thousands separators (1,234.56) are dropped; a decimal comma (1.234,56 — an answer in another language) is read.
 */
export function figuresOf(text: string): string[] {
  let clean = text
    .replace(/\[q\d+\]/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ');
  // a day list or range attached to a month: "Oct 1, 2 and 3", "1–31 October", "Week of 28 Sep"
  clean = clean
    .replace(
      new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:\\s*(?:,|and|–|-|to)\\s*\\d{1,2}\\b)*`, 'gi'),
      ' ',
    )
    .replace(new RegExp(`\\b\\d{1,2}(?:\\s*(?:–|-|to)\\s*\\d{1,2})?\\s+${MONTH}`, 'gi'), ' ');
  clean = clean
    .replace(/(\d)\.(\d{3}),(\d{2})\b/g, '$1$2.$3') // 44.922,65 → 44922.65
    .replace(/(\d),(\d{2})\b(?!\d)/g, '$1.$2') // 583,41 → 583.41
    .replace(/(\d),(?=\d{3}\b)/g, '$1'); // 44,922.65 → 44922.65
  return [...clean.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

/** a figure is backed when a result holds it: as written, with 2 decimals, or as the same number */
function isBacked(f: string, backed: ReadonlySet<string>): boolean {
  return (
    backed.has(f) ||
    backed.has(Number(f).toFixed(2)) ||
    [...backed].some((b) => Number(b) === Number(f))
  );
}

/** one figure as written (either decimal notation, a leading − or -) → its value */
function valueOf(written: string): number {
  const f = figuresOf(written)[0];
  if (f === undefined) return NaN;
  return /^\s*[−-]/.test(written) ? -Number(f) : Number(f);
}

const NUM = '[−-]?\\d[\\d.,]*\\d|[−-]?\\d';
const CUR = '(?:\\s*([A-Z]{3}))?';
/**
 * bi-qa-answer@2's ONE labelled derived figure: `x CUR (derived: a CUR [qi] − b CUR [qj])` (+ for a sum) or
 * `x (derived: a [qi] / b [qj])` for a ratio.
 */
const DERIVED = new RegExp(
  `(${NUM})${CUR}\\s*\\(derived:\\s*(${NUM})${CUR}\\s*\\[q(\\d+)\\]\\s*([−+/-])\\s*(${NUM})${CUR}\\s*\\[q(\\d+)\\]\\s*\\)`,
  'g',
);

/**
 * Checks every labelled derived figure: each input must be in the result it cites, a sum or difference needs one
 * currency, and the stated value must be the recomputed one — sums and differences exactly (in hundredths, i.e.
 * minor units), a ratio rounded half-up to 2 decimals. Returns the problems and the text with each derived span
 * blanked, so the every-figure check does not read a correct derived value (in no result by design) as unbacked.
 */
export function checkDerived(
  text: string,
  backedFor: (ref: number) => ReadonlySet<string> | undefined,
): { problems: string[]; rest: string } {
  const problems: string[] = [];
  const rest = text.replace(
    DERIVED,
    (
      span,
      x: string,
      cx: string | undefined,
      a: string,
      ca: string | undefined,
      qi: string,
      op: string,
      b: string,
      cb: string | undefined,
      qj: string,
    ) => {
      for (const [f, q] of [
        [a, qi],
        [b, qj],
      ] as const) {
        const backed = backedFor(Number(q));
        const v = Math.abs(valueOf(f));
        if (!backed || !isBacked(String(v), backed))
          problems.push(`derived input ${f} is not in [q${q}]`);
      }
      const [vx, va, vb] = [valueOf(x), valueOf(a), valueOf(b)];
      if (op === '/') {
        const ratio = vb === 0 ? NaN : Math.floor((va / vb) * 100 + 0.5 + 1e-9) / 100;
        if (Number.isNaN(ratio) || Math.round(vx * 100) !== Math.round(ratio * 100))
          problems.push(
            `derived ${x} ≠ ${a} / ${b} (${Number.isNaN(ratio) ? 'undefined' : ratio.toFixed(2)})`,
          );
      } else {
        const currencies = new Set([cx, ca, cb].filter((c) => c !== undefined));
        if (currencies.size > 1)
          problems.push(`derived ${x} mixes currencies: ${[...currencies].join(', ')}`);
        const cents = Math.round(va * 100) + (op === '+' ? 1 : -1) * Math.round(vb * 100);
        if (Math.round(vx * 100) !== cents)
          problems.push(`derived ${x} ≠ ${a} ${op} ${b} (${(cents / 100).toFixed(2)})`);
      }
      return ' '.repeat(span.length);
    },
  );
  return { problems, rest };
}

export async function runRealCase(
  c: GoldenCase,
  env: GoldenEnv,
  stores: GoldenStores,
  reader: MetricsReader,
  gatewayFor: GatewayFactory,
  modelCalls: () => number,
): Promise<RealOutcome> {
  const out: RealOutcome = { id: c.id, question: c.question, problems: [], ran: 0, refused: 0 };
  const caller = callerFor(c.principal, stores);
  let answer: MetricAnswer;
  try {
    answer = await askMetrics(
      {
        reader,
        gatewayFor,
        biQaSwitches: async () => new Map(),
        now: () => new Date('2026-10-31T12:00:00Z'),
      },
      caller,
      { question: c.question, ...(c.storeIds ? { store_ids: c.storeIds(env) } : {}) },
    );
  } catch (err) {
    out.error = err instanceof AppError ? err.code : (err as Error).name;
    const expected = 'error' in c.expect ? c.expect.error : undefined;
    // the loop cap is the model's choice: a real model may well answer case 26 within the cap
    if (expected === 'ai_tool_limit' && out.error === 'ai_tool_limit') return out;
    if (expected !== out.error)
      out.problems.push(`unexpected ${out.error}: ${(err as Error).message}`);
    if (expected === 'forbidden' && modelCalls() > 0)
      out.problems.push('a model call before the 403');
    return out;
  }
  if ('error' in c.expect && c.expect.error === 'forbidden')
    out.problems.push('expected the scope to refuse before the model, got an answer');
  out.answer = answer.answer;
  const ran = answer.queries.filter((x) => x.result !== undefined);
  out.ran = ran.length;
  out.refused = answer.queries.length - ran.length;

  const allowed = new Set(caller.stores.map((s) => s.id));
  for (const x of ran) {
    for (const r of x.result!.rows)
      if (r.store_id !== null && !allowed.has(r.store_id))
        out.problems.push(`a row of store ${r.store_id}`);
    if (!caller.finance && x.query.metrics.some((m) => METRICS[m].finance))
      out.problems.push(
        `a finance metric ran for a principal without finance: ${x.query.metrics.join(',')}`,
      );
  }
  for (const m of answer.answer.matchAll(/\[q(\d+)\]/g))
    if (!answer.queries[Number(m[1]) - 1]?.result) out.problems.push(`[q${m[1]}] cites no result`);
  const backed = new Set(ran.flatMap((x) => [...backedValues(x.result!, x.query.metrics)]));
  // a labelled derived figure (bi-qa-answer@2) is recomputed from the two results it cites
  const derived = checkDerived(answer.answer, (ref) => {
    const x = answer.queries[ref - 1];
    return x?.result ? backedValues(x.result, x.query.metrics) : undefined;
  });
  out.problems.push(...derived.problems);
  // integers also match a money figure written without decimals, and small integers the question itself names
  const asked = new Set(figuresOf(c.question));
  for (const f of figuresOf(derived.rest))
    if (!isBacked(f, backed) && !asked.has(f)) out.problems.push(`${f} is in no result`);
  out.problems = [...new Set(out.problems)];
  return out;
}
