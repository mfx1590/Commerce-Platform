// Self-test for slo-gate.mjs (the `changes` job):  node --test infra/load/slo-gate.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { overall, readPass, render } from './slo-gate.mjs';
import { BROWSE_ROUTES, CHECKOUT_ROUTE, METRICS_ROUTES } from './k6/slo-thresholds.js';

const GATE = fileURLToPath(new URL('./slo-gate.mjs', import.meta.url));

/** A run dir as run.sh leaves it: k6's exit code + a minimal summary (complete p95 given, browse 120 ms). */
function runDir(
  code,
  {
    completeP95 = 300,
    failRate = 0,
    crossed = false,
    metricsLeg = false,
    metricsRoutes = metricsLeg,
    runExit = 0, // run.sh's own exit code (its EXIT trap); null = run.sh was killed before the trap ran
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'slo-gate-'));
  const route = (p95) => ({
    values: { count: 100, med: p95 / 2, 'p(95)': p95, 'p(99)': p95, max: p95 },
  });
  const metrics = {
    'http_req_duration{route:store}': route(120),
    'http_req_duration{route:list}': route(120),
    'http_req_duration{route:detail}': route(120),
    'http_req_duration{route:complete}': {
      ...route(completeP95),
      thresholds: { 'p(95)<2000': { ok: !crossed } },
    },
    http_req_failed: { values: { rate: failRate } },
    placement_failed: { values: { rate: 0 } },
    ...(metricsRoutes
      ? {
          'http_req_duration{route:metrics}': route(40),
          'http_req_duration{route:metrics_query}': route(55),
        }
      : {}),
  };
  // run.sh records whether the admin-metrics leg ran (#785)
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ metrics: metricsLeg }));
  writeFileSync(join(dir, 'load.exit'), `${code}\n`);
  writeFileSync(join(dir, 'load-summary.json'), JSON.stringify({ metrics }));
  if (runExit !== null) writeFileSync(join(dir, 'run.exit'), `${runExit}\n`);
  return dir;
}

test('k6 wrote a passing summary but run.sh failed after it: broken with its reason, never "within the SLOs"', () => {
  // e.g. report.mjs threw: k6 exited 0, run.sh exited 1, the pass-1 step is red
  const failedAfter = readPass(runDir(0, { runExit: 1 }));
  assert.equal(failedAfter.state, 'broken');
  assert.equal(
    failedAfter.reason,
    'run.sh exited 1 after k6 finished (k6 exited 0): a later phase or the report failed, see the run log',
  );
  assert.equal(failedAfter.routes.list.p95, 120, 'the measured numbers are still shown');
  const r = render({
    runUrl: 'https://example.invalid/run/11',
    date: '2026-11-16',
    p1: failedAfter,
  });
  assert.equal(r.verdict, 'broken');
  assert.doesNotMatch(r.tracking, /within the SLOs/);
  assert.match(r.tracking, /infrastructure, not a regression/);
  assert.match(r.tracking, /pass 1 could not be judged: run\.sh exited 1 after k6 finished/);
  assert.match(r.tracking, /\| 120 ms \|/);

  // a breach is not upgraded to a verdict either when run.sh failed after it
  assert.equal(readPass(runDir(99, { crossed: true, runExit: 2 })).state, 'broken');
  // run.sh killed before its trap ran (a step timeout): no run.exit
  const killed = readPass(runDir(0, { runExit: null }));
  assert.equal(killed.state, 'broken');
  assert.match(killed.reason, /run\.sh did not finish \(killed or timed out after k6 exited 0\)/);
  // the CLI: exit 2 (broken), so load.yml's pass-2 step does not retry it
  assert.equal(spawnSync(process.execPath, [GATE, 'verdict', runDir(0, { runExit: 1 })]).status, 2);

  // run.sh writes run.exit from its EXIT trap, as the last thing it does
  const sh = readFileSync(new URL('./run.sh', import.meta.url), 'utf8');
  assert.match(
    sh,
    /cleanup\(\) \{\n\s+local rc=\$\?\n[\s\S]*?echo "\$rc" > "\$OUT\/run\.exit"\n\}\ntrap cleanup EXIT/,
  );
});

