// The golden questions against the REAL model (#606 acceptance: "a real-model run once the owner provides a key").
// Opt-in (golden.test.ts: AI_REAL_MODEL=1 with the machine and the key): the model chooses its own queries, so the
// scripted expectations that pin WHICH queries ran do not apply; what must hold for any model does:
//   * no unexpected error (a question the scope refuses before the model — store B in the body — still refuses);
//   * no row of a store outside the asker's scope; an analyst never gets a finance figure;
//   * every citation resolves; every figure in the answer is in some result (money in major units with 2 decimals,
//     counts as integers, rates also as a percentage) — thousands separators and ISO dates are not figures.
import { AppError } from '../../../../lib/errors';
import { METRICS, type MetricId } from '../../metrics/catalogue';
import type { MetricResult, MetricsReader } from '../../metrics/execute';
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
 * Nor are uuids (a store's id quoted from <stores>) or a year-less date of two two-digit parts that is a valid month
 * and day either way round (09-28, 28/09, 10/31 — the re-run of 2026-11-02, #18 and #8); "5-10" or "13-14" stay
 * figures, so nothing that could be a count is waved through.
 */
export function figuresOf(text: string): string[] {
  let clean = text
    .replace(/\[q\d+\]/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(\d{2})[-/](\d{2})\b/g, (span, a: string, b: string) =>
      isMonthDay(Number(a), Number(b)) || isMonthDay(Number(b), Number(a)) ? ' ' : span,
    );
  // a day list or range attached to a month: "Oct 1, 2 and 3", "1–31 October", "Week of 28 Sep"
  clean = clean
    .replace(
      new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:\\s*(?:,|and|–|-|to)\\s*\\d{1,2}\\b)*`, 'gi'),
      ' ',
    )
    .replace(new RegExp(`\\b\\d{1,2}(?:\\s*(?:–|-|to)\\s*\\d{1,2})?\\s+${MONTH}`, 'gi'), ' ');
  // each number on its own (#683 review): 1.250.000,00 and 1,250,000.00 alike; one that reads no way is kept as its
  // digit runs, which no result backs — a failure, never a pass
  return [...clean.matchAll(NUMBER)].flatMap((m) => {
    const n = splitNumber(m[0]);
    return n ? [n.dec ? `${n.int}.${n.dec}` : n.int] : m[0].split(/[.,]/);
  });
}

const isMonthDay = (month: number, day: number) =>
  month >= 1 && month <= 12 && day >= 1 && day <= 31;

/** a number as written: digits with `.` / `,` inside, never at an end (a sentence's full stop is not part of it) */
const NUMBER = /\d[\d.,]*\d|\d/g;

/**
 * One written number → its integer and decimal digits. Both separators: the LAST is the decimal one and the other
 * must group thousands (1,234.56 · 1.234,56 · 1.250.000,00). One kind only: groups of exactly three after the first
 * are thousands (1,234 · 1.234 · 1.250.000 — no answer shows 3 decimals: money and rates have 2, counts none),
 * anything else a single decimal separator (583,41 · 2.5). Otherwise unreadable.
 */
function splitNumber(t: string): { int: string; dec: string } | null {
  const dot = t.includes('.');
  const comma = t.includes(',');
  if (dot && comma) {
    const decimal = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    const [int, dec, ...more] = t.split(decimal);
    if (more.length > 0 || !/^\d+$/.test(dec!)) return null;
    if (!new RegExp(`^\\d{1,3}(?:\\${thousands}\\d{3})*$`).test(int!)) return null;
    return { int: int!.split(thousands).join(''), dec: dec! };
  }
  if (!dot && !comma) return { int: t, dec: '' };
  const sep = dot ? '.' : ',';
  if (new RegExp(`^\\d{1,3}(?:\\${sep}\\d{3})+$`).test(t))
    return { int: t.split(sep).join(''), dec: '' };
  const m = /^(\d+)[.,](\d+)$/.exec(t);
  return m ? { int: m[1]!, dec: m[2]! } : null;
}

/** a figure is backed when a result holds it: as written, with 2 decimals, or as the same number */
function isBacked(f: string, backed: ReadonlySet<string>): boolean {
  return (
    backed.has(f) ||
    backed.has(Number(f).toFixed(2)) ||
    [...backed].some((b) => Number(b) === Number(f))
  );
}

/** A value a result holds, in hundredths of how it is written, with what it measures. */
export interface ResultValue {
  hundredths: bigint;
  /** the row's or total's currency for money; null for anything else */
  currency: string | null;
  /** money (major units, 2 decimals), a count, a rate as basis points or as a percentage */
  unit: 'money' | 'count' | 'bp' | 'percent';
}

/** Every value a result holds (rows and currency totals), signed, with its currency and unit — from the DATA. */
export function resultValues(result: MetricResult, metrics: readonly MetricId[]): ResultValue[] {
  const out: ResultValue[] = [];
  const add = (m: MetricId, v: number | null | undefined, currency: string | null) => {
    if (v === null || v === undefined || !Number.isInteger(v)) return;
    const unit = METRICS[m]?.unit;
    const n = BigInt(v);
    if (unit === 'minor') out.push({ hundredths: n, currency, unit: 'money' });
    else if (unit === 'count') out.push({ hundredths: n * 100n, currency: null, unit: 'count' });
    else if (unit === 'bp') {
      out.push({ hundredths: n * 100n, currency: null, unit: 'bp' });
      out.push({ hundredths: n, currency: null, unit: 'percent' }); // 2049 bp = 20.49 %
    }
  };
  for (const r of result.rows) for (const m of metrics) add(m, r.values[m], r.currency);
  for (const t of result.currency_totals) for (const m of metrics) add(m, t.values[m], t.currency);
  return out;
}

/** A figure as written (a leading − or -, either notation) → signed hundredths; null with more than 2 decimals. */
function hundredthsOf(written: string): bigint | null {
  const negative = /^[−-]/.test(written);
  const n = splitNumber(written.replace(/^[−-]/, ''));
  if (!n || n.dec.length > 2) return null;
  const h = BigInt(n.int) * 100n + BigInt(n.dec.padEnd(2, '0'));
  return negative ? -h : h;
}

/** |n| / |d| rounded half-up on integers, with the sign of n / d */
function divideHalfUp(n: bigint, d: bigint): bigint {
  const negative = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const q = (2n * a + b) / (2n * b);
  return negative ? -q : q;
}

const show = (h: bigint) => {
  const a = h < 0n ? -h : h;
  return `${h < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
const what = (v: ResultValue) => (v.unit === 'money' ? `${v.currency ?? '?'} money` : v.unit);

const NUM = '[−-]?(?:\\d[\\d.,]*\\d|\\d)';
const CUR = '(?:\\s*([A-Z]{3}))?';
/**
 * bi-qa-answer@2 / @3's ONE labelled derived figure: `x CUR (derived: a CUR [qi] − b CUR [qj])` (+ for a sum) or
 * `x (derived: a [qi] / b [qj])` for a ratio.
 */
const DERIVED = new RegExp(
  `(${NUM})${CUR}\\s*\\(derived:\\s*(${NUM})${CUR}\\s*\\[q(\\d+)\\]\\s*([−+/-])\\s*(${NUM})${CUR}\\s*\\[q(\\d+)\\]\\s*\\)`,
  'g',
);

/**
 * The net for a wrong derived figure (#683 review: it must never pass one). At most ONE derived figure per answer,
 * and only in the template's form. Each input, SIGNED, must be a value of the result it cites; its currency and unit
 * come from that result, and a written currency label must agree with them. A difference or sum needs two inputs of
 * the same unit and currency (money or counts) and must be exact in hundredths; a ratio is |a| / |b| half-up to 2
 * decimals with the sign of a / b, on integer hundredths (BigInt) — no floating point anywhere. Returns the problems
 * and the text with each derived span blanked, so the every-figure check does not read a derived value (in no result
 * by design) as unbacked.
 */
export function checkDerived(
  text: string,
  valuesFor: (ref: number) => readonly ResultValue[] | undefined,
): { problems: string[]; rest: string } {
  const problems: string[] = [];
  const spans = [...text.matchAll(DERIVED)];
  const labelled = [...text.matchAll(/\(derived:/g)].length;
  if (labelled > 1) problems.push(`${labelled} derived figures (at most one)`);
  if (labelled > spans.length)
    problems.push('a derived figure not in the form "x (derived: a [qi] op b [qj])"');

  for (const [, x, cx, a, ca, qi, op, b, cb, qj] of spans) {
    const [hx, ha, hb] = [hundredthsOf(x!), hundredthsOf(a!), hundredthsOf(b!)];
    const unreadable = (
      [
        [x, hx],
        [a, ha],
        [b, hb],
      ] as const
    ).filter(([, h]) => h === null);
    for (const [f] of unreadable)
      problems.push(`derived figure ${f} has more than 2 decimals or does not read`);
    if (unreadable.length > 0) continue;

    // each input: the values of the cited result equal to it (signed), narrowed by a written currency label
    const inputs = (
      [
        [a!, ha!, ca, Number(qi)],
        [b!, hb!, cb, Number(qj)],
      ] as const
    ).map(([f, h, label, q]) => {
      const held = (valuesFor(q) ?? []).filter((v) => v.hundredths === h);
      if (held.length === 0) {
        problems.push(`derived input ${f} is not in [q${q}]`);
        return null;
      }
      if (label === undefined) return held;
      const agree = held.filter((v) => v.unit === 'money' && v.currency === label);
      if (agree.length === 0) {
        problems.push(
          `derived input ${f} is labelled ${label}; [q${q}] holds it as ${what(held[0]!)}`,
        );
        return null;
      }
      return agree;
    });
    const [va, vb] = inputs;
    if (!va || !vb) continue;

    if (op === '/') {
      if (cx !== undefined) problems.push(`derived ratio ${x} carries a currency (${cx})`);
      if (hb === 0n) {
        problems.push(`derived ${x} divides by zero`);
        continue;
      }
      const ratio = divideHalfUp(ha! * 100n, hb!);
      if (hx !== ratio) problems.push(`derived ${x} ≠ ${a} / ${b} (${show(ratio)})`);
      continue;
    }
    // a difference or a sum: two amounts of one currency, or two counts
    const pair = va.flatMap((p) =>
      vb.filter(
        (q) =>
          p.unit === q.unit &&
          p.currency === q.currency &&
          (p.unit === 'money' || p.unit === 'count'),
      ),
    );
    if (pair.length === 0) {
      problems.push(`derived ${x} combines ${what(va[0]!)} with ${what(vb[0]!)}`);
      continue;
    }
    if (cx !== undefined && !pair.some((p) => p.unit === 'money' && p.currency === cx))
      problems.push(`derived ${x} is labelled ${cx}; its inputs are ${what(pair[0]!)}`);
    const value = op === '+' ? ha! + hb! : ha! - hb!;
    if (hx !== value) problems.push(`derived ${x} ≠ ${a} ${op} ${b} (${show(value)})`);
  }
  return { problems, rest: text.replace(DERIVED, (span) => ' '.repeat(span.length)) };
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
  // a labelled derived figure (bi-qa-answer@2 / @3) is recomputed from the two results it cites
  const derived = checkDerived(answer.answer, (ref) => {
    const x = answer.queries[ref - 1];
    return x?.result ? resultValues(x.result, x.query.metrics) : undefined;
  });
  out.problems.push(...derived.problems);
  // integers also match a money figure written without decimals, and small integers the question itself names
  const asked = new Set(figuresOf(c.question));
  for (const f of figuresOf(derived.rest))
    if (!isBacked(f, backed) && !asked.has(f)) out.problems.push(`${f} is in no result`);
  out.problems = [...new Set(out.problems)];
  return out;
}
