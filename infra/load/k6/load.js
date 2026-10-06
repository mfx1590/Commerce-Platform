/* global __ENV -- k6 runtime globals (https://grafana.com/docs/k6/latest/using-k6/execution-context-variables/) */
// The owner's target (2026-10-06, #359), as one run with two scenarios at once:
//   browse  50 requests/s for 10 min — GET /store 20%, product list 40%, product detail 30%, search 10%
//   place   30 orders/min for 10 min — the full placement journey, completed with an Idempotency-Key
// Gates: p95 < 500 ms for GET /store, product list and product detail; failed requests < 0.1%.
// Rates and duration are overridable (BROWSE_RPS, ORDERS_PER_MIN, DURATION) for a short smoke run.
import { browseOnce, discover, placeOnce, routeThresholds, summary, TREND_STATS } from './lib.js';

const DURATION = __ENV.DURATION || '10m';
const BROWSE_RPS = Number(__ENV.BROWSE_RPS || 50);
const ORDERS_PER_MIN = Number(__ENV.ORDERS_PER_MIN || 30);

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      exec: 'browse',
      rate: BROWSE_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 400,
    },
    place: {
      executor: 'constant-arrival-rate',
      exec: 'place',
      rate: ORDERS_PER_MIN,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 100,
    },
  },
  thresholds: {
    ...routeThresholds(),
    http_req_failed: ['rate<0.001'],
    placement_failed: ['rate<0.001'],
  },
};

export function setup() {
  return discover();
}
export function browse(ctx) {
  browseOnce(ctx);
}
export function place(ctx) {
  placeOnce(ctx);
}
export function handleSummary(data) {
  return summary(data, 'load');
}
