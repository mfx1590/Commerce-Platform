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
  // store-api-availability and checkout-availability: 99.9% of requests (and of placements) not failed.
  errorRate: 0.001,
};

export const BROWSE_ROUTES = ['store', 'list', 'detail'];
export const CHECKOUT_ROUTE = 'complete';

// LOAD_THRESHOLD_FACTOR (default 1) scales the LATENCY gates. Only the manual workflow_dispatch input sets it, below 1,
// to force a breach and prove the retry-once rule and the issue text. The schedule never sets it.
// k6 reads it from __ENV; Node (slo-gate.mjs rendering the verdict) from process.env. Both must see the same factor,
// or the rendered table shows the unscaled gates next to a breach of the scaled ones (the first breach proof did).
const env =
  typeof __ENV !== 'undefined' ? __ENV : typeof process !== 'undefined' ? process.env : {};
export const FACTOR = Number(env.LOAD_THRESHOLD_FACTOR || 1);

/** The p(95) gate in ms for a route, or undefined when no SLO covers it. */
export function routeP95Ms(route, factor = FACTOR) {
  if (BROWSE_ROUTES.includes(route)) return Math.round(SLO.browseP95Ms * factor);
  if (route === CHECKOUT_ROUTE) return Math.round(SLO.completeP95Ms * factor);
  return undefined;
}
