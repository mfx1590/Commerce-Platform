#!/usr/bin/env node
/**
 * The scheduled k6 SLO regression's judge (plan wave 3; .github/workflows/load.yml).
 *
 *   node infra/load/slo-gate.mjs verdict <run-dir>
 *       exit 0 = within the SLOs, 1 = a gate crossed (k6 exit 99), 2 = the run itself broke (no answer)
 *   node infra/load/slo-gate.mjs render <out-dir> <run-url> <pass-1-dir> [<pass-2-dir>]
 *       writes <out-dir>/tracking.md (one comment per scheduled run), <out-dir>/issue.md (the regression issue's
 *       body) and <out-dir>/verdict.txt (pass | retried | breach)
 *
 * A run dir is what infra/load/run.sh writes: load.exit (k6's exit code), load-summary.json and run.exit (run.sh's
 * own exit code, from its EXIT trap). A breach counts only when the second pass breaches too (runner noise is real).
 * A first-pass breach that the second pass clears is printed, never hidden: "retried".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BROWSE_ROUTES,
  CHECKOUT_ROUTE,
  FACTOR,
  METRICS_ROUTES,
  routeP95Ms,
  SLO,
} from './k6/slo-thresholds.js';
import { crossedThresholds, ROUTE_LABEL, routeStats } from './report.mjs';

export const ISSUE_TITLE = 'load regression (scheduled k6)';
export const TRACKING_TITLE = 'load: weekly SLO regression tracking (scheduled k6)';

/** One pass: 'pass' | 'breach' | 'broken', with what k6 reported. */
export function readPass(dir) {
  // run.sh never started: a setup step before pass 1 failed (load.yml renders the gate anyway, so the schedule still
  // comments). Infrastructure, never a regression.
  if (!dir || !existsSync(dir))
    return {
      state: 'broken',
      reason: 'this pass never ran: a setup step before it failed (see the run log)',
    };
  const exitFile = join(dir, 'load.exit');
  const summaryFile = join(dir, 'load-summary.json');
  if (!existsSync(exitFile) || !existsSync(summaryFile))
    return { state: 'broken', reason: 'no load.exit or load-summary.json' };
  const code = Number(readFileSync(exitFile, 'utf8').trim());
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  const routes = routeStats(summary);
  // run.sh records whether the admin-metrics leg ran (LOAD_METRICS=1, #785); then its routes are SLO routes too.
  const metaFile = join(dir, 'meta.json');
  const metrics =
    existsSync(metaFile) && JSON.parse(readFileSync(metaFile, 'utf8')).metrics === true;
  // A k6 threshold on a tag that never occurred passes vacuously: an SLO route with no requests judged nothing.
  const required = [...BROWSE_ROUTES, CHECKOUT_ROUTE, ...(metrics ? METRICS_ROUTES : [])];
  const unmeasured = required.filter((r) => !(routes[r]?.count > 0));
  const crossed = crossedThresholds(summary);
  if (code !== 0 && code !== 99)
    return {
      state: 'broken',
      code,
      summary,
      crossed,
      routes,
      metrics,
      reason: `k6 exited ${code}`,
    };
  // run.sh's own exit code (its EXIT trap writes run.exit). k6 can write a passing summary and run.sh still fail after
  // it (a later k6 phase, the report, the stack's stop): the step is red, so the verdict must not be "within the
  // SLOs". A missing run.exit means run.sh was killed before its trap ran (a step timeout, a cancel).
  const runExitFile = join(dir, 'run.exit');
  const runCode = existsSync(runExitFile)
    ? Number(readFileSync(runExitFile, 'utf8').trim())
    : undefined;
  if (runCode !== 0)
    return {
      state: 'broken',
      code,
      summary,
      crossed,
      routes,
      metrics,
      reason:
        runCode === undefined
          ? `run.sh did not finish (killed or timed out after k6 exited ${code}): see the run log`
          : `run.sh exited ${runCode} after k6 finished (k6 exited ${code}): a later phase or the report failed, see the run log`,
    };
  if (unmeasured.length)
    return {
      state: 'broken',
      code,
      summary,
      crossed,
      routes,
      metrics,
      reason: `no requests on ${unmeasured.join(', ')}`,
    };
  return { state: code === 0 ? 'pass' : 'breach', code, summary, crossed, routes, metrics };
}

/**
 * pass, retried (pass 1 breached, pass 2 cleared), breach (both breached), or broken: either pass could not be
 * judged (k6 crashed, the run broke, an SLO route had no requests). broken is infrastructure, not a regression: the
 * run fails, and no regression issue is written for it.
 */
export function overall(p1, p2) {
  if (p1.state === 'pass') return 'pass';
  if (p1.state === 'breach' && p2?.state === 'pass') return 'retried';
  if (p1.state === 'breach' && p2?.state === 'breach') return 'breach';
  return 'broken';
}

const ms = (v) => (v === undefined || v === null ? '—' : `${Math.round(v)} ms`);
const pct = (v) => (v === undefined || v === null ? '—' : `${(v * 100).toFixed(3)}%`);
const rate = (p, metric) => p?.summary?.metrics?.[metric]?.values?.rate;

const HEADLINE = {
  pass: '✅ within the SLOs',
  retried:
    '⚠️ **the retry fired**: pass 1 crossed a gate, pass 2 did not, so no regression is recorded. A flaky first pass is shown, not hidden',
  breach: '❌ **confirmed breach**: both passes crossed an SLO gate',
  broken:
    '💥 **infrastructure, not a regression**: a pass could not be judged, so the run fails, but no regression issue is written',
};

