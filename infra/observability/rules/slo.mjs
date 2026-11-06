#!/usr/bin/env node
/**
 * The SLOs as Prometheus rules (#730, plan D3). infra/observability/SLO.md is the prose; this is the one place
 * the SLIs are defined, and it GENERATES slo.rules.yml (committed, loaded by prometheus.yml, checked by promtool):
 *
 *   node infra/observability/rules/slo.mjs           # rewrite slo.rules.yml
 *   node infra/observability/rules/slo.mjs --check   # fail if slo.rules.yml is not what this generates (CI)
 *
 * For every SLO: an error-ratio recording rule per window (5m 30m 1h 2h 6h 1d 3d), named
 * `slo:error_ratio:<window>{slo="<name>"}`, and two multi-window burn-rate alerts (Google SRE workbook, ch. 5):
 *
 *   page    — budget burning at 14.4× over 1h AND 5m, or 6× over 6h AND 30m (2% / 5% of a 28-day budget)
 *   ticket  — 3× over 1d AND 2h, or 1× over 3d AND 6h (10% / 10% of the budget)
 *
 * The short window in each pair makes the alert stop soon after the burning does.
 *
 * The core's series are window 1's #729 (OTel → collector-contrib prometheus exporter): the histogram
 * `http_server_request_duration_seconds` with EXACTLY `service_name, http_route, http_request_method,
 * http_status_class, store_id`. Availability = 1 − 5xx/all from the histogram's `_count`; latency = the share of
 * requests under a bucket boundary (`le`) — so every latency threshold must be one of #729's boundaries.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import prettier from 'prettier';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WINDOWS = ['5m', '30m', '1h', '2h', '6h', '1d', '3d'];
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'slo.rules.yml');

const CORE = 'service_name="core"';
const STORE = `${CORE}, http_route=~"/store(/.*)?"`;
const ADMIN = `${CORE}, http_route=~"/admin(/.*)?"`;
const BROWSE = `${CORE}, http_request_method="GET", http_route=~"/store|/store/products|/store/products/\\\\{handle\\\\}"`;
const ADMIN_METRICS = `${CORE}, http_route=~"/admin/metrics|/admin/metrics/query"`;
const COMPLETE = `${CORE}, http_request_method="POST", http_route="/store/carts/{cartId}/complete"`;

/**
 * A bucket-boundary matcher. Prometheus 3 NORMALISES classic-histogram `le` labels at scrape: an integer boundary is
 * stored with `.0` (`2` -> "2.0", `10000` -> "10000.0"), so `le="2"` selects nothing (checked on the compose
 * Prometheus v3.0.1 and on #729's live run, 2026-11-06). The regex matches both spellings. The tests in slo.test.yml
 * spell the stored form out literally, so a regression to an exact "2" empties the burning cases and fails
 * `promtool test rules`.
 */
const le = (n) =>
  `le=~"${Number.isInteger(n) ? `${n}(\\\\.0)?` : String(n).replace('.', '\\\\.')}"`;

const reqRate = (sel, w) => `sum(rate(http_server_request_duration_seconds_count{${sel}}[${w}]))`;

/**
 * An availability SLI: the share of requests answered with a 5xx. OTel creates the 5xx series on the first 5xx, so
 * until then it does not exist; `or vector(0)` makes that a ratio of 0, not "no data" (which would record nothing).
 */
const availability = (sel) => (w) =>
  `(\n  ${reqRate(`${sel}, http_status_class="5xx"`, w)}\n  or vector(0)\n)\n/\n${reqRate(sel, w)}`;

/** A latency SLI: the share of requests slower than `seconds` (a bucket boundary). */
const latency = (sel, seconds) => (w) =>
  `1 - (\n  sum(rate(http_server_request_duration_seconds_bucket{${sel}, ${le(seconds)}}[${w}]))\n  /\n  ${reqRate(sel, w)}\n)`;

