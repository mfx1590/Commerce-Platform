// #603 routes behind the real core middleware (dev tokens, the role_assignment stub), a seeded throwaway database
// for the scope, and a recording fake ClickHouse reader. Proves the access rules the contract states: 401 without a
// token; the scope each role gets, injected into EVERY compiled statement; a store outside the scope is a 403 (not
// empty rows); finance metrics need finance; a bad body is a 400; ClickHouse down is a 503 `unavailable`.
// The main app reads the permissions from the landed contract (admin-api.yaml 0.4.25); a hand-built spec stands in only
// for the fail-closed case (a contract WITHOUT the operations).
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, SEED_IDS } from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier, moduleAdminRouters } from '../../../http';
import { closePool, initDb } from '../../../lib/db';
import { mountCoreMiddleware } from '../../../server';
import { createReportingDatabase } from '../testing/fixtures';
import type { MetricsReader } from './execute';
import { metricsAdminRouter } from './routes';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const C = SEED_IDS.stores.brandC;
/** A spec carrying only the given operations; an unknown operation throws like loadSpec. */
const specWith = (ops: Record<string, { relation: string; object: string }>) => ({
  permission(op: string) {
    const p = ops[op];
    if (!p) throw new Error(`no operation ${op} in admin-api.yaml`);
    return p;
  },
  validateBody: () => {},
});

let db: TestDatabase;
let app: express.Express;
const seen: { query: string; scope: unknown }[] = [];
let failNext = false;
const reader: MetricsReader = {
  async query({ query, query_params }) {
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'ConnectionError' });
    }
    if (!query.includes('raw_events')) seen.push({ query, scope: query_params?.scope });
    return { json: async <T>() => [] as T[] };
  },
};

const get = (subject?: string) => {
  const r = request(app).get('/admin/metrics');
  return subject ? r.set('Authorization', `Bearer dev:${subject}`) : r;
};
const post = (body: unknown, subject?: string) => {
  const r = request(app)
    .post('/admin/metrics/query')
    .send(body as object);
  return subject ? r.set('Authorization', `Bearer dev:${subject}`) : r;
};
const q = (extra: Record<string, unknown> = {}) => ({
  metrics: ['bookings_minor', 'orders'],
  grain: 'day',
  from: '2026-10-01',
  to: '2026-11-01',
  ...extra,
});

beforeAll(async () => {
  process.env.CORE_DEV_TOKENS = '1';
  db = await createReportingDatabase('metrics');
  await initDb({ connectionString: db.app.options.connectionString! });
  const hq = createOrganizationClient(db.app, { organizationId: ORG });
  // a store admin of brand A only (the seeded store-admin holds A and B)
  const user = await hq.query<{ id: string }>(
    `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
     VALUES ($1, 'metrics-admin-a', 'metrics-admin-a@example.test', 'Metrics admin A', 'active') RETURNING id`,
    [ORG],
  );
  await hq.query(
    `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
     VALUES ($1, $2, 'store_admin', 'store', $3)`,
    [ORG, user.rows[0]!.id, A],
  );
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    // ours first (the recording reader); the production list mounts the same paths with the same real spec
    moduleRouters: [metricsAdminRouter({ reader }), ...moduleAdminRouters()],
  });
  app.use(coreErrorHandler);
}, 240_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('listMetrics', () => {
  it('401 without a token', async () => {
    expect((await get()).status).toBe(401);
  });

  it('a store admin of A sees store A only and no finance metric', async () => {
    const r = await get('metrics-admin-a');
    expect(r.status).toBe(200);
    expect(r.body.stores.map((s: { id: string }) => s.id)).toEqual([A]);
    expect(r.body.metrics.some((m: { finance: boolean }) => m.finance)).toBe(false);
    expect(r.body).toMatchObject({
      max_range_days: 366,
      max_rows: 1000,
      grains: ['day', 'week', 'month', 'total'],
    });
  });

  it('finance sees every store and the finance metrics', async () => {
    const r = await get('seed-finance');
    expect(r.status).toBe(200);
    expect(r.body.stores.map((s: { id: string }) => s.id).sort()).toEqual([A, B, C].sort());
    expect(r.body.metrics.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining(['captured_minor', 'fee_minor', 'recognised_minor']),
    );
  });
});

