/* global __ENV -- k6 runtime global */
// The admin-metrics leg of the scheduled SLO regression (#785): the Admin API's metrics catalogue and typed query, as
// the analyst sees them, on the production auth path: a real staff JWT from the compose Keycloak (verified by the
// core against JWKS), and the core's OpenFGA check on every request. Only load.js loads this, and only with
// LOAD_METRICS=1 (the workflow seeds ClickHouse first: infra/load/ch-seed.mjs).
//
// Credentials: the staff realm's DEV user (infra/keycloak/staff-realm.json, the same one CI's live job uses). The
// workflow reads its password from that file at run time and passes it in METRICS_STAFF_PASSWORD: nothing here or in
// the workflow repeats it.
import http from 'k6/http';
import { check, fail } from 'k6';
import { BASE, httpErrors, transportErrors } from './lib.js';

// localhost: the staff realm's frontendUrl, which every token's `iss` carries and the core pins (see load.yml).
const KEYCLOAK = (__ENV.KEYCLOAK_URL || 'http://localhost:8180').replace(/\/$/, '');
const USER = __ENV.METRICS_STAFF_USER || 'analyst';

// Per VU: a token and when it expires. Re-granted a minute before expiry (the realm's tokens live 15 min).
let token = null;
let expiresAt = 0;

function staffToken() {
  if (token && Date.now() < expiresAt - 60000) return token;
  const res = http.post(
    `${KEYCLOAK}/realms/staff/protocol/openid-connect/token`,
    {
      grant_type: 'password',
      client_id: 'test-cli',
      username: USER,
      password: __ENV.METRICS_STAFF_PASSWORD || '',
      scope: 'openid',
    },
    { tags: { route: 'setup' } },
  );
  if (res.status !== 200) fail(`staff token for ${USER}: Keycloak answered ${res.status}`);
  const body = res.json();
  token = body.access_token;
  expiresAt = Date.now() + Number(body.expires_in || 300) * 1000;
  return token;
}

function adminReq(method, path, body, route) {
  const params = {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken()}` },
    tags: { route },
  };
  const res = http.request(
    method,
    `${BASE}${path}`,
    body === undefined ? null : JSON.stringify(body),
    params,
  );
  if (route !== 'setup') {
    if (res.status === 0) transportErrors.add(1, { route });
    else if (res.status >= 400) httpErrors.add(1, { route, status: String(res.status) });
  }
  return res;
}

/** Once (route `setup`): the metrics the analyst may query by store, the stores in scope, and the seeded date range. */
export function metricsSetup() {
  const res = adminReq('GET', '/admin/metrics', undefined, 'setup');
  if (res.status !== 200)
    fail(
      `GET /admin/metrics answered ${res.status} (${String(res.body || '').slice(0, 300)}): is the core wired to ClickHouse and OpenFGA?`,
    );
  const c = res.json();
  const metricIds = (c.metrics || [])
    .filter(
      (m) => m.finance !== true && m.available !== false && (m.dimensions || []).includes('store'),
    )
    .map((m) => m.id);
  const storeIds = (c.stores || []).map((s) => s.id);
  if (!metricIds.length || !storeIds.length)
    fail(
      `the catalogue gave ${metricIds.length} metrics and ${storeIds.length} stores for ${USER}`,
    );
  const lastDay = __ENV.METRICS_LAST_DAY;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay || ''))
    fail(`METRICS_LAST_DAY is "${lastDay}": run infra/load/ch-seed.mjs first`);
  return { metricIds, storeIds, lastDay };
}

const day = (d) => d.toISOString().slice(0, 10);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

/** One request: 10% the catalogue (`metrics`), 90% a typed query (`metrics_query`) over 7 or 30 days, one store. */
export function metricsOnce(m) {
  if (Math.random() < 0.1) {
    const res = adminReq('GET', '/admin/metrics', undefined, 'metrics');
    check(res, { 'metrics catalogue 200': (r) => r.status === 200 });
    return;
  }
  // [from, to) in UTC days, ending the day after the seeded month's last day
  const to = new Date(`${m.lastDay}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (Math.random() < 0.5 ? 7 : 30));
  const res = adminReq(
    'POST',
    '/admin/metrics/query',
    {
      metrics: [pick(m.metricIds)],
      dimensions: ['store'],
      grain: 'day',
      from: day(from),
      to: day(to),
      filters: { store_ids: [pick(m.storeIds)] },
    },
    'metrics_query',
  );
  check(res, { 'metrics query 200': (r) => r.status === 200 });
}
