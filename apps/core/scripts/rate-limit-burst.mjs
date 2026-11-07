#!/usr/bin/env node
// #742 proof: a burst on every rate-limited Store API path as ONE client, next to the normal k6 traffic of
// infra/load (which must stay 2xx). With CORE_CLIENT_IP_HEADER=x-forwarded-for on the core, the burst is its own
// client (`--client`); without it, run the burst on a store k6 does not use (`--key`).
//
//   node apps/core/scripts/rate-limit-burst.mjs [--base http://127.0.0.1:9000] [--key pk_...] [--client 198.51.100.7]
//                                              [--n 40] [--concurrency 8]
//
// Each path gets `n` requests. Without a token / with ids that do not exist, the requests the limiter lets through
// answer 4xx from the route (401 / 404 / 400); what matters is when the 429s start and their Retry-After.
// Prints one table row per path and exits 1 when a path never answered 429.
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const BASE = args.base ?? 'http://127.0.0.1:9000';
const KEY = args.key ?? 'pk_brand-b_dev_00000000000000000000';
const CLIENT = args.client ?? '198.51.100.7';
const N = Number(args.n ?? 40);
const CONCURRENCY = Number(args.concurrency ?? 8);
const ZERO = '00000000-0000-4000-8000-000000000000';

const headers = {
  'Content-Type': 'application/json',
  'X-Publishable-Key': KEY,
  'X-Forwarded-For': CLIENT,
};

const PATHS = [
  ['auth', 'POST', '/store/customers', {}],
  ['auth', 'POST', `/store/cart-recovery/burst-${ZERO}`, {}],
  ['cart', 'POST', '/store/carts', { currency: 'EUR' }],
  ['cart', 'PATCH', `/store/carts/${ZERO}`, { email: 'burst@example.test' }],
  ['cart', 'POST', `/store/carts/${ZERO}/line-items`, { variant_id: ZERO, quantity: 1 }],
  ['cart', 'PATCH', `/store/carts/${ZERO}/line-items/${ZERO}`, { quantity: 2 }],
  ['cart', 'DELETE', `/store/carts/${ZERO}/line-items/${ZERO}`, undefined],
  ['cart', 'POST', `/store/carts/${ZERO}/payment-session`, { provider: 'manual' }],
  ['checkout', 'POST', `/store/carts/${ZERO}/complete`, {}],
];

async function one(method, path, body) {
  const t = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const retryAfter = res.headers.get('retry-after');
    const text = await res.text();
    let code;
    try {
      code = JSON.parse(text).code;
    } catch {
      code = undefined;
    }
    return { status: res.status, retryAfter, code, ms: performance.now() - t };
  } catch {
    return { status: 0, retryAfter: null, code: 'network', ms: performance.now() - t };
  }
}

async function burst(method, path, body) {
  const results = new Array(N);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < N) {
        const i = next++;
        results[i] = await one(method, path, body);
      }
    }),
  );
  return results;
}

console.log(
  `burst: ${N} requests per path, ${CONCURRENCY} at a time, client ${CLIENT}, against ${BASE}`,
);
console.log('| class | path | statuses | first 429 at | Retry-After (s) | 429 body code |');
console.log('|---|---|---|---|---|---|');
let missing = 0;
for (const [cls, method, path, body] of PATHS) {
  const r = await burst(method, path, body);
  const counts = {};
  for (const x of r) counts[x.status] = (counts[x.status] ?? 0) + 1;
  const first = r.findIndex((x) => x.status === 429);
  const limited = r.filter((x) => x.status === 429);
  const ra = [...new Set(limited.map((x) => x.retryAfter))].join(', ');
  const codes = [...new Set(limited.map((x) => x.code))].join(', ');
  if (first < 0) missing++;
  const shown = path.replaceAll(ZERO, '{id}');
  console.log(
    `| ${cls} | ${method} ${shown} | ${Object.entries(counts)
      .map(([s, n]) => `${s}×${n}`)
      .join(' ')} | ${first < 0 ? 'never' : `#${first + 1}`} | ${ra || '—'} | ${codes || '—'} |`,
  );
}
process.exit(missing ? 1 : 0);
