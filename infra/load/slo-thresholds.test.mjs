// Self-test (the `changes` job): the scheduled k6 regression gates on the SAME numbers as the Prometheus SLO rules.
// infra/load/k6/slo-thresholds.js and infra/observability/rules/slo.mjs must agree; change one without the other and
// this fails.
//   node --test infra/load/slo-thresholds.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SLOS } from '../observability/rules/slo.mjs';
import { BROWSE_ROUTES, CHECKOUT_ROUTE, routeP95Ms, SLO } from './k6/slo-thresholds.js';

const slo = (name) => {
  const s = SLOS.find((x) => x.name === name);
  assert.ok(s, `no SLO named ${name} in slo.mjs`);
  return s;
};

/** The latency bound in seconds, read from the rule's `le` matcher (e.g. le=~"0\\.5" or le=~"2(\\.0)?"). */
function leSeconds(s) {
  const m = s.error('5m').match(/le=~"([^"]+)"/);
  assert.ok(m, `${s.name}: no le matcher in its rule`);
  return Number(m[1].replace(/\(\\\\\.0\)\?$/, '').replace(/\\/g, ''));
}

test('browse p95 = store-api-latency: "95% under" the rule\'s bucket boundary', () => {
  const s = slo('store-api-latency');
  assert.equal(s.target, 0.95, 'a p(95) gate only matches a 95% latency SLO');
  assert.equal(SLO.browseP95Ms, leSeconds(s) * 1000);
});

test('complete p95 = checkout-latency', () => {
  const s = slo('checkout-latency');
  assert.equal(s.target, 0.95);
  assert.equal(SLO.completeP95Ms, leSeconds(s) * 1000);
});

test('the failure-rate gate = 1 - target of both availability SLOs', () => {
  for (const name of ['store-api-availability', 'checkout-availability'])
    assert.equal(SLO.errorRate.toFixed(6), (1 - slo(name).target).toFixed(6), name);
});

test('routes: the SLO routes get their gate, the others none; the factor scales latency only', () => {
  for (const r of BROWSE_ROUTES) assert.equal(routeP95Ms(r, 1), SLO.browseP95Ms);
  assert.equal(routeP95Ms(CHECKOUT_ROUTE, 1), SLO.completeP95Ms);
  assert.equal(routeP95Ms('search', 1), undefined);
  assert.equal(routeP95Ms('store', 0.1), 50);
  assert.equal(routeP95Ms(CHECKOUT_ROUTE, 0.1), 200);
});
