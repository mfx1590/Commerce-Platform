// Self-test for report.mjs (#359). Runs in the `changes` job:  node --test infra/load/report.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ceilingSteps,
  durationSeconds,
  knee,
  parseK6Csv,
  poolStats,
  render,
  routeStats,
} from './report.mjs';

const trend = (med, p95, p99, count) => ({
  values: { med, 'p(95)': p95, 'p(99)': p99, max: p99 + 10, count },
});
const failed = (rate) => ({ values: { rate } });
const summary = (over = {}) => ({
  metrics: {
    'http_req_duration{route:store}': trend(20, 40, 60, 6000),
    'http_req_failed{route:store}': failed(0),
    'http_req_duration{route:list}': trend(70, 120, 200, 12000),
    'http_req_failed{route:list}': failed(0),
    'http_req_duration{route:detail}': trend(25, 45, 80, 9000),
    'http_req_failed{route:detail}': failed(0),
    'http_req_duration{route:search}': trend(50, 90, 150, 3000),
    'http_req_failed{route:search}': failed(0),
    'http_req_duration{route:complete}': trend(90, 200, 300, 300),
    'http_req_failed{route:complete}': failed(0),
    'http_req_duration{route:setup}': trend(10, 10, 10, 999), // discovery: must never count as load
    orders_placed: { values: { count: 300 } },
    dropped_iterations: { values: { count: 0 } },
    ...over,
  },
});
const META = {
  started: '2026-10-06T10:00:00Z',
  host: 'laptop',
  duration: '10m',
  browse_rps: 50,
  orders_per_min: 30,
  db_pool_max: 10,
};

test('durations parse the way k6 writes them', () => {
  assert.equal(durationSeconds('10m'), 600);
  assert.equal(durationSeconds('30s'), 30);
  assert.equal(durationSeconds('1.5m'), 90);
});

test('per-route stats leave the setup route out', () => {
  const r = routeStats(summary());
  assert.deepEqual(Object.keys(r).sort(), ['complete', 'detail', 'list', 'search', 'store']);
  assert.equal(r.list.p95, 120);
});