test('verdict: k6 exit 0 = pass, 99 = breach, anything else (or no files) = broken; the CLI exits 0/1/2', () => {
  assert.equal(readPass(runDir(0)).state, 'pass');
  assert.equal(readPass(runDir(99, { crossed: true })).state, 'breach');
  assert.equal(readPass(runDir(107)).state, 'broken');
  const empty = mkdtempSync(join(tmpdir(), 'slo-gate-'));
  assert.equal(readPass(empty).state, 'broken');
  const code = (d) => spawnSync(process.execPath, [GATE, 'verdict', d]).status;
  assert.deepEqual([code(runDir(0)), code(runDir(99)), code(empty)], [0, 1, 2]);
});

test('the retry-once rule: a breach counts only when the second pass breaches too', () => {
  const pass = { state: 'pass' };
  const breach = { state: 'breach' };
  assert.equal(overall(pass), 'pass');
  assert.equal(overall(breach, pass), 'retried');
  assert.equal(overall(breach, breach), 'breach');
  assert.equal(overall(breach), 'broken', 'a breach with no second pass is not a verdict');
  assert.equal(overall({ state: 'broken' }), 'broken');
});

test('a fired retry is printed, never hidden; a confirmed breach names what crossed in both passes', () => {
  const p1 = readPass(runDir(99, { completeP95: 2600, crossed: true }));
  const retried = render({
    runUrl: 'https://example.invalid/run/1',
    date: '2026-11-16',
    p1,
    p2: readPass(runDir(0)),
  });
  assert.equal(retried.verdict, 'retried');
  assert.match(retried.tracking, /the retry fired/);
  assert.match(
    retried.tracking,
    /pass 1 crossed: `http_req_duration\{route:complete\}: p\(95\)<2000`/,
  );
  assert.match(retried.tracking, /\| pass 2 \|/);

  const p2 = readPass(runDir(99, { completeP95: 2700, crossed: true }));
  const breach = render({ runUrl: 'https://example.invalid/run/2', date: '2026-11-16', p1, p2 });
  assert.equal(breach.verdict, 'breach');
  assert.match(breach.issue, /BOTH passes/);
  assert.match(breach.issue, /pass 1 crossed/);
  assert.match(breach.issue, /pass 2 crossed/);
  assert.match(breach.issue, /2600 ms \| 2700 ms/);
  assert.match(breach.issue, /lower bound: manual payment provider/);
});

test('a scaled run renders the gates k6 actually enforced, and says they were scaled', () => {
  // The first breach proof (run 42822182902) rendered "p95 < 500 ms" next to a breach of the scaled 25 ms gate: the
  // factor reached k6 (__ENV) but not Node. The child process gets it the way the workflow step does: in its env.
  const out = mkdtempSync(join(tmpdir(), 'slo-gate-out-'));
  const r = spawnSync(
    process.execPath,
    [
      GATE,
      'render',
      out,
      'https://example.invalid/run/4',
      runDir(99, { crossed: true }),
      runDir(99, { crossed: true }),
    ],
    { encoding: 'utf8', env: { ...process.env, LOAD_THRESHOLD_FACTOR: '0.05' } },
  );
  assert.equal(r.status, 0, r.stderr);
  const tracking = readFileSync(join(out, 'tracking.md'), 'utf8');
  assert.match(tracking, /p95 < 25 ms/);
  assert.match(tracking, /p95 < 100 ms/);
  assert.doesNotMatch(tracking, /p95 < 500 ms/);
  assert.match(tracking, /LOAD_THRESHOLD_FACTOR=0\.05/);
  assert.match(readFileSync(join(out, 'issue.md'), 'utf8'), /LOAD_THRESHOLD_FACTOR=0\.05/);
});