export function table(p1, p2) {
  const rows = [
    `| | SLO gate | pass 1 | ${p2 ? 'pass 2 |' : ''}`,
    `|---|---|---|${p2 ? '---|' : ''}`,
  ];
  const withMetrics = Boolean(p1.metrics || p2?.metrics);
  const caveat = (r) =>
    r === CHECKOUT_ROUTE
      ? ' (lower bound: manual payment provider)'
      : METRICS_ROUTES.includes(r)
        ? ' (small data: a lower bound)'
        : '';
  for (const r of [...BROWSE_ROUTES, CHECKOUT_ROUTE, ...(withMetrics ? METRICS_ROUTES : [])]) {
    const gate = `p95 < ${routeP95Ms(r)} ms${caveat(r)}`;
    rows.push(
      `| ${ROUTE_LABEL[r]} | ${gate} | ${ms(p1.routes?.[r]?.p95)} | ${p2 ? `${ms(p2.routes?.[r]?.p95)} |` : ''}`,
    );
  }
  rows.push(
    `| failed requests | < ${pct(SLO.errorRate)} | ${pct(rate(p1, 'http_req_failed'))} | ${p2 ? `${pct(rate(p2, 'http_req_failed'))} |` : ''}`,
  );
  rows.push(
    `| failed placements | < ${pct(SLO.errorRate)} | ${pct(rate(p1, 'placement_failed'))} | ${p2 ? `${pct(rate(p2, 'placement_failed'))} |` : ''}`,
  );
  return rows.join('\n');
}

/** The ClickHouse seed next to the metrics gate (#785): how little data the 300 ms was measured on. */
export function seedLine(seed) {
  if (!seed) return '';
  const stores = Object.entries(seed.perStore ?? {})
    .map(([id, n]) => `\`${id}\`: ${n}`)
    .join(', ');
  return `\n\nClickHouse seed for the admin-metrics rows: ${seed.events} events from ${seed.months} generated month(s) (${seed.firstDay} … ${seed.lastDay}); per store: ${stores}. **Small data: the 300 ms gate is a lower bound.**`;
}

export function render({ runUrl, date, p1, p2, seed }) {
  const v = overall(p1, p2);
  const reasons = [p1, p2]
    .map((p, i) => (p?.reason ? `- pass ${i + 1} could not be judged: ${p.reason}` : null))
    .filter(Boolean)
    .join('\n');
  const crossed = [p1, p2]
    .map((p, i) =>
      p?.crossed?.length
        ? `- pass ${i + 1} crossed: ${p.crossed.map((c) => `\`${c}\``).join(', ')}`
        : null,
    )
    .filter(Boolean)
    .join('\n');
  const seeded = p1.metrics || p2?.metrics ? seedLine(seed) : '';
  const factor =
    FACTOR === 1
      ? ''
      : `\n\n> LOAD_THRESHOLD_FACTOR=${FACTOR}: the latency gates were scaled on purpose (a breach-path test).`;
  const tracking = `### Scheduled k6 SLO regression, ${date} ([run](${runUrl}))\n\n${HEADLINE[v]}.${factor}\n\n${table(p1, p2)}${seeded}${reasons ? `\n\n${reasons}` : ''}${crossed ? `\n\n${crossed}` : ''}\n`;
  const issue = `A scheduled k6 SLO regression run crossed an SLO gate on BOTH passes (${date}, [run](${runUrl})).\n\n${table(p1, p2)}${seeded}\n\n${crossed}${factor}\n\nThe gates are the SLOs (infra/load/k6/slo-thresholds.js = infra/observability/rules/slo.mjs; SLO.md has the prose). The run is the owner's target (50 browse req/s + 30 orders/min, 10 min) on a fresh core and database on a GitHub runner, so compare with the last green week in the tracking issue before blaming the code. The job's artifact has the full report (report.md) and the Postgres samples.\n`;
  return { verdict: v, tracking, issue };
}

function main([cmd, ...args]) {
  if (cmd === 'verdict') {
    const p = readPass(args[0]);
    console.info(
      `slo-gate: ${args[0]}: ${p.state}${p.reason ? ` (${p.reason})` : ''}${p.crossed?.length ? ` (crossed: ${p.crossed.join('; ')})` : ''}`,
    );
    process.exit(p.state === 'pass' ? 0 : p.state === 'breach' ? 1 : 2);
  }
  if (cmd === 'render') {
    const [out, runUrl, d1, d2] = args;
    const p1 = readPass(d1);
    let p2 = d2 && existsSync(d2) ? readPass(d2) : undefined;
    // pass 1 breached but there is no pass 2: the step that runs it failed or timed out. Say so, rather than a bare
    // "could not be judged" with no pass named (#813 review).
    if (p1.state === 'breach' && !p2)
      p2 = {
        state: 'broken',
        reason: 'pass 2 never ran: its step failed or timed out (see the run log)',
      };
    const seedFile = process.env.LOAD_CH_SEED;
    const seed =
      seedFile && existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, 'utf8')) : undefined;
    const r = render({ runUrl, date: new Date().toISOString().slice(0, 10), p1, p2, seed });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'tracking.md'), r.tracking);
    writeFileSync(join(out, 'issue.md'), r.issue);
    writeFileSync(join(out, 'verdict.txt'), `${r.verdict}\n`);
    console.info(`slo-gate: ${r.verdict}`);
    return;
  }
  console.error(
    'usage: slo-gate.mjs verdict <run-dir> | render <out-dir> <run-url> <pass-1-dir> [<pass-2-dir>]',
  );
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