describe('queryMetrics', () => {
  it('401 without a token', async () => {
    expect((await post(q())).status).toBe(401);
  });

  it('a store admin of A: every compiled statement is scoped to A', async () => {
    seen.length = 0;
    const r = await post(q({ metrics: ['bookings_minor', 'refunds_minor'] }), 'metrics-admin-a');
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.scope).toEqual([A]);
      expect(s.query).toContain('store_id IN {scope:Array(UUID)}');
    }
  });

  it('asking for store B as a store admin of A is a 403 naming the store, never empty rows', async () => {
    seen.length = 0;
    const r = await post(q({ filters: { store_ids: [A, B] } }), 'metrics-admin-a');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({
      code: 'forbidden',
      details: { relation: 'viewer', object: `store:${B}` },
    });
    expect(seen).toEqual([]); // nothing reached ClickHouse
  });

  it('an analyst gets every store, and a store filter narrows the scope', async () => {
    seen.length = 0;
    expect((await post(q(), 'seed-analyst')).status).toBe(200);
    expect((seen[0]!.scope as string[]).sort()).toEqual([A, B, C].sort());
    seen.length = 0;
    expect((await post(q({ filters: { store_ids: [C] } }), 'seed-analyst')).status).toBe(200);
    expect(seen[0]!.scope).toEqual([C]);
  });

  it('finance metrics need finance on organization:hq: no finance is a 403, nothing reaches ClickHouse', async () => {
    for (const subject of ['seed-analyst', 'metrics-admin-a']) {
      for (const metric of ['captured_minor', 'fee_minor', 'recognised_minor']) {
        seen.length = 0;
        const denied = await post(q({ metrics: ['orders', metric] }), subject);
        expect(denied.status, `${subject} ${metric}`).toBe(403);
        expect(denied.body).toMatchObject({
          code: 'forbidden',
          details: { relation: 'finance', object: 'organization:hq', metric },
        });
        expect(denied.body.rows).toBeUndefined();
        expect(seen).toEqual([]);
      }
    }
    expect((await post(q({ metrics: ['captured_minor'] }), 'seed-finance')).status).toBe(200);
  });

  it('a body outside the vocabulary is a 400, and nothing is compiled', async () => {
    seen.length = 0;
    const r = await post({ ...q(), metrics: ['sum(total_minor)'] }, 'seed-analyst');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('validation_error');
    expect(seen).toEqual([]);
  });

  it('an EMPTY filter list is a 400 naming the field, never a 500 (#638 review A)', async () => {
    for (const [field, metrics] of [
      ['store_ids', ['orders']],
      ['currencies', ['bookings_minor']],
      ['product_ids', ['units']],
      ['refund_reasons', ['refunds_minor']],
    ] as const) {
      seen.length = 0;
      const r = await post(q({ metrics, filters: { [field]: [] } }), 'seed-analyst');
      expect(r.status, field).toBe(400);
      expect(r.body).toMatchObject({
        code: 'validation_error',
        // The spec validator rejects it first since contracts 0.4.31 (MetricQuery.filters minItems: 1, #664).
        details: { [`filters.${field}`]: expect.any(String) },
      });
      expect(seen).toEqual([]);
    }
  });

  it('ClickHouse down is a 503 `unavailable` with nothing partial', async () => {
    failNext = true;
    const r = await post(q(), 'seed-analyst');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('unavailable');
    expect(r.body.rows).toBeUndefined();
  });
});

describe('fail closed when the contract does not carry the operations', () => {
  it('both routes answer 503 before anything runs (no guard, no handler, no ClickHouse)', async () => {
    const closed = express();
    mountCoreMiddleware(closed, new DevTokenVerifier(), {
      moduleRouters: [metricsAdminRouter({ reader, spec: specWith({}) })],
    });
    closed.use(coreErrorHandler);
    seen.length = 0;
    const list = await request(closed)
      .get('/admin/metrics')
      .set('Authorization', 'Bearer dev:seed-owner');
    const query = await request(closed)
      .post('/admin/metrics/query')
      .set('Authorization', 'Bearer dev:seed-owner')
      .send(q());
    expect([list.status, query.status]).toEqual([503, 503]);
    expect([list.body.code, query.body.code]).toEqual(['unavailable', 'unavailable']);
    expect(list.body.details).toEqual({ operation: 'listMetrics' });
    expect(query.body.details).toEqual({ operation: 'queryMetrics' });
    expect(query.body.rows).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe('queryMetrics as text/csv', () => {
  it('Accept: text/csv answers CSV with X-Truncated; JSON stays the default; a 403 stays JSON', async () => {
    const csv = await post(q({ dimensions: ['store'] }), 'seed-analyst').set('Accept', 'text/csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['x-truncated']).toBe('false');
    expect(csv.text).toBe('"period","currency","store_id","bookings_minor","orders"\r\n');
    const json = await post(q(), 'seed-analyst');
    expect(json.headers['content-type']).toMatch(/^application\/json/);
    const denied = await post(q({ filters: { store_ids: [B] } }), 'metrics-admin-a').set(
      'Accept',
      'text/csv',
    );
    expect(denied.status).toBe(403);
    expect(denied.headers['content-type']).toMatch(/^application\/json/);
    expect(denied.body.code).toBe('forbidden');
  });
});