test('a run on target passes every line; the rates come from the load routes only', () => {
  const md = render({ meta: META, load: summary(), pgLoad: [], ceilingRows: [] });
  assert.match(md, /GET \/store p95 \| < 500 ms \| 40 ms \| ✅ pass/);
  assert.match(
    md,
    /orders placed per minute \| 30 sustained \| 30\.0 \(300 in 10 min\) \| ✅ pass/,
  );
  assert.match(md, /browse throughput \| 50 req\/s \| 50\.0 req\/s \| ✅ pass/); // 30000 / 600, setup excluded
  assert.doesNotMatch(md, /configured below the owner's target/);
  assert.match(md, /These are laptop numbers, not a server’s/);
});

test('a p95 over 500 ms, a short order rate and core errors each fail their line', () => {
  const load = summary({
    'http_req_duration{route:list}': trend(300, 620, 900, 12000),
    'http_req_failed{route:list}': failed(0.01),
    orders_placed: { values: { count: 240 } },
    http_errors: { values: { count: 120 } },
  });
  const md = render({ meta: META, load, pgLoad: [], ceilingRows: [] });
  assert.match(md, /GET \/store\/products p95 \| < 500 ms \| 620 ms \| ❌ fail/);
  assert.match(md, /orders placed per minute \| 30 sustained \| 24\.0/);
  assert.match(
    md,
    /answered by the core with an error \(HTTP ≥ 400\) \| < 0\.1% \| 0\.396% \(120\) \| ❌ fail/,
  );
});

test('connections that never opened are counted apart from what the core answered', () => {
  const load = summary({
    'http_req_failed{route:detail}': failed(8 / 9000),
    transport_errors: { values: { count: 8 } },
  });
  const md = render({ meta: META, load, pgLoad: [], ceilingRows: [] });
  assert.match(
    md,
    /answered by the core with an error \(HTTP ≥ 400\) \| < 0\.1% \| 0\.000% \(0\) \| ✅ pass/,
  );
  assert.match(md, /never reached the core .* \| 8 \| ⚠ harness/);
  assert.match(md, /8 request\(s\) never reached the core/);
});

test('a run below the target says so', () => {
  const md = render({
    meta: { ...META, duration: '1m', browse_rps: 5, orders_per_min: 6 },
    load: summary(),
    pgLoad: [],
    ceilingRows: [],
  });
  assert.match(md, /configured below the owner's target \(1m, 5 req\/s, 6 orders\/min\)/);
});

test('pool saturation is the share of samples with every app connection busy', () => {
  const s = (active, idleTx, lock = 0) => ({
    byRole: { platform_app: { total: 10, active, idle_in_tx: idleTx } },
    waits: lock ? { 'Lock:transactionid': lock } : {},
    lockWaits: lock,
  });
  const p = poolStats([s(10, 0), s(9, 1, 2), s(4, 0), s(2, 0)], 10);
  assert.equal(p.maxBusy, 10);
  assert.equal(p.saturatedShare, 0.5);
  assert.equal(p.maxLockWaits, 2);
  assert.equal(p.lockSampleShare, 0.25);
  assert.deepEqual(p.topWaits, [['Lock:transactionid', 2]]);
});

test('k6 CSV: the route comes from extra_tags when it has no column of its own', () => {
  const csv = [
    'metric_name,timestamp,metric_value,check,error,error_code,expected_response,group,method,name,proto,scenario,service,status,subproto,tls_version,url,extra_tags,metadata',
    'http_req_duration,1000,85,,,,true,,POST,x,HTTP/1.1,ceiling,,200,,,x,route=complete,',
    'orders_placed,1000,1,,,,,,,,,ceiling,,,,,,,',
  ].join('\n');
  const rows = parseK6Csv(csv);
  assert.equal(rows[0].route, 'complete');
  assert.equal(rows[0].value, 85);
  assert.equal(rows[1].metric, 'orders_placed');
});

test('the ceiling: steps are bucketed in order and the knee is the first that does not hold', () => {
  const rows = [];
  const add = (stepIndex, perMin, completeMs) => {
    const from = 1000 + stepIndex * 65 + 5;
    const n = Math.round(perMin);
    for (let i = 0; i < n; i++) {
      const t = from + (i * 60) / n;
      rows.push({ metric: 'orders_placed', t, value: 1, route: '' });
      rows.push({ metric: 'http_req_duration', t, value: completeMs, route: 'complete' });
      rows.push({ metric: 'placement_failed', t, value: 0, route: '' });
    }
  };
  rows.push({ metric: 'orders_placed', t: 1000, value: 0, route: '' }); // the run's first sample
  add(0, 30, 90);
  add(1, 60, 120);
  add(2, 85, 640); // falls behind and slows down: the knee
  add(3, 90, 1500);
  const steps = ceilingSteps(rows, [], [30, 60, 120, 240], 60);
  assert.deepEqual(
    steps.map((s) => Math.round(s.achievedPerMin)),
    [30, 60, 85, 90],
  );
  const k = knee(steps);
  assert.equal(k.step.rate, 120);
  assert.equal(k.lastGood.rate, 60);
});

test('one late order in a short step is not a knee', () => {
  const k = knee([
    { rate: 6, achievedPerMin: 4, completeP95: 80, failShare: 0 },
    { rate: 12, achievedPerMin: 11, completeP95: 90, failShare: 0 },
  ]);
  assert.equal(k, undefined);
});

test('the pool ramp: per-step numbers from the step sub-metrics, the knee where it stops keeping up', async () => {
  const { poolSteps, poolKnee } = await import('./report.mjs');
  const d = (count, p95) => ({ values: { count, med: p95 / 2, 'p(95)': p95, 'p(99)': p95 * 2 } });
  const summaryPool = {
    pool_steps: { steps: [50, 100, 200], hold_s: 60, ramp_s: 5 },
    metrics: {
      'http_req_duration{step:s0}': d(50 * 65, 30),
      'http_req_failed{step:s0}': { values: { rate: 0 } },
      'http_req_duration{step:s1}': d(100 * 65, 80),
      'http_req_failed{step:s1}': { values: { rate: 0 } },
      'http_req_duration{step:s2}': d(140 * 65, 900),
      'http_req_failed{step:s2}': { values: { rate: 0 } },
    },
  };
  const sample = (sec, busy) => ({
    t: 1_000_000 + sec * 1000,
    byRole: { platform_app: { active: busy, idle_in_tx: 0 } },
  });
  const samples = [];
  for (let sec = 0; sec < 195; sec++) samples.push(sample(sec, sec < 65 ? 3 : sec < 130 ? 7 : 10));
  const steps = poolSteps(summaryPool, samples, 10);
  assert.deepEqual(
    steps.map((s) => Math.round(s.achievedRps)),
    [50, 100, 140],
  );
  assert.deepEqual(
    steps.map((s) => s.maxBusy),
    [3, 7, 10],
  );
  assert.equal(steps[2].saturatedShare, 1);
  const k = poolKnee(steps);
  assert.equal(k.step.rate, 200);
  assert.equal(k.lastGood.rate, 100);
});

test('crossed thresholds are listed by metric and expression', async () => {
  const { crossedThresholds } = await import('./report.mjs');
  const crossed = crossedThresholds({
    metrics: {
      placement_failed: { thresholds: { 'rate<0.001': { ok: false } } },
      http_req_failed: { thresholds: { 'rate<0.001': { ok: true } } },
    },
  });
  assert.deepEqual(crossed, ['placement_failed: rate<0.001']);
});

test('a host suspend is found from the sampler, and voids every step from it on', async () => {
  const { suspends, suspendBanner, poolSteps, poolKnee } = await import('./report.mjs');
  const t0 = 1_000_000;
  const samples = [];
  for (let sec = 0; sec < 140; sec++) samples.push({ t: t0 + sec * 1000, byRole: {} });
  // the machine sleeps for 600 s during the third step
  for (let sec = 740; sec < 800; sec++) samples.push({ t: t0 + sec * 1000, byRole: {} });
  const s = suspends(samples);
  assert.equal(s.length, 1);
  assert.equal(Math.round(s[0].seconds), 601);
  assert.match(suspendBanner(samples, 'Ramp'), /NOT A VALID MEASUREMENT/);
  assert.equal(suspendBanner(samples.slice(0, 100), 'Ramp'), '');
  const d = (count) => ({ values: { count, med: 10, 'p(95)': 20, 'p(99)': 30 } });
  const summaryPool = {
    pool_steps: { steps: [50, 100, 200], hold_s: 60, ramp_s: 5 },
    metrics: {
      'http_req_duration{step:s0}': d(50 * 65),
      'http_req_duration{step:s1}': d(100 * 65),
      'http_req_duration{step:s2}': d(3 * 65), // starved by the sleep: must not read as a knee
    },
  };
  const steps = poolSteps(summaryPool, samples, 10);
  assert.deepEqual(
    steps.map((x) => x.valid),
    [true, true, false],
  );
  assert.equal(poolKnee(steps), undefined);
});

test('the ceiling ramp starts at the first placement, not at setup', async () => {
  const { ceilingSteps } = await import('./report.mjs');
  const rows = [{ metric: 'http_req_duration', t: 900, value: 5, route: 'setup' }];
  for (let i = 0; i < 30; i++) {
    const t = 1000 + 5 + i * 2;
    rows.push({ metric: 'http_req_duration', t, value: 50, route: 'cart_create' });
    rows.push({ metric: 'orders_placed', t, value: 1, route: '' });
  }
  rows.push({ metric: 'http_req_duration', t: 1000, value: 50, route: 'cart_create' });
  const [first] = ceilingSteps(rows, [], [30], 60);
  assert.equal(first.achievedPerMin, 30);
});