test('(breach, then pass 2 crashes) is broken: infrastructure, never green, never a regression issue (#788 review)', () => {
  const p1 = readPass(runDir(99, { crossed: true }));
  const p2 = readPass(runDir(107)); // k6's own failure, e.g. a script exception
  assert.equal(p2.state, 'broken');
  assert.equal(p2.reason, 'k6 exited 107');
  const r = render({ runUrl: 'https://example.invalid/run/5', date: '2026-11-16', p1, p2 });
  assert.equal(r.verdict, 'broken');
  assert.match(r.tracking, /infrastructure, not a regression/);
  assert.match(r.tracking, /pass 2 could not be judged: k6 exited 107/);
  // the workflow fails the run on broken too, with its own message, and writes the regression issue only on breach
  const yml = readFileSync(new URL('../../.github/workflows/load.yml', import.meta.url), 'utf8');
  assert.match(
    yml,
    /if: steps\.gate\.outputs\.verdict == 'breach' \|\| steps\.gate\.outputs\.verdict == 'broken'/,
  );
  assert.match(yml, /infrastructure, not a regression/);
  // a broken pass 1 must reach the gate (rendered, commented on), not end the job in the pass-2 step (#801 proof)
  assert.match(yml, /if \[ "\$rc" -eq 2 \]; then echo "[^"]*"; exit 0; fi/);
  assert.doesNotMatch(yml, /if \[ "\$rc" -eq 2 \]; then[^\n]*exit 1/);
  // the issuer the core pins comes from KEYCLOAK_URL and must be the realm's frontendUrl (localhost)
  assert.match(yml, /KEYCLOAK_URL: http:\/\/localhost:8180/);
  assert.match(
    yml,
    /- name: a confirmed breach opens or updates the regression issue\n\s+if: needs\.load\.outputs\.verdict == 'breach'\n/,
  );
});

test('a setup step failed before pass 1: broken, rendered, so the schedule still comments (#801 review)', () => {
  const never = join(mkdtempSync(join(tmpdir(), 'slo-gate-')), 'pass1'); // run.sh never created it
  const p1 = readPass(never);
  assert.equal(p1.state, 'broken');
  assert.match(p1.reason, /never ran: a setup step before it failed/);
  const r = render({ runUrl: 'https://example.invalid/run/8', date: '2026-11-16', p1 });
  assert.equal(r.verdict, 'broken');
  assert.match(r.tracking, /infrastructure, not a regression/);
  assert.match(r.tracking, /pass 1 could not be judged: this pass never ran/);
  // the CLI renders it too (verdict.txt is what the issues job's `verdict != ''` reads)
  const out = mkdtempSync(join(tmpdir(), 'slo-gate-out-'));
  const c = spawnSync(
    process.execPath,
    [GATE, 'render', out, 'https://example.invalid/run/9', never],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(c.status, 0, c.stderr);
  assert.equal(readFileSync(join(out, 'verdict.txt'), 'utf8').trim(), 'broken');
  // load.yml runs the gate after a failed step (not after a cancel), and passes no input into a shell script
  const yml = readFileSync(new URL('../../.github/workflows/load.yml', import.meta.url), 'utf8');
  assert.match(yml, /- name: the SLO verdict\n\s+id: gate\n\s+if: \$\{\{ !cancelled\(\) \}\}\n/);
  // Every `run:` script (one-line, `|`, `|-`, `>`), as the key's line plus every line indented deeper: NO `${{ }}`
  // at all. Inputs, outputs and the event name reach a script through `env:`, as data (#813 review).
  const lines = yml.split('\n');
  let scripts = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:(.*)$/);
    if (!m) continue;
    scripts++;
    const indent = m[1].length;
    const body = [m[2]];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      body.push(lines[j]);
    }
    assert.doesNotMatch(
      body.join('\n'),
      /\$\{\{/,
      `load.yml:${i + 1}: a run: script interpolates \${{ }} (pass it through env:)`,
    );
  }
  assert.ok(scripts > 15, `the scan found only ${scripts} run: scripts`);
  // the passes have their own timeouts inside the job's: a step timeout fails (judged), a job timeout cancels (silent)
  assert.match(yml, /- name: pass 1 [^\n]*\n\s+timeout-minutes: \d+\n/);
  assert.match(yml, /id: pass2\n\s+timeout-minutes: \d+\n/);

  // pass 1 breached, pass 2's step failed before writing anything: broken, and the reason names pass 2
  const out2 = mkdtempSync(join(tmpdir(), 'slo-gate-out-'));
  const c2 = spawnSync(
    process.execPath,
    [
      GATE,
      'render',
      out2,
      'https://example.invalid/run/10',
      runDir(99, { crossed: true }),
      join(out2, 'pass2-never'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(c2.status, 0, c2.stderr);
  assert.equal(readFileSync(join(out2, 'verdict.txt'), 'utf8').trim(), 'broken');
  assert.match(
    readFileSync(join(out2, 'tracking.md'), 'utf8'),
    /pass 2 could not be judged: pass 2 never ran: its step failed or timed out/,
  );
  assert.match(yml, /METRICS_MONTHS: \$\{\{ inputs\.metrics_months \|\| '1' \}\}/);
});

test('an SLO route with no requests is broken, not a vacuous pass (a threshold on an absent tag passes)', () => {
  const dir = runDir(0);
  const f = join(dir, 'load-summary.json');
  const s = JSON.parse(readFileSync(f, 'utf8'));
  delete s.metrics['http_req_duration{route:complete}'];
  writeFileSync(f, JSON.stringify(s));
  const p = readPass(dir);
  assert.equal(p.state, 'broken');
  assert.equal(p.reason, 'no requests on complete');
});

test("every SLO gate's route is a route lib.js tags its requests with", () => {
  const lib = readFileSync(new URL('./k6/lib.js', import.meta.url), 'utf8');
  const routes = lib
    .match(/export const ROUTES = \[([^\]]*)\]/)[1]
    .match(/'([a-z_]+)'/g)
    .map((q) => q.slice(1, -1));
  for (const r of [...BROWSE_ROUTES, CHECKOUT_ROUTE, ...METRICS_ROUTES])
    assert.ok(routes.includes(r), `${r} is not in lib.js ROUTES`);
  // the metrics leg tags its requests with exactly the gated routes (k6/metrics.js)
  const metricsJs = readFileSync(new URL('./k6/metrics.js', import.meta.url), 'utf8');
  for (const r of METRICS_ROUTES)
    assert.match(metricsJs, new RegExp(`'${r}',?\\s*\\)`), `metrics.js never tags ${r}`);
  assert.match(lib, /tags: \{ route \}/, 'requests are tagged with their route');
});

test('LOAD_THRESHOLD_FACTOR must be a number > 0: a typo is refused, not a NaN gate', () => {
  const load = (v) =>
    spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./infra/load/k6/slo-thresholds.js')"],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, LOAD_THRESHOLD_FACTOR: v },
        encoding: 'utf8',
      },
    );
  for (const bad of ['abc', '0', '-1']) {
    const r = load(bad);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /LOAD_THRESHOLD_FACTOR must be a number > 0/);
  }
  assert.equal(load('0.05').status, 0);
});

