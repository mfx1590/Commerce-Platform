#!/usr/bin/env node
/**
 * Prints what the storefront perf gate actually measured — on success as well as failure (Refs #348).
 *
 *   node infra/ci/lighthouse-summary.mjs <storefront-dir>
 *
 * Lighthouse CI prints a metric only when its assertion FAILS: a green leg logs "All results processed!"
 * and nothing else, so a budget can sit 5 ms or 500 ms under its line and the log looks the same. That is
 * how brand A's listing-page LCP turned out to live on its 2500 ms budget (~1 failure in 20 runs) without
 * anyone being able to say so from CI. This reads the run's own `.lighthouseci/lhr-*.json` and the
 * storefront's `lighthouserc.json` and prints, per URL and per assertion:
 *
 *   - every run's value, and the runner's CPU benchmark per run (simulated throttling scales by it);
 *   - the value the assertion COMPARED, using the same aggregation LHCI uses: `optimistic` (the default)
 *     takes the best run — the lowest for a `max*` budget, the highest for a `min*` one; `pessimistic` the
 *     worst; `median` / `median-run` the median;
 *   - the budget and the margin to it.
 *
 * It is a witness, never a gate: it exits 0 whatever it finds (the gate is scripts/perf.mjs). With
 * $GITHUB_STEP_SUMMARY set, the same table goes to the job summary.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The value LHCI compares for one assertion, from the runs' values. */
export function aggregate(values, method, kind) {
  const xs = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!xs.length) return undefined;
  const best = kind === 'max' ? xs[0] : xs[xs.length - 1];
  const worst = kind === 'max' ? xs[xs.length - 1] : xs[0];
  if (method === 'pessimistic') return worst;
  if (method === 'median' || method === 'median-run') {
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }
  return best; // 'optimistic', LHCI's default
}

/** The assertions in a lighthouserc that compare a number: [{ id, level, kind, budget, method }]. */
export function numericAssertions(rc) {
  const out = [];
  for (const [id, spec] of Object.entries(rc?.ci?.assert?.assertions ?? {})) {
    const [level, opts = {}] = Array.isArray(spec) ? spec : [spec];
    if (level === 'off') continue;
    const method = opts.aggregationMethod ?? 'optimistic';
    if (opts.maxNumericValue !== undefined)
      out.push({ id, level, kind: 'max', budget: opts.maxNumericValue, method });
    if (opts.minScore !== undefined)
      out.push({ id, level, kind: 'min', budget: opts.minScore, method });
  }
  return out;
}

/** One run's value for an assertion id: a category score or an audit's numeric value. */
export function valueOf(lhr, id, kind) {
  if (id.startsWith('categories:'))
    return lhr.categories?.[id.slice('categories:'.length)]?.score ?? undefined;
  const audit = lhr.audits?.[id];
  if (!audit) return undefined;
  return kind === 'min' ? audit.score : audit.numericValue;
}

/** Rows per URL: { url, benchmarks, rows: [{ id, level, method, budget, kind, values, asserted, margin, pass }] }. */
export function summarise(lhrs, rc) {
  const assertions = numericAssertions(rc);
  const byUrl = new Map();
  for (const lhr of lhrs) {
    const url = lhr.requestedUrl ?? lhr.finalDisplayedUrl ?? lhr.finalUrl;
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(lhr);
  }
  return [...byUrl].map(([url, runs]) => {
    runs.sort((a, b) => String(a.fetchTime).localeCompare(String(b.fetchTime)));
    return {
      url,
      benchmarks: runs.map((r) => r.environment?.benchmarkIndex),
      rows: assertions.map((a) => {
        const values = runs.map((r) => valueOf(r, a.id, a.kind));
        const asserted = aggregate(values, a.method, a.kind);
        const margin =
          asserted === undefined
            ? undefined
            : a.kind === 'max'
              ? asserted - a.budget
              : a.budget - asserted;
        return {
          ...a,
          values,
          asserted,
          margin,
          pass: margin === undefined ? undefined : margin <= 0,
        };
      }),
    };
  });
}

const fmt = (v, kind) =>
  v === undefined
    ? '—'
    : kind === 'min' || Math.abs(v) < 1
      ? String(Math.round(v * 1000) / 1000)
      : String(Math.round(v));

export function render(summary, app) {
  const lines = [
    `== Lighthouse, as measured (${app}): every run, and the value each assertion compared`,
  ];
  const md = [`### Lighthouse, as measured — \`${app}\``, ''];
  for (const { url, benchmarks, rows } of summary) {
    const path = url.replace(/^https?:\/\/[^/]+/, '') || '/';
    lines.push(`-- ${path}   CPU benchmark per run: ${benchmarks.map((b) => fmt(b)).join(' · ')}`);
    md.push(
      `**${path}** — CPU benchmark per run: ${benchmarks.map((b) => fmt(b)).join(' · ')}`,
      '',
    );
    md.push(
      '| assertion | runs | compared (aggregation) | budget | margin | |',
      '|---|---|---|---|---|---|',
    );
    for (const r of rows) {
      const runs = r.values.map((v) => fmt(v, r.kind)).join(' · ');
      const verdict =
        r.pass === undefined ? '?' : r.pass ? 'pass' : r.level === 'warn' ? 'WARN' : 'FAIL';
      const margin =
        r.margin === undefined ? '—' : `${r.margin > 0 ? '+' : ''}${fmt(r.margin, r.kind)}`;
      const budget = `${r.kind === 'max' ? '<=' : '>='} ${r.budget}`;
      lines.push(
        `   ${r.id.padEnd(26)} runs ${runs.padEnd(24)} compared ${fmt(r.asserted, r.kind).padEnd(7)} (${r.method}) budget ${budget.padEnd(8)} margin ${margin.padEnd(7)} ${verdict}`,
      );
      md.push(
        `| ${r.id} | ${runs} | ${fmt(r.asserted, r.kind)} (${r.method}) | ${budget} | ${margin} | ${verdict} |`,
      );
    }
    md.push('');
  }
  lines.push('   (margin > 0 is over budget; optimistic = best run, pessimistic = worst run)');
  return { text: lines.join('\n'), markdown: md.join('\n') };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const app = process.argv[2];
  try {
    const dir = join(app, '.lighthouseci');
    if (!app || !existsSync(dir)) {
      console.info(`lighthouse-summary: no ${dir} — Lighthouse did not run`);
      process.exit(0);
    }
    const lhrs = readdirSync(dir)
      .filter((f) => f.startsWith('lhr-') && f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    const rc = JSON.parse(readFileSync(join(app, 'lighthouserc.json'), 'utf8'));
    const { text, markdown } = render(summarise(lhrs, rc), app);
    console.info(text);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  } catch (error) {
    console.warn(
      `lighthouse-summary: could not summarise (${error.message}) — the gate's result stands`,
    );
  }
  process.exit(0);
}
