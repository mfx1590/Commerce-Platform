#!/usr/bin/env node
/**
 * How much server time the recommendation rail costs a page (#609, the manager's condition on the
 * PR): the PDP and the cart, each `RUNS` times with the recommendations call answering normally and
 * `RUNS` times with it held past the deadline, reported as p50 / p95 of the full server response.
 *
 *   pnpm --filter @platform/storefront-starter build          # a production build first
 *   MOCK_API_URL=http://127.0.0.1:4120 node scripts/rail-timing.mjs
 *
 * How it works. A delay proxy sits between the app and the Prism mock. In `slow` mode it holds
 * `GET /store/recommendations` for `DELAY_MS` (default 2000, far past the 300 ms default deadline);
 * everything else passes straight through. Each PDP request uses a fresh handle and the proxy gives
 * the product a fresh id, so neither the product read nor the rail is a cache hit: every request
 * pays for both, which is the worst case the deadline has to bound. The proxy also times each
 * upstream call, which shows how long the page's own data takes next to the rail's.
 *
 * Measurement only — needs "the machine". Prints a Markdown table; exit 1 if the slow p95 exceeds
 * the normal p95 by more than the deadline plus `SLACK_MS` (default 150, for timer and scheduling
 * noise on a laptop).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = new URL(process.env.MOCK_API_URL ?? 'http://127.0.0.1:4010');
const RUNS = Number(process.env.RUNS ?? 20);
const WARMUP = 3;
const DELAY_MS = Number(process.env.DELAY_MS ?? 2000);
const DEADLINE_MS = Number(process.env.RECOMMENDATIONS_TIMEOUT_MS ?? 300);
const SLACK_MS = Number(process.env.SLACK_MS ?? 150);
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 4121);
const APP_PORT = Number(process.env.APP_PORT ?? 3190);
/** Prism validates the path id as a uuid; any uuid answers the example cart. */
const CART_ID = randomUUID();
const LOCALE = process.env.DEFAULT_LOCALE ?? 'en-GB';

let slow = false;
/** Upstream durations by kind, normal mode only. */
const upstream = { product: [], recommendations: [], cart: [] };

const proxy = createServer((req, res) => {
  const path = req.url ?? '/';
  const isRecs = path.startsWith('/store/recommendations');
  const isProduct = /^\/store\/products\/[^/?]+(\?|$)/.test(path);
  const isCart = /^\/store\/carts\/[^/?]+(\?|$)/.test(path) && req.method === 'GET';
  const started = performance.now();
  if (process.env.TRACE) console.error(`[proxy] ${req.method} ${path}`);

  const forward = () => {
    const out = httpRequest(
      { host: MOCK.hostname, port: MOCK.port, path, method: req.method, headers: req.headers },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          let body = Buffer.concat(chunks);
          if (isProduct && upstreamRes.statusCode === 200) {
            const product = JSON.parse(body.toString('utf8'));
            product.id = randomUUID();
            body = Buffer.from(JSON.stringify(product));
          }
          const elapsed = performance.now() - started;
          if (!slow) {
            if (isRecs) upstream.recommendations.push(elapsed);
            else if (isProduct) upstream.product.push(elapsed);
            else if (isCart) upstream.cart.push(elapsed);
          }
          const headers = { ...upstreamRes.headers, 'content-length': String(body.length) };
          delete headers['transfer-encoding'];
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          res.end(body);
        });
      },
    );
    out.on('error', () => res.writeHead(502).end());
    req.pipe(out);
  };

  // An aborted request closes the socket; the timer then answers nobody, harmlessly.
  if (isRecs && slow) setTimeout(forward, DELAY_MS);
  else forward();
});

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

async function timed(url, headers = {}) {
  const started = performance.now();
  const response = await fetch(url, { headers, redirect: 'manual' });
  const html = await response.text();
  const elapsed = performance.now() - started;
  if (response.status !== 200) throw new Error(`${url} answered ${response.status}`);
  return { elapsed, hasRail: html.includes('data-testid="recommendation-rail"') };
}

async function waitFor(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not come up in ${timeoutMs} ms`);
}

const app = `http://127.0.0.1:${APP_PORT}`;
const surfaces = {
  pdp: (mode, i) => timed(`${app}/${LOCALE}/products/rail-timing-${mode}-${i}`),
  cart: () => timed(`${app}/${LOCALE}/cart`, { cookie: `cart_id=${CART_ID}` }),
};

await new Promise((resolve) => proxy.listen(PROXY_PORT, '127.0.0.1', resolve));
const server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    SITE_URL: process.env.SITE_URL ?? `http://127.0.0.1:${APP_PORT}`,
    // A production server needs it to build its CSP (#783 review).
    KEYCLOAK_URL: process.env.KEYCLOAK_URL || 'http://localhost:8180',
    STORE_API_URL: `http://127.0.0.1:${PROXY_PORT}`,
    RECOMMENDATIONS_TIMEOUT_MS: String(DEADLINE_MS),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const results = [];
let failed = false;
try {
  await waitFor(`${app}/health`, 60_000);
  for (const [surface, hit] of Object.entries(surfaces)) {
    const row = { surface };
    for (const mode of ['normal', 'slow']) {
      slow = mode === 'slow';
      for (let i = 0; i < WARMUP; i += 1) await hit(mode, `warm-${i}`);
      const times = [];
      let rails = 0;
      for (let i = 0; i < RUNS; i += 1) {
        const { elapsed, hasRail } = await hit(mode, i);
        times.push(elapsed);
        if (hasRail) rails += 1;
      }
      row[mode] = { p50: percentile(times, 50), p95: percentile(times, 95), rails };
    }
    results.push(row);
  }
} finally {
  server.kill();
  proxy.close();
}

const ms = (value) => `${Math.round(value)} ms`;
console.log(
  `\nRail timing — ${RUNS} requests per cell after ${WARMUP} warm-ups; deadline ${DEADLINE_MS} ms; ` +
    `slow = recommendations held ${DELAY_MS} ms\n`,
);
console.log(
  '| Page | normal p50 | normal p95 | slow p50 | slow p95 | added p50 | added p95 | rail rendered (normal / slow) |',
);
console.log(
  '| ---- | ---------- | ---------- | -------- | -------- | --------- | --------- | ----------------------------- |',
);
for (const { surface, normal, slow: held } of results) {
  const addedP95 = held.p95 - normal.p95;
  if (addedP95 > DEADLINE_MS + SLACK_MS) failed = true;
  console.log(
    `| ${surface} | ${ms(normal.p50)} | ${ms(normal.p95)} | ${ms(held.p50)} | ${ms(held.p95)} | ` +
      `${ms(held.p50 - normal.p50)} | ${ms(addedP95)} | ${normal.rails}/${RUNS} / ${held.rails}/${RUNS} |`,
  );
}
console.log('\nUpstream (normal mode), p50 / p95 as seen at the proxy:');
for (const [kind, values] of Object.entries(upstream)) {
  if (values.length > 0)
    console.log(
      `- ${kind}: ${ms(percentile(values, 50))} / ${ms(percentile(values, 95))} (${values.length} calls)`,
    );
}
console.log(
  failed
    ? `\nFAIL: added p95 above deadline + ${SLACK_MS} ms`
    : '\nOK: added time within the deadline',
);
process.exit(failed ? 1 : 0);
