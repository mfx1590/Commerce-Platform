#!/usr/bin/env node
/**
 * Turns one load run's output directory into a Markdown report (#359):
 *
 *   node infra/load/report.mjs <out-dir>          # writes <out-dir>/report.md and prints it
 *
 * Reads meta.json, load-summary.json, pg-load.jsonl and — when the ceiling ran — ceiling-summary.json,
 * pg-ceiling.jsonl and ceiling-raw.csv.gz. Every number in the report comes from those files.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const TARGET = {
  p95Ms: 500,
  errorRate: 0.001,
  browseRps: 50,
  ordersPerMin: 30,
  routes: ['store', 'list', 'detail'],
};
export const ROUTE_LABEL = {
  store: 'GET /store',
  list: 'GET /store/products',
  detail: 'GET /store/products/{handle}',
  search: 'GET /store/products?q=',
  cart_create: 'POST /store/carts',
  line_item: 'POST …/line-items',
  cart_update: 'PATCH /store/carts/{id} (email, addresses)',
  shipping_options: 'GET …/shipping-options',
  shipping_select: 'PATCH /store/carts/{id} (shipping option)',
  payment_session: 'POST …/payment-session (manual)',
  complete: 'POST …/complete (Idempotency-Key)',
};

const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined);
const readJsonl = (f) =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((x) => !x.error)
    : [];

export const durationSeconds = (d) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(d).trim());
  if (!m) return Number(d) || 0;
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
};

/** Per-route stats from a k6 summary (sub-metrics exist because every route has a threshold). */
export function routeStats(summary) {
  const out = {};
  for (const route of Object.keys(ROUTE_LABEL)) {
    const d = summary.metrics[`http_req_duration{route:${route}}`];
    if (!d || !d.values.count) continue;
    const f = summary.metrics[`http_req_failed{route:${route}}`];
    out[route] = {
      count: d.values.count,
      p50: d.values.med,
      p95: d.values['p(95)'],
      p99: d.values['p(99)'],
      max: d.values.max,
      failRate: f ? f.values.rate : 0,
    };
  }
  return out;
}

