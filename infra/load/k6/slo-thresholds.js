/* global __ENV -- k6 runtime global; under Node (the self-test, slo-gate.mjs) the factor comes from process.env */
// The SLO-derived k6 gates (the scheduled SLO regression, plan wave 3). The ONE place these numbers live for k6:
// infra/load/slo-thresholds.test.mjs fails CI unless they equal infra/observability/rules/slo.mjs (the SLOs as
// Prometheus rules; SLO.md has the prose). No k6 import here, so Node can load it.
//
// A latency SLO is "95% of requests under X", so its k6 gate is p(95) < X. An availability SLO is "99.9% not 5xx",
// so its gate is a failure rate < 0.1%. k6's http_req_failed also counts 4xx, so that gate is stricter than the SLO.
export const SLO = {
  // store-api-latency: 95% of GET /store, the product list and product detail under 500 ms.
  browseP95Ms: 500,
  // checkout-latency: 95% of POST /store/carts/{cartId}/complete under 2 s. A LOWER BOUND here: run.sh's core uses
  // the `manual` payment provider (no network call), while production calls the payment provider inside the
  // request. A pass says the core is fast enough; it says nothing about Stripe.
  completeP95Ms: 2000,
  // admin-metrics-latency: 95% of GET /admin/metrics and POST /admin/metrics/query under 300 ms (#785). SMALL DATA:
  // a LOWER BOUND here. The run's ClickHouse holds one generated month (infra/load/ch-seed.mjs, about 800 events),
  // while production holds the stores' whole history. A pass says the API and the auth path are fast enough on
  // little data; it says nothing about large scans.
  adminMetricsP95Ms: 300,
  // store-api-availability and checkout-availability: 99.9% of requests (and of placements) not failed.
  errorRate: 0.001,
};

export const BROWSE_ROUTES = ['store', 'list', 'detail'];
export const CHECKOUT_ROUTE = 'complete';
// Gated only when the run includes the admin-metrics leg (LOAD_METRICS=1, k6/metrics.js).
export const METRICS_ROUTES = ['metrics', 'metrics_query'];

// LOAD_THRESHOLD_FACTOR (default 1) scales the LATENCY gates. Only the manual workflow_dispatch input sets it, below 1,
// to force a breach and prove the retry-once rule and the issue text. The schedule never sets it.
// k6 reads it from __ENV; Node (slo-gate.mjs rendering the verdict) from process.env. Both must see the same factor,
// or the rendered table shows the unscaled gates next to a breach of the scaled ones (the first breach proof did).
const env =
  typeof __ENV !== 'undefined' ? __ENV : typeof process !== 'undefined' ? process.env : {};
export const FACTOR = Number(env.LOAD_THRESHOLD_FACTOR || 1);
// A typo must not quietly gate on NaN or on 0 (`p(95)<NaN` never passes; `p(95)<0` neither): refuse it.
if (!(Number.isFinite(FACTOR) && FACTOR > 0))
  throw new Error(`LOAD_THRESHOLD_FACTOR must be a number > 0, got "${env.LOAD_THRESHOLD_FACTOR}"`);

/** The p(95) gate in ms for a route, or undefined when no SLO covers it. */
export function routeP95Ms(route, factor = FACTOR) {
  if (BROWSE_ROUTES.includes(route)) return Math.round(SLO.browseP95Ms * factor);
  if (route === CHECKOUT_ROUTE) return Math.round(SLO.completeP95Ms * factor);
  if (METRICS_ROUTES.includes(route)) return Math.round(SLO.adminMetricsP95Ms * factor);
  return undefined;
}
