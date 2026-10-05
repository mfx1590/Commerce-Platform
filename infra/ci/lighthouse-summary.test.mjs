// Self-test for lighthouse-summary.mjs. Runs in the `changes` job:
//   node --test infra/ci/lighthouse-summary.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, numericAssertions, render, summarise } from './lighthouse-summary.mjs';

const RC = {
  ci: {
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:seo': ['error', { minScore: 0.95, aggregationMethod: 'pessimistic' }],
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        'total-blocking-time': ['warn', { maxNumericValue: 300 }],
        'uses-http2': 'off',
      },
    },
  },
};
const PLP = 'http://127.0.0.1:3100/en-GB/products';
const lhr = (url, t, lcp, perf, seo, bench, tbt = 40) => ({
  requestedUrl: url,
  fetchTime: t,
  environment: { benchmarkIndex: bench },
  categories: { performance: { score: perf }, seo: { score: seo } },
  audits: {
    'largest-contentful-paint': { numericValue: lcp },
    'total-blocking-time': { numericValue: tbt },
  },
});
// #341's failing leg (run 37301539904): PLP LCP 2815 / 2598 / 2571, best 2570.6 > 2500.
const RUNS = [
  lhr(PLP, '2026-10-05T11:15:47Z', 2815.0458, 0.85, 0.92, 2066, 431),
  lhr(PLP, '2026-10-05T11:16:00Z', 2597.779, 0.97, 1, 2461, 68),
  lhr(PLP, '2026-10-05T11:16:11Z', 2570.607, 0.97, 0.92, 2416, 39),
];

test('aggregation matches LHCI: optimistic = best, pessimistic = worst, median = median', () => {
  assert.equal(aggregate([2815, 2598, 2571], 'optimistic', 'max'), 2571);
  assert.equal(aggregate([2815, 2598, 2571], 'pessimistic', 'max'), 2815);
  assert.equal(aggregate([2815, 2598, 2571], 'median', 'max'), 2598);
  assert.equal(aggregate([0.85, 0.97, 0.97], 'optimistic', 'min'), 0.97);
  assert.equal(aggregate([0.92, 1, 0.92], 'pessimistic', 'min'), 0.92);
  assert.equal(aggregate([1, 2], 'median', 'max'), 1.5);
  assert.equal(aggregate([], 'optimistic', 'max'), undefined);
});

test('only numeric, enabled assertions are read; the default aggregation is optimistic', () => {
  const a = numericAssertions(RC);
  assert.deepEqual(
    a.map((x) => [x.id, x.kind, x.method]),
    [
      ['categories:performance', 'min', 'optimistic'],
      ['categories:seo', 'min', 'pessimistic'],
      ['largest-contentful-paint', 'max', 'optimistic'],
      ['total-blocking-time', 'max', 'optimistic'],
    ],
  );
});

test("#341's leg: LCP compared 2570.6 (best run), +70.6 over, FAIL; every run and benchmark kept", () => {
  const [plp] = summarise(RUNS, RC);
  assert.deepEqual(plp.benchmarks, [2066, 2461, 2416]);
  const lcp = plp.rows.find((r) => r.id === 'largest-contentful-paint');
  assert.equal(lcp.values.length, 3);
  assert.equal(lcp.asserted, 2570.607);
  assert.ok(Math.abs(lcp.margin - 70.607) < 1e-9);
  assert.equal(lcp.pass, false);
  const seo = plp.rows.find((r) => r.id === 'categories:seo');
  assert.equal(seo.asserted, 0.92); // pessimistic: worst run
  assert.equal(seo.pass, false);
  const perf = plp.rows.find((r) => r.id === 'categories:performance');
  assert.equal(perf.asserted, 0.97); // optimistic: best run
  assert.equal(perf.pass, true);
});

test('a warn-level assertion over budget reads WARN, not FAIL', () => {
  const runs = RUNS.map((r) => ({
    ...r,
    audits: { ...r.audits, 'total-blocking-time': { numericValue: 400 } },
  }));
  const { text } = render(summarise(runs, RC), 'apps/x');
  assert.match(text, /total-blocking-time .* WARN/);
  assert.match(text, /largest-contentful-paint .*compared 2571 .*margin \+71 .*FAIL/);
});

test('runs are grouped per URL and ordered by time', () => {
  const pdp = 'http://127.0.0.1:3100/en-GB/products/classic-tee';
  const mixed = [RUNS[2], lhr(pdp, '2026-10-05T11:16:22Z', 2197, 0.92, 1, 2373), RUNS[0], RUNS[1]];
  const s = summarise(mixed, RC);
  assert.deepEqual(
    s.map((u) => u.url),
    [PLP, pdp],
  );
  assert.deepEqual(
    s[0].rows.find((r) => r.id === 'largest-contentful-paint').values.map(Math.round),
    [2815, 2598, 2571],
  );
});