/** The application pool's connections (role platform_app) over a sampler timeline. */
export function poolStats(samples, poolMax) {
  const app = samples.map((s) => s.byRole?.platform_app ?? { total: 0, active: 0, idle_in_tx: 0 });
  const n = samples.length || 1;
  const busy = app.map((a) => a.active + a.idle_in_tx);
  const saturated = busy.filter((b) => b >= poolMax).length;
  const waits = {};
  for (const s of samples)
    for (const [k, v] of Object.entries(s.waits || {})) waits[k] = (waits[k] ?? 0) + v;
  const lock = samples.map((s) => s.lockWaits || 0);
  return {
    samples: samples.length,
    maxTotal: Math.max(0, ...app.map((a) => a.total)),
    maxBusy: Math.max(0, ...busy),
    meanBusy: busy.reduce((a, b) => a + b, 0) / n,
    saturatedShare: saturated / n,
    maxLockWaits: Math.max(0, ...lock),
    meanLockWaits: lock.reduce((a, b) => a + b, 0) / n,
    lockSampleShare: lock.filter((x) => x > 0).length / n,
    topWaits: Object.entries(waits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
  };
}

/** Parses k6's CSV output into { metric, t (s), value, route }. */
export function parseK6Csv(text) {
  const lines = text.split('\n').filter(Boolean);
  const head = lines.shift().split(',');
  const col = (n) => head.indexOf(n);
  const [im, it, iv, ir, ix] = [
    col('metric_name'),
    col('timestamp'),
    col('metric_value'),
    col('route'),
    col('extra_tags'),
  ];
  return lines.map((l) => {
    const c = l.split(',');
    let route = ir >= 0 ? c[ir] : '';
    if (!route && ix >= 0) route = (/(?:^|&)route=([^&]*)/.exec(c[ix] || '') || [])[1] || '';
    return { metric: c[im], t: Number(c[it]), value: Number(c[iv]), route };
  });
}

const pct = (xs, p) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/**
 * The ceiling ramp, step by step: target rate, orders achieved per minute, complete-step p50/p95, and the
 * lock waits Postgres saw. Steps are `5 s ramp + hold`, in order, from the first sample.
 */
export function ceilingSteps(rows, samples, steps, holdSeconds) {
  if (!rows.length) return [];
  // A reduce, not Math.min(...rows): a full ceiling run has hundreds of thousands of rows, and spreading
  // them as arguments overflows the stack (the first full laptop run's report failed exactly there).
  // The ramp starts at the first placement request, not the first row: setup's catalogue discovery comes
  // first and would shift every step window by its length.
  const firstPlacement = rows.reduce(
    (m, r) => (r.route === 'cart_create' && r.t < m ? r.t : m),
    Infinity,
  );
  const t0 = Number.isFinite(firstPlacement)
    ? firstPlacement
    : rows.reduce((m, r) => (r.t < m ? r.t : m), Infinity);
  const firstSuspend = suspends(samples)[0];
  return steps.map((rate, i) => {
    const from = t0 + i * (holdSeconds + 5) + 5;
    const to = from + holdSeconds;
    // From the first host suspend on, k6's timeline and the host's no longer line up: those steps are void.
    const valid = !firstSuspend || to * 1000 <= firstSuspend.from;
    const inStep = rows.filter((r) => r.t >= from && r.t < to);
    const placed = inStep
      .filter((r) => r.metric === 'orders_placed')
      .reduce((a, r) => a + r.value, 0);
    const complete = inStep
      .filter((r) => r.metric === 'http_req_duration' && r.route === 'complete')
      .map((r) => r.value);
    const failed = inStep.filter((r) => r.metric === 'placement_failed');
    const lock = samples
      .filter((s) => s.t / 1000 >= from && s.t / 1000 < to)
      .map((s) => s.lockWaits || 0);
    return {
      rate,
      achievedPerMin: placed / (holdSeconds / 60),
      completeP50: pct(complete, 50),
      completeP95: pct(complete, 95),
      failShare: failed.length ? failed.filter((r) => r.value > 0).length / failed.length : 0,
      meanLockWaits: lock.length ? lock.reduce((a, b) => a + b, 0) / lock.length : 0,
      valid,
    };
  });
}

/** The knee: the first step that achieved under 90% of its target rate, or whose complete p95 passed 500 ms. */
export function knee(allSteps) {
  const steps = allSteps.filter((s) => s.valid !== false);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    // Short of the step's rate by more than 10% AND more than 2 orders/min (a step is only a minute of
    // arrivals, so one late order must not read as a knee), or complete p95 over 500 ms, or failures.
    const short = s.rate - s.achievedPerMin;
    if (
      (short > 0.1 * s.rate && short > 2) ||
      (s.completeP95 ?? 0) > TARGET.p95Ms ||
      s.failShare > 0.01
    ) {
      return { index: i, step: s, lastGood: i > 0 ? steps[i - 1] : undefined };
    }
  }
  return undefined;
}

/**
 * The app-pool ramp (`pool.js`), step by step. Latency and throughput come from the per-step sub-metrics
 * (requests are tagged `step:sN`); busy connections from the sampler, assigned to a step by time since the
 * sampler started (it starts ~1–2 s before k6, so a step's window is approximate by that much).
 */
export function poolSteps(summary, samples, poolMax) {
  const cfg = summary?.pool_steps;
  if (!cfg) return [];
  const span = cfg.hold_s + cfg.ramp_s;
  const t0 = samples.length ? samples[0].t : 0;
  const firstSuspend = suspends(samples)[0];
  return cfg.steps.map((rate, i) => {
    const valid = !firstSuspend || t0 + (i + 1) * span * 1000 <= firstSuspend.from;
    const d = summary.metrics[`http_req_duration{step:s${i}}`]?.values;
    const f = summary.metrics[`http_req_failed{step:s${i}}`]?.values;
    const inStep = samples.filter((s) => {
      const sec = (s.t - t0) / 1000;
      return sec >= i * span + cfg.ramp_s && sec < (i + 1) * span;
    });
    const busy = inStep.map(
      (s) => (s.byRole?.platform_app?.active ?? 0) + (s.byRole?.platform_app?.idle_in_tx ?? 0),
    );
    return {
      rate,
      achievedRps: d ? d.count / span : 0,
      p50: d?.med,
      p95: d?.['p(95)'],
      p99: d?.['p(99)'],
      failRate: f?.rate ?? 0,
      maxBusy: busy.length ? Math.max(...busy) : 0,
      saturatedShare: busy.length ? busy.filter((b) => b >= poolMax).length / busy.length : 0,
      valid,
    };
  });
}

