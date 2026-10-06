/* global __ENV -- k6 runtime globals (https://grafana.com/docs/k6/latest/using-k6/execution-context-variables/) */
// The placement ceiling (#359): placement only, one store, stepped up until it stops keeping up.
//
// Every order on a store takes that store's row lock — migration 0006's trigger app.assign_order_display_id()
// runs `UPDATE store SET next_order_number … RETURNING` inside the order insert and holds it until
// completeCart's transaction commits — so one store's placements serialise on the rest of that
// transaction. This ramps 30 → 60 → … → 960 orders/min (one minute each) and report.mjs reads, per step,
// the orders achieved, the complete-step latency and the lock waits Postgres saw: the knee is the store's
// ceiling. No thresholds gate it; it is a measurement.
import { discover, placeOnce, routeThresholds, summary, TREND_STATS } from './lib.js';

const STEPS = (__ENV.CEILING_STEPS || '30,60,120,240,480,960').split(',').map(Number);
const STEP = __ENV.CEILING_STEP || '1m';

const stages = [];
for (const rate of STEPS) {
  stages.push({ target: rate, duration: '5s' }); // move to the step's rate
  stages.push({ target: rate, duration: STEP }); // hold it
}

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    ceiling: {
      executor: 'ramping-arrival-rate',
      exec: 'place',
      startRate: STEPS[0],
      timeUnit: '1m',
      preAllocatedVUs: 20,
      maxVUs: 300,
      stages,
    },
  },
  thresholds: routeThresholds(),
};

export function setup() {
  return discover();
}
export function place(ctx) {
  placeOnce(ctx);
}
export function handleSummary(data) {
  return summary(data, 'ceiling');
}