/**
 * Every SLO. `target` is the good-event share over 28 days; the error budget is 1 − target. `source` says
 * where the target comes from — none is invented (SLO.md has the reasoning).
 */
export const SLOS = [
  {
    name: 'store-api-availability',
    summary: 'Store API: 99.9% of requests are not 5xx',
    target: 0.999,
    source: 'owner target errors < 0.1% (infra/load/reports/2026-10-06.md)',
    error: availability(STORE),
  },
  {
    name: 'store-api-latency',
    summary: 'Store API browse (GET /store, product list, product detail): 95% under 500 ms',
    target: 0.95,
    source: 'owner target p95 < 500 ms (infra/load/reports/2026-10-06.md)',
    error: latency(BROWSE, 0.5),
  },
  {
    name: 'admin-api-availability',
    summary: 'Admin API: 99.9% of requests are not 5xx',
    target: 0.999,
    source: 'the same errors < 0.1% target, applied to the Admin API',
    error: availability(ADMIN),
  },
  {
    name: 'admin-metrics-latency',
    summary: 'Admin metrics API (/admin/metrics, /admin/metrics/query): 95% under 300 ms',
    target: 0.95,
    source: 'Integration 5 metrics p95 < 300 ms (#612)',
    error: latency(ADMIN_METRICS, 0.3),
  },
  {
    name: 'checkout-availability',
    summary: 'Checkout completion: 99.9% of POST /store/carts/{cartId}/complete are not 5xx',
    target: 0.999,
    source: 'owner target errors < 0.1%; the load runs placed 900 orders with no failure',
    error: availability(COMPLETE),
  },
  {
    name: 'checkout-latency',
    summary: 'Checkout completion: 95% under 2 s',
    target: 0.95,
    source:
      'manager 2026-11-06: in production complete calls the payment provider, which the mock-backed load run does not measure',
    error: latency(COMPLETE, 2),
  },
  {
    name: 'analytics-ingest-lag',
    summary:
      'Analytics ingest: 95% of events in ClickHouse within 10 s of the relay publishing them',
    target: 0.95,
    source: 'Integration 5 ingest lag p95 < 10 s (#612)',
    error: (w) =>
      `1 - (\n  sum(rate(analytics_ingest_ingest_delay_milliseconds_bucket{${le(10000)}}[${w}]))\n  /\n  sum(rate(analytics_ingest_ingest_delay_milliseconds_count[${w}]))\n)`,
  },
  {
    name: 'outbox-relay-lag',
    summary: 'Outbox relay: the oldest unpublished row is younger than 10 s in 99% of minutes',
    target: 0.99,
    source:
      "derived from #612's 10 s end-to-end ingest budget, which includes the relay — METRIC PENDING (window 14 exports the gauge)",
    // The gauge is sampled per minute; a minute is bad when the oldest unpublished row is 10 s or older.
    error: (w) =>
      `1 - avg_over_time((max(outbox_relay_lag_oldest_seconds{service_name="outbox-relay"}) < bool 10)[${w}:1m])`,
  },
];

const indent = (text, n) =>
  text
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n');

const burn = (slo, factor, long, short) => {
  const budget = +(1 - slo.target).toFixed(6);
  const t = +(factor * budget).toFixed(6);
  return `(\n  slo:error_ratio:${long}{slo="${slo.name}"} > ${t}\n  and\n  slo:error_ratio:${short}{slo="${slo.name}"} > ${t}\n)`;
};