/** The pool's knee: the first step that fell >10% short of its rate, passed 500 ms p95, or failed >1%. */
export function poolKnee(allSteps) {
  const steps = allSteps.filter((s) => s.valid !== false);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.achievedRps < 0.9 * s.rate || (s.p95 ?? 0) > TARGET.p95Ms || s.failRate > 0.01) {
      return { index: i, step: s, lastGood: i > 0 ? steps[i - 1] : undefined };
    }
  }
  return undefined;
}

/**
 * Where the host stopped: gaps over `minSeconds` between consecutive sampler lines. The sampler writes once a
 * second, so a long gap means the machine itself was suspended (a laptop's Modern Standby on battery did
 * exactly this, twice, on 2026-10-06) — k6, the core and Postgres froze with it, and the numbers across that
 * window are not a measurement. Returned as { from, to, seconds } in epoch ms.
 */
export function suspends(samples, minSeconds = 5) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const gap = (samples[i].t - samples[i - 1].t) / 1000;
    if (gap > minSeconds) out.push({ from: samples[i - 1].t, to: samples[i].t, seconds: gap });
  }
  return out;
}

const hhmm = (t) => new Date(t).toISOString().slice(11, 19);
/** A banner for a phase whose host was suspended, or '' when it ran through. */
export function suspendBanner(samples, phase) {
  const s = suspends(samples);
  if (!s.length) return '';
  const total = s.reduce((a, x) => a + x.seconds, 0);
  return `> **⚠ ${phase}: NOT A VALID MEASUREMENT.** The host was suspended ${s.length} time(s), ${Math.round(total)} s in all (${s.map((x) => `${hhmm(x.from)}–${hhmm(x.to)} UTC`).join(', ')}); k6, the core and Postgres froze with it. Numbers from this phase are shown for the record only.`;
}

/** Thresholds k6 reports as crossed, as `metric: expression`. */
export function crossedThresholds(summary) {
  const out = [];
  for (const [name, m] of Object.entries(summary?.metrics ?? {})) {
    for (const [expr, t] of Object.entries(m.thresholds ?? {}))
      if (t.ok === false) out.push(`${name}: ${expr}`);
  }
  return out;
}

const ms = (v) => (v === undefined ? '—' : `${Math.round(v)} ms`);
const verdict = (ok) => (ok ? '✅ pass' : '❌ fail');

