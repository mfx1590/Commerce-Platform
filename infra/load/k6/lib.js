/* global __ENV, __VU, __ITER -- k6 runtime globals (https://grafana.com/docs/k6/latest/using-k6/execution-context-variables/) */
// Shared by load.js and ceiling.js (#359): the catalogue discovered at setup, the browse mix, and the
// placement journey against the Store API on a real core. Every request carries a `route` tag, so the
// summary has p50/p95/p99 per route and the thresholds can name them.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

export const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:9000').replace(/\/$/, '');
// The seeded dev key (packages/db SEED_IDS) — public by design, and only ever pointed at a throwaway database.
const KEY = __ENV.PUBLISHABLE_KEY || 'pk_brand-a_dev_00000000000000000000';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Publishable-Key': KEY };

export const ordersPlaced = new Counter('orders_placed');
export const placementFailed = new Rate('placement_failed');
export const journeyDuration = new Trend('placement_journey_ms', true);
// Failures split by where they happened: a connection that never opened (status 0 — on the laptop that is
// Docker Desktop's host networking, not the core) against a response the core actually sent (>= 400).
export const transportErrors = new Counter('transport_errors');
export const httpErrors = new Counter('http_errors');

function req(method, path, body, route, extraHeaders) {
  const params = { headers: { ...JSON_HEADERS, ...(extraHeaders || {}) }, tags: { route } };
  const payload = body === undefined ? null : JSON.stringify(body);
  const res = http.request(method, `${BASE}${path}`, payload, params);
  if (route !== 'setup') {
    if (res.status === 0) transportErrors.add(1, { route });
    else if (res.status >= 400) httpErrors.add(1, { route, status: String(res.status) });
  }
  return res;
}

const list = (res) => {
  const b = res.json();
  return Array.isArray(b) ? b : b.items || b.data || b.products || [];
};

/**
 * Runs once (route tag `setup`, kept out of every per-route number). Reads the store's country and currency, then every product's variants, and keeps the in-stock
 * ones ordered by available quantity: placements rotate across them so no single variant is drained.
 */
export function discover() {
  const store = req('GET', '/store', undefined, 'setup');
  if (store.status !== 200) fail(`GET /store answered ${store.status}: is the core up on ${BASE}?`);
  const s = store.json();
  const handles = [];
  for (let page = 0; page < 5; page++) {
    const res = req('GET', `/store/products?limit=100&offset=${page * 100}`, undefined, 'setup');
    if (res.status !== 200) fail(`GET /store/products answered ${res.status}`);
    const items = list(res);
    for (const p of items) handles.push(p.handle);
    if (items.length < 100) break;
  }
  if (!handles.length) fail('the catalogue is empty: was the database seeded?');
  const variants = [];
  const words = new Set();
  for (const handle of handles) {
    const res = req('GET', `/store/products/${handle}`, undefined, 'setup');
    if (res.status !== 200) continue;
    const p = res.json();
    for (const w of String(p.title || '').split(/\s+/))
      if (w.length > 3) words.add(w.toLowerCase());
    for (const v of p.variants || []) {
      if (
        v.in_stock !== false &&
        (v.available_quantity === undefined || v.available_quantity > 0)
      ) {
        variants.push({ id: v.id, available: v.available_quantity ?? 0, handle });
      }
    }
  }
  variants.sort((a, b) => b.available - a.available);
  if (!variants.length)
    fail('no in-stock variant: run `pnpm --filter @platform/db top-up-stock` on this database');
  return {
    country: s.default_country || 'GB',
    currency: s.default_currency,
    handles,
    variants,
    terms: [...words].slice(0, 30),
  };
}

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

/** One browse request: GET /store 20%, product list 40%, product detail 30%, search 10%. */
export function browseOnce(ctx) {
  const r = Math.random();
  let res;
  let route;
  if (r < 0.2) {
    route = 'store';
    res = req('GET', '/store', undefined, route);
  } else if (r < 0.6) {
    route = 'list';
    res = req(
      'GET',
      `/store/products?limit=24&offset=${24 * Math.floor(Math.random() * 3)}`,
      undefined,
      route,
    );
  } else if (r < 0.9) {
    route = 'detail';
    res = req('GET', `/store/products/${pick(ctx.handles)}`, undefined, route);
  } else {
    route = 'search';
    res = req(
      'GET',
      `/store/products?q=${encodeURIComponent(pick(ctx.terms.length ? ctx.terms : ['shirt']))}&limit=24`,
      undefined,
      route,
    );
  }
  check(res, { [`${route} 200`]: (x) => x.status === 200 });
}