export function generate() {
  const L = [
    '# GENERATED by infra/observability/rules/slo.mjs — edit that file, then run it. CI fails on a hand edit.',
    '# The SLOs in prose: infra/observability/SLO.md. Tested by slo.test.yml (promtool test rules).',
    'groups:',
  ];
  for (const slo of SLOS) {
    L.push(`  - name: slo-${slo.name}`, '    rules:');
    for (const w of WINDOWS) {
      L.push(
        `      - record: slo:error_ratio:${w}`,
        '        expr: |',
        indent(slo.error(w), 10),
        '        labels:',
        `          slo: ${slo.name}`,
      );
    }
    const pageExpr = `${burn(slo, 14.4, '1h', '5m')}\nor\n${burn(slo, 6, '6h', '30m')}`;
    const ticketExpr = `${burn(slo, 3, '1d', '2h')}\nor\n${burn(slo, 1, '3d', '6h')}`;
    for (const [sev, expr, factor] of [
      ['page', pageExpr, '14.4× (1h/5m) or 6× (6h/30m)'],
      ['ticket', ticketExpr, '3× (1d/2h) or 1× (3d/6h)'],
    ]) {
      L.push(
        `      - alert: SLOBurn_${slo.name.replace(/-/g, '_')}_${sev}`,
        '        expr: |',
        indent(expr, 10),
        `        for: ${sev === 'page' ? '2m' : '15m'}`,
        '        labels:',
        `          severity: ${sev}`,
        `          slo: ${slo.name}`,
        '        annotations:',
        `          summary: ${JSON.stringify(`${slo.summary}: error budget burning at ${factor}`)}`,
        `          target: '${slo.target}'`,
        `          source: ${JSON.stringify(slo.source)}`,
        "          runbook: 'infra/observability/SLO.md'",
      );
    }
  }
  return `${L.join('\n')}\n`;
}

/**
 * Synthetic input series per SLO: `bad` is the share of bad events (or, for the relay, whether every minute is
 * bad). One request a second; the rules only see ratios, so the absolute rate does not matter. Every `le` is the
 * literal Prometheus 3 stores ("2.0", not "2"), written out here rather than taken from `le()`, so the tests check it.
 */
function inputSeries(slo, bad) {
  const per = (n) => `0+${n}x240`; // 4 h of one-minute samples
  const good = Math.round(60 * (1 - bad));
  const hist = (base, extra, le) => [
    { series: `http_server_request_duration_seconds_count{${base}${extra}}`, values: per(60) },
    ...(le
      ? [
          {
            series: `http_server_request_duration_seconds_bucket{${base}${extra}, le="${le}"}`,
            values: per(good),
          },
        ]
      : []),
  ];
  const core = 'service_name="core", store_id="s1", ';
  switch (slo.name) {
    case 'store-api-availability':
    case 'admin-api-availability':
    case 'checkout-availability': {
      const route = {
        'store-api-availability': 'http_route="/store/products", http_request_method="GET"',
        'admin-api-availability': 'http_route="/admin/orders", http_request_method="GET"',
        'checkout-availability':
          'http_route="/store/carts/{cartId}/complete", http_request_method="POST"',
      }[slo.name];
      // Healthy: NO 5xx series at all, as on a live core that has never answered a 5xx (OTel creates the series on
      // the first one). The ratio must still be 0 and nothing may fire.
      return [
        {
          series: `http_server_request_duration_seconds_count{${core}${route}, http_status_class="2xx"}`,
          values: per(good),
        },
        ...(good < 60
          ? [
              {
                series: `http_server_request_duration_seconds_count{${core}${route}, http_status_class="5xx"}`,
                values: per(60 - good),
              },
            ]
          : []),
      ];
    }
    case 'store-api-latency':
      return hist(
        core,
        'http_route="/store/products/{handle}", http_request_method="GET", http_status_class="2xx"',
        '0.5',
      );
    case 'admin-metrics-latency':
      return hist(
        core,
        'http_route="/admin/metrics/query", http_request_method="POST", http_status_class="2xx"',
        '0.3',
      );
    case 'checkout-latency':
      return hist(
        core,
        'http_route="/store/carts/{cartId}/complete", http_request_method="POST", http_status_class="2xx"',
        '2.0',
      );
    case 'analytics-ingest-lag':
      return [
        {
          series:
            'analytics_ingest_ingest_delay_milliseconds_count{service_name="analytics-ingest"}',
          values: per(60),
        },
        {
          series:
            'analytics_ingest_ingest_delay_milliseconds_bucket{service_name="analytics-ingest", le="10000.0"}',
          values: per(good),
        },
      ];
    case 'outbox-relay-lag':
      return [
        {
          series: 'outbox_relay_lag_oldest_seconds{service_name="outbox-relay"}',
          values: bad ? '30x240' : '1x240',
        },
      ];
    default:
      throw new Error(`no test series for ${slo.name}`);
  }
}