export function render({
  meta,
  load,
  pgLoad,
  ceiling,
  pgCeiling,
  ceilingRows,
  pool: poolRun,
  pgPool,
}) {
  const L = [];
  const seconds = durationSeconds(meta.duration || '10m');
  const routes = routeStats(load);
  const browseCount = ['store', 'list', 'detail', 'search'].reduce(
    (a, r) => a + (routes[r]?.count ?? 0),
    0,
  );
  const placed = load.metrics.orders_placed?.values.count ?? 0;
  // From the load routes only (setup's discovery requests are tagged `setup` and stay out), split by where
  // a failure happened: a response the core sent (>= 400), or a connection that never opened (status 0).
  const loadRequests = Object.values(routes).reduce((a, r) => a + r.count, 0);
  const loadFailed = Object.values(routes).reduce((a, r) => a + r.failRate * r.count, 0);
  const failedRate = loadRequests ? loadFailed / loadRequests : 0;
  const transport = load.metrics.transport_errors?.values.count ?? 0;
  const httpErr = load.metrics.http_errors?.values.count ?? 0;
  const coreRate = loadRequests ? httpErr / loadRequests : 0;
  const wantOrders = meta.orders_per_min || TARGET.ordersPerMin;
  const wantRps = meta.browse_rps || TARGET.browseRps;
  const dropped = load.metrics.dropped_iterations?.values.count ?? 0;
  const ordersPerMin = placed / (seconds / 60);
  const browseRps = browseCount / seconds;
  const pool = poolStats(pgLoad, meta.db_pool_max || 10);

  L.push(`# Load test — ${String(meta.started).slice(0, 10)} (${meta.host})`, '');
  L.push(
    `Target (owner, 2026-10-06, #359): **${TARGET.ordersPerMin} orders/min for 10 min while browsing at ${TARGET.browseRps} req/s; p95 < ${TARGET.p95Ms} ms** for GET /store, product list and product detail; **errors < 0.1%**.`,
    '',
  );
  L.push(
    `**Machine:** ${meta.host} — ${meta.cpu} (${meta.cores} logical cores), ${meta.memory_gb} GB RAM, ${meta.os}, Node ${meta.node}. k6 \`${meta.k6_image}\` in Docker; the core, Postgres, Redis and k6 all on the same machine, so they compete for it. ${
      meta.host === 'laptop'
        ? '**These are laptop numbers, not a server’s.**'
        : '**A shared CI runner — the second datapoint, not a production server either.**'
    } Run: ${meta.duration} at ${meta.browse_rps} browse req/s + ${meta.orders_per_min} orders/min; app pool \`DB_POOL_MAX=${meta.db_pool_max}\` (the default, unchanged).`,
    '',
  );

  L.push('## Against the target', '');
  const targetBanner = suspendBanner(pgLoad, 'Target run');
  if (targetBanner) L.push(targetBanner, '');
  L.push('| line | target | measured | |', '|---|---|---|---|');
  for (const r of TARGET.routes) {
    const s = routes[r];
    L.push(
      `| ${ROUTE_LABEL[r]} p95 | < ${TARGET.p95Ms} ms | ${ms(s?.p95)} | ${verdict(s && s.p95 < TARGET.p95Ms)} |`,
    );
  }
  L.push(
    `| errors, every load request | < 0.1% | ${(failedRate * 100).toFixed(3)}% (${Math.round(loadFailed)} of ${loadRequests}) | ${verdict(failedRate < TARGET.errorRate)} |`,
    `| — answered by the core with an error (HTTP ≥ 400) | < 0.1% | ${(coreRate * 100).toFixed(3)}% (${httpErr}) | ${verdict(coreRate < TARGET.errorRate)} |`,
    `| — never reached the core (connection not opened, status 0) | — | ${transport} | ${transport ? '⚠ harness' : '✅ none'} |`,
  );
  L.push(
    `| orders placed per minute | ${wantOrders} sustained | ${ordersPerMin.toFixed(1)} (${placed} in ${seconds / 60} min) | ${verdict(ordersPerMin >= 0.98 * wantOrders)} |`,
  );
  L.push(
    `| browse throughput | ${wantRps} req/s | ${browseRps.toFixed(1)} req/s | ${verdict(browseRps >= 0.98 * wantRps)} |`,
  );
  L.push(
    `| iterations k6 could not start in time | 0 | ${dropped} | ${verdict(dropped === 0)} |`,
    '',
  );
  if (wantOrders !== TARGET.ordersPerMin || wantRps !== TARGET.browseRps || seconds !== 600) {
    L.push(
      `_This run was configured below the owner's target (${meta.duration}, ${wantRps} req/s, ${wantOrders} orders/min): the rate lines compare against what was configured; only a 10m / 50 / 30 run answers the target._`,
      '',
    );
  }
  const crossed = crossedThresholds(load);
  if (crossed.length) {
    L.push(
      `_k6 itself exited 99: it crossed ${crossed.map((c) => `\`${c}\``).join(', ')}. \`placement_failed\` is per placement (any of the seven requests failing fails the placement), so one failed request in ${placed} orders is ${((1 / Math.max(1, placed)) * 100).toFixed(2)}% there — read it with the error split below._`,
      '',
    );
  }
  if (transport) {
    L.push(
      `_${transport} request(s) never reached the core: the connection from k6's container to the host was not opened (\`dial: i/o timeout\`). On the laptop k6 runs in Docker Desktop and reaches the core through \`host.docker.internal\`; on the Linux runner it uses \`--network host\`. They are counted, not hidden; the line above them is what the core itself answered._`,
      '',
    );
  }

  L.push(
    '## Latency per route (target run)',
    '',
    '| route | requests | p50 | p95 | p99 | max | failed |',
    '|---|---|---|---|---|---|---|',
  );
  for (const [r, s] of Object.entries(routes)) {
    L.push(
      `| ${ROUTE_LABEL[r]} | ${s.count} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.max)} | ${(s.failRate * 100).toFixed(2)}% |`,
    );
  }
  const journey = load.metrics.placement_journey_ms?.values;
  if (journey)
    L.push(
      '',
      `Whole placement journey (7 requests): p50 ${ms(journey.med)}, p95 ${ms(journey['p(95)'])}, p99 ${ms(journey['p(99)'])}.`,
    );
  L.push('');

  L.push(
    '## Bottleneck 1 — the app pool (four connections per GET /store)',
    '',
    `The core's app pool is \`DB_POOL_MAX\` = ${meta.db_pool_max} connections (role \`platform_app\`). Sampled once a second from \`pg_stat_activity\` during the target run (${pool.samples} samples):`,
    '',
    `- connections held by role \`platform_app\`: max **${pool.maxTotal}** — more than \`DB_POOL_MAX\` when it is, because more than one pool in the core connects as that role; the request pool is the one capped at ${meta.db_pool_max};`,
    `- busy (active or idle in a transaction): max **${pool.maxBusy}**, mean ${pool.meanBusy.toFixed(1)};`,
    `- **saturated** (every pool connection busy) in **${(pool.saturatedShare * 100).toFixed(1)}%** of samples.`,
    '',
    `With four connections per \`GET /store\`, ${meta.db_pool_max} connections serve at most ${Math.floor((meta.db_pool_max || 10) / 4)} such requests at once; every further request waits for a connection inside the core, which Postgres cannot see — it shows up as latency on the routes above, not as waits here. Top wait events: ${pool.topWaits.map(([k, v]) => `\`${k}\` ×${v}`).join(', ') || 'none'}.`,
    '',
  );
  const pSteps = poolSteps(poolRun, pgPool ?? [], meta.db_pool_max || 10);
  if (pSteps.length) {
    L.push(
      `\`GET /store\` alone, stepped up (\`pool.js\`), ${poolRun.pool_steps.hold_s} s per step — where the pool saturates:`,
      '',
    );
    const poolBanner = suspendBanner(pgPool ?? [], 'App-pool ramp');
    if (poolBanner) L.push(poolBanner, '');
    L.push(
      '| target | achieved | p50 | p95 | p99 | failed | app connections busy (max) | samples saturated |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const s of pSteps) {
      const mark = s.valid === false ? ' ⚠ void (host suspended)' : '';
      L.push(
        `| ${s.rate} req/s${mark} | ${s.achievedRps.toFixed(1)} req/s | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${(s.failRate * 100).toFixed(2)}% | ${s.maxBusy} | ${(s.saturatedShare * 100).toFixed(0)}% |`,
      );
    }
    const validPool = pSteps.filter((s) => s.valid !== false);
    const k = poolKnee(pSteps);
    let verdictLine;
    if (k) {
      verdictLine = `**Knee:** at ${k.step.rate} req/s \`GET /store\` stopped keeping up (achieved ${k.step.achievedRps.toFixed(1)} req/s, p95 ${ms(k.step.p95)}, pool saturated in ${(k.step.saturatedShare * 100).toFixed(0)}% of samples). ${k.lastGood ? `The last step that held was ${k.lastGood.rate} req/s.` : 'Even the first step did not hold.'}`;
    } else if (!validPool.length) {
      verdictLine = '**No valid step:** the host was suspended before the first step ended.';
    } else if (validPool.length < pSteps.length) {
      verdictLine = `**No knee within the valid steps:** every step up to ${validPool[validPool.length - 1].rate} req/s held; the steps after it are void (host suspended), so the knee is above ${validPool[validPool.length - 1].rate} req/s and not measured by this run.`;
    } else {
      verdictLine = `**No knee within the ramp:** every step up to ${pSteps[pSteps.length - 1].rate} req/s held.`;
    }
    L.push('', verdictLine, '');
  }

  L.push('## Bottleneck 2 — the store-row lock on placement', '');
  L.push(
    "Every order takes its store's row lock: migration 0006's trigger `app.assign_order_display_id()` runs `UPDATE store SET next_order_number … RETURNING` inside the order insert and holds it until `completeCart` commits, so one store's placements serialise on the rest of that transaction (lines, payment, reservations, attribution, outbox).",
    '',
    `During the target run Postgres saw lock waits in ${(pool.lockSampleShare * 100).toFixed(1)}% of samples (max ${pool.maxLockWaits} sessions waiting at once, mean ${pool.meanLockWaits.toFixed(2)}).`,
    '',
  );
  const complete = routes.complete;
  if (complete) {
    // A floor under the ceiling: placements fully serial on the store row, one at a time, each holding it for
    // the whole complete request. The lock is held only from the order insert to the commit, so the real
    // ceiling is higher than this — the ramp below is the measurement, this is the floor under it.
    L.push(
      `**Serial bound:** \`complete\` took p50 ${ms(complete.p50)} / p95 ${ms(complete.p95)} in the target run. Even if every placement held the store row for its whole \`complete\` request, one store could place about **${Math.floor(60000 / complete.p50)} orders/min** at p50 latency (${Math.floor(60000 / complete.p95)} at p95) — ${Math.floor(60000 / complete.p95 / TARGET.ordersPerMin)}× the target. The lock is held only from the order insert to the commit, so the true ceiling is above that.`,
      '',
    );
  }
  if (ceiling && ceilingRows?.length) {
    const steps = ceilingSteps(
      ceilingRows,
      pgCeiling,
      meta.ceiling_steps || [30, 60, 120, 240, 480, 960],
      durationSeconds(meta.ceiling_step || '1m'),
    );
    L.push('Placement-only ramp on one store (`ceiling.js`), one minute per step:', '');
    const ceilingBanner = suspendBanner(pgCeiling ?? [], 'Placement ceiling ramp');
    if (ceilingBanner) L.push(ceilingBanner, '');
    L.push(
      '| target | achieved | complete p50 | complete p95 | failed | lock waits (mean) |',
      '|---|---|---|---|---|---|',
    );
    for (const s of steps) {
      L.push(
        `| ${s.rate}/min${s.valid === false ? ' ⚠ void (host suspended)' : ''} | ${s.achievedPerMin.toFixed(1)}/min | ${ms(s.completeP50)} | ${ms(s.completeP95)} | ${(s.failShare * 100).toFixed(1)}% | ${s.meanLockWaits.toFixed(2)} |`,
      );
    }
    const k = knee(steps);
    const validCeiling = steps.filter((s) => s.valid !== false);
    let ceilingVerdict;
    if (k) {
      ceilingVerdict = `**Knee:** at ${k.step.rate}/min the store stopped keeping up (achieved ${k.step.achievedPerMin.toFixed(1)}/min, complete p95 ${ms(k.step.completeP95)}). ${k.lastGood ? `The last step that held was ${k.lastGood.rate}/min, so on this machine one store's ceiling lies between ${k.lastGood.rate} and ${k.step.rate} orders/min.` : 'Even the first step did not hold.'}`;
    } else if (!validCeiling.length) {
      ceilingVerdict = '**No valid step:** the host was suspended before the first step ended.';
    } else if (validCeiling.length < steps.length) {
      ceilingVerdict = `**No knee within the valid steps:** every step up to ${validCeiling[validCeiling.length - 1].rate}/min held; the steps after it are void (host suspended), so one store's ceiling is above ${validCeiling[validCeiling.length - 1].rate}/min and not measured by this run.`;
    } else {
      ceilingVerdict = `**No knee within the ramp:** every step up to ${steps[steps.length - 1].rate}/min held, so one store's ceiling on this machine is above that.`;
    }
    L.push('', ceilingVerdict, '');
  } else {
    L.push('_The ceiling ramp did not run (LOAD_SKIP_CEILING)._', '');
  }

  L.push(
    '## What Grafana would need',
    '',
    '- **Traces and request metrics from the core:** an OpenTelemetry SDK in `apps/core` exporting to the collector the observability profile already runs (`infra/observability`); today the core exports nothing, so these numbers come only from k6 and `pg_stat_activity`.',
    '- **Pool metrics:** the app pool’s `totalCount`, `idleCount` and `waitingCount` (node-postgres exposes all three) as gauges — the waiting count is the saturation Postgres cannot see.',
    '- **Postgres:** `postgres_exporter` (connections by state, lock waits, `pg_stat_statements`) next to the stack’s Postgres.',
    '- **k6:** `--out experimental-prometheus-rw` to the stack’s Prometheus, so a run lands on the same dashboards as the core.',
    '',
  );
  return L.join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: report.mjs <out-dir>');
    process.exit(2);
  }
  const csv = join(dir, 'ceiling-raw.csv.gz');
  const md = render({
    meta: readJson(join(dir, 'meta.json')) ?? {},
    load: readJson(join(dir, 'load-summary.json')),
    pgLoad: readJsonl(join(dir, 'pg-load.jsonl')),
    ceiling: readJson(join(dir, 'ceiling-summary.json')),
    pgCeiling: readJsonl(join(dir, 'pg-ceiling.jsonl')),
    ceilingRows: existsSync(csv) ? parseK6Csv(gunzipSync(readFileSync(csv)).toString('utf8')) : [],
    pool: readJson(join(dir, 'pool-summary.json')),
    pgPool: readJsonl(join(dir, 'pg-pool.jsonl')),
  });
  writeFileSync(join(dir, 'report.md'), `${md}\n`);
  console.info(md);
}
