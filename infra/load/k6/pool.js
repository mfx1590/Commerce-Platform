/* global __ENV -- k6 runtime globals (https://grafana.com/docs/k6/latest/using-k6/execution-context-variables/) */
// The app-pool knee (#359): GET /store only, stepped up until the pool saturates.
//
// GET /store opens four pool connections per request and the core's request pool is DB_POOL_MAX (default 10,
// unchanged here), so the pool — not CPU — should be where GET /store stops keeping up. This holds
// 50 → 100 → 200 → 400 → 800 req/s for a minute each; every request is tagged with its step (`s0`, `s1`, …),
// so the summary has latency and throughput per step without a raw-CSV dump, and report.mjs lines them up
// with the connections Postgres saw. A measurement: no thresholds gate it.
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { BASE, summary, TREND_STATS } from './lib.js';

const KEY = __ENV.PUBLISHABLE_KEY || 'pk_brand-a_dev_00000000000000000000';
const STEPS = (__ENV.POOL_STEPS || '50,100,200,400,800').split(',').map(Number);
const HOLD_S = Number(__ENV.POOL_STEP_S || 60);
const RAMP_S = 5;

const stages = [];
for (const rate of STEPS) {
  stages.push({ target: rate, duration: `${RAMP_S}s` });
  stages.push({ target: rate, duration: `${HOLD_S}s` });
}

// A sub-metric per step: thresholds that never trip, there only so the summary keeps each step's numbers.
const thresholds = {};
STEPS.forEach((_, i) => {
  thresholds[`http_req_duration{step:s${i}}`] = ['p(95)<600000'];
  thresholds[`http_req_failed{step:s${i}}`] = ['rate<=1'];
});

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    pool: {
      executor: 'ramping-arrival-rate',
      exec: 'store',
      startRate: STEPS[0],
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1500,
      stages,
    },
  },
  thresholds,
};

/** Which step this moment is in: the first RAMP_S seconds of a step are its ramp, counted with it. */
function step() {
  const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
  return `s${Math.min(STEPS.length - 1, Math.floor(elapsed / (RAMP_S + HOLD_S)))}`;
}

export function store() {
  const res = http.get(`${BASE}/store`, {
    headers: { 'X-Publishable-Key': KEY },
    tags: { route: 'store', step: step() },
  });
  check(res, { 'store 200': (x) => x.status === 200 });
}

export function handleSummary(data) {
  data.pool_steps = { steps: STEPS, hold_s: HOLD_S, ramp_s: RAMP_S };
  return summary(data, 'pool');
}