test('the admin-metrics leg (#785): its two routes are gated and required when it ran, absent when it did not', () => {
  const on = readPass(runDir(0, { metricsLeg: true }));
  assert.equal(on.state, 'pass');
  const seed = {
    events: 783,
    months: 1,
    perStore: { 'store-a': 272, 'store-b': 251 },
    firstDay: '2026-10-01',
    lastDay: '2026-10-31',
  };
  const r = render({ runUrl: 'https://example.invalid/run/6', date: '2026-11-16', p1: on, seed });
  assert.match(r.tracking, /GET \/admin\/metrics \| p95 < 300 ms \(small data: a lower bound\)/);
  assert.match(r.tracking, /POST \/admin\/metrics\/query \| p95 < 300 ms/);
  assert.match(r.tracking, /783 events from 1 generated month/);
  assert.match(r.tracking, /`store-a`: 272/);
  assert.match(r.tracking, /the 300 ms gate is a lower bound/);

  // the leg ran but its routes saw no requests: broken, never a vacuous pass (both tags are covered)
  const empty = readPass(runDir(0, { metricsLeg: true, metricsRoutes: false }));
  assert.equal(empty.state, 'broken');
  assert.equal(empty.reason, 'no requests on metrics, metrics_query');

  // without the leg (a laptop run, no ClickHouse): no metrics rows, no seed line, nothing required
  const off = readPass(runDir(0));
  assert.equal(off.state, 'pass');
  const plain = render({
    runUrl: 'https://example.invalid/run/7',
    date: '2026-11-16',
    p1: off,
    seed,
  });
  assert.doesNotMatch(plain.tracking, /admin\/metrics|ClickHouse seed/);
});

test('render writes tracking.md, issue.md and verdict.txt', () => {
  const out = mkdtempSync(join(tmpdir(), 'slo-gate-out-'));
  mkdirSync(out, { recursive: true });
  const r = spawnSync(
    process.execPath,
    [GATE, 'render', out, 'https://example.invalid/run/3', runDir(0)],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(out, 'verdict.txt'), 'utf8').trim(), 'pass');
  assert.match(readFileSync(join(out, 'tracking.md'), 'utf8'), /within the SLOs/);
});