const alertName = (slo, sev) => `SLOBurn_${slo.name.replace(/-/g, '_')}_${sev}`;
const expAlert = (slo, sev) => {
  const factor = sev === 'page' ? '14.4× (1h/5m) or 6× (6h/30m)' : '3× (1d/2h) or 1× (3d/6h)';
  return {
    exp_labels: { severity: sev, slo: slo.name },
    exp_annotations: {
      summary: `${slo.summary}: error budget burning at ${factor}`,
      target: String(slo.target),
      source: slo.source,
      runbook: 'infra/observability/SLO.md',
    },
  };
};

/** promtool `test rules` cases: for every SLO, a burning budget fires both alerts; a healthy one fires none. */
export function generateTests() {
  const tests = [];
  for (const slo of SLOS) {
    // Bad enough to cross 14.4× the budget everywhere (relay: every minute bad).
    const burning = slo.name === 'outbox-relay-lag' ? 1 : Math.min(1, 0.5 + 15 * (1 - slo.target));
    tests.push({
      name: `${slo.name}: a burning budget pages and tickets`,
      interval: '1m',
      input_series: inputSeries(slo, burning),
      alert_rule_test: [
        {
          eval_time: '90m',
          alertname: alertName(slo, 'page'),
          exp_alerts: [expAlert(slo, 'page')],
        },
        {
          eval_time: '90m',
          alertname: alertName(slo, 'ticket'),
          exp_alerts: [expAlert(slo, 'ticket')],
        },
      ],
    });
    tests.push({
      name: `${slo.name}: a healthy service stays silent`,
      interval: '1m',
      input_series: inputSeries(slo, 0),
      alert_rule_test: [
        { eval_time: '90m', alertname: alertName(slo, 'page'), exp_alerts: [] },
        { eval_time: '90m', alertname: alertName(slo, 'ticket'), exp_alerts: [] },
      ],
      promql_expr_test: [
        {
          expr: `slo:error_ratio:1h{slo="${slo.name}"}`,
          eval_time: '90m',
          exp_samples: [{ labels: `slo:error_ratio:1h{slo="${slo.name}"}`, value: 0 }],
        },
      ],
    });
  }
  // A JSON document is valid YAML, and promtool reads it as such; no YAML library is needed.
  const doc = {
    rule_files: ['slo.rules.yml'],
    evaluation_interval: '1m',
    tests,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const TEST_OUT = join(dirname(fileURLToPath(import.meta.url)), 'slo.test.yml');

/** Formats with the repo's own Prettier config, so `pnpm format:check` and `--check` agree on every byte. */
async function formatted(file, text) {
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(text, { ...options, filepath: file });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const outputs = [
    [OUT, await formatted(OUT, generate())],
    [
      TEST_OUT,
      await formatted(
        TEST_OUT,
        `# GENERATED by infra/observability/rules/slo.mjs — promtool test rules input.\n${generateTests()}`,
      ),
    ],
  ];
  if (process.argv.includes('--check')) {
    let bad = 0;
    for (const [file, text] of outputs) {
      if (readFileSync(file, 'utf8') !== text) {
        console.error(
          `FAIL ${file} is not what slo.mjs generates: run node infra/observability/rules/slo.mjs`,
        );
        bad = 1;
      }
    }
    if (bad) process.exit(1);
    console.info(`ok slo.rules.yml and slo.test.yml match slo.mjs (${SLOS.length} SLOs)`);
  } else {
    for (const [file, text] of outputs) writeFileSync(file, text);
    console.info(`wrote slo.rules.yml and slo.test.yml (${SLOS.length} SLOs)`);
  }
}