const address = (country, n) => ({
  first_name: 'Load',
  last_name: `Test ${n}`,
  line1: '1 Test Street',
  city: 'London',
  postal_code: 'EC1A 1BB',
  country,
});

/** One full placement: cart → line item → email + addresses → shipping → manual payment → complete. */
export function placeOnce(ctx) {
  const started = Date.now();
  const n = `${__VU}-${__ITER}-${started}`;
  const ok = (res, step, codes) => {
    const good = check(res, { [`${step} ${codes.join('/')}`]: (x) => codes.includes(x.status) });
    if (!good) placementFailed.add(1);
    return good;
  };
  // Rotate by iteration across the stocked variants, so the run spreads its units.
  const variant = ctx.variants[(__VU * 7919 + __ITER) % ctx.variants.length];

  let res = req(
    'POST',
    '/store/carts',
    { country: ctx.country, currency: ctx.currency },
    'cart_create',
  );
  if (!ok(res, 'cart_create', [200, 201])) return;
  const cartId = res.json('id');
  res = req(
    'POST',
    `/store/carts/${cartId}/line-items`,
    { variant_id: variant.id, quantity: 1 },
    'line_item',
  );
  if (!ok(res, 'line_item', [200, 201])) return;
  res = req(
    'PATCH',
    `/store/carts/${cartId}`,
    {
      email: `load+${n}@example.com`,
      shipping_address: address(ctx.country, n),
      billing_address: address(ctx.country, n),
    },
    'cart_update',
  );
  if (!ok(res, 'cart_update', [200])) return;
  res = req('GET', `/store/carts/${cartId}/shipping-options`, undefined, 'shipping_options');
  if (!ok(res, 'shipping_options', [200])) return;
  const option = (res.json('items') || [])[0];
  if (!option) {
    placementFailed.add(1);
    check(null, { 'a shipping option is offered': () => false });
    return;
  }
  res = req(
    'PATCH',
    `/store/carts/${cartId}`,
    { shipping_option_id: option.id },
    'shipping_select',
  );
  if (!ok(res, 'shipping_select', [200])) return;
  res = req(
    'POST',
    `/store/carts/${cartId}/payment-session`,
    { provider: 'manual' },
    'payment_session',
  );
  if (!ok(res, 'payment_session', [200, 201])) return;
  res = req('POST', `/store/carts/${cartId}/complete`, {}, 'complete', {
    'Idempotency-Key': `load-${n}`,
  });
  if (!ok(res, 'complete', [200, 201])) return;
  placementFailed.add(0);
  ordersPlaced.add(1);
  journeyDuration.add(Date.now() - started);
}

// Every route gets a threshold so k6 keeps a per-route sub-metric in the summary. The three the owner's
// target names are real gates (p95 < 500 ms); the rest are reporting-only (a 60 s ceiling never trips).
export const ROUTES = [
  'store',
  'list',
  'detail',
  'search',
  'cart_create',
  'line_item',
  'cart_update',
  'shipping_options',
  'shipping_select',
  'payment_session',
  'complete',
];
export const TARGET_ROUTES = ['store', 'list', 'detail'];
export function routeThresholds() {
  const t = {};
  for (const r of ROUTES)
    t[`http_req_duration{route:${r}}`] = [TARGET_ROUTES.includes(r) ? 'p(95)<500' : 'p(95)<60000'];
  for (const r of ROUTES) t[`http_req_failed{route:${r}}`] = ['rate<1'];
  return t;
}

export const TREND_STATS = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'];

/** Writes the full summary for report.mjs, and a short line to stdout. */
export function summary(data, name) {
  const out = {};
  out[`/out/${name}-summary.json`] = JSON.stringify(data, null, 1);
  const placed = data.metrics.orders_placed ? data.metrics.orders_placed.values.count : 0;
  const failed = data.metrics.http_req_failed ? data.metrics.http_req_failed.values.rate : 0;
  out.stdout = `\n${name}: ${data.metrics.http_reqs.values.count} requests, http_req_failed ${(failed * 100).toFixed(3)}%, orders placed ${placed}\n`;
  return out;
}
