// Self-test for slo-gate.mjs (the `changes` job):  node --test infra/load/slo-gate.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { overall, readPass, render } from './slo-gate.mjs';

const GATE = fileURLToPath(new URL('./slo-gate.mjs', import.meta.url));

/** A run dir as run.sh leaves it: k6's exit code + a minimal summary (complete p95 given, browse 120 ms). */
function runDir(code, { completeP95 = 300, failRate = 0, crossed = false } = {}) {
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
  };
  writeFileSync(join(dir, 'load.exit'), `${code}\n`);
  writeFileSync(join(dir, 'load-summary.json'), JSON.stringify({ metrics }));
  return dir;
}

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
