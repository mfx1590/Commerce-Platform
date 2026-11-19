// BI v2 wave 2 (#935 a3) routes behind the real core middleware (dev tokens), a seeded throwaway Postgres and a
// recording ClickHouse reader:
//   * the three new operations fail closed (503) until the contract has them, and need a token (401);
//   * a store admin of A asking for store B is a 403 on every one (never empty rows);
//   * getOperationsBacklog runs on real rows: the paid fixture orders of A with no shipment are `unassigned`, aged;
//     nothing of B reaches the admin of A;
//   * listMetricDimensionValues: the store picker lists only the caller's stores; a promotion is found by its NAME and
//     never by its code (a single-use code can be personal);
//   * queryMetrics answers promotion metrics from the orders' frozen allocation (Postgres), stacked promotions each
//     with its own share; getCustomerCohorts binds the caller's scope in every statement.
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, SEED_IDS } from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../../http';
import { closePool, initDb } from '../../../lib/db';
import { mountCoreMiddleware } from '../../../server';
import { createReportingDatabase, insertReportingFixtures } from '../testing/fixtures';
import type { MetricsReader } from './execute';
import { metricsAdminRouter } from './routes';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const P1 = '00000000-0000-4000-8000-000000935001';
const P2 = '00000000-0000-4000-8000-000000935002';
const VIEWER = { relation: 'viewer', object: 'store:*' };
const OPS = Object.fromEntries(
  [
    'listMetrics',
    'queryMetrics',
    'getCustomerCohorts',
    'getOperationsBacklog',
    'listMetricDimensionValues',
  ].map((op) => [op, VIEWER]),
);
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
let closed: express.Express;
const seen: { query: string; scope: unknown }[] = [];
const reader: MetricsReader = {
  async query({ query, query_params }) {
    if (!query.includes('raw_events')) seen.push({ query, scope: query_params?.scope });
    return { json: async <T>() => [] as T[] };
  },
};

const as = (r: request.Test, subject?: string) =>
  subject ? r.set('Authorization', `Bearer dev:${subject}`) : r;

beforeAll(async () => {
  process.env.CORE_DEV_TOKENS = '1';
  db = await createReportingDatabase('metrics_w2');
  await initDb({ connectionString: db.app.options.connectionString! });
  const hq = createOrganizationClient(db.app, { organizationId: ORG });
  await insertReportingFixtures(hq);
  const user = await hq.query<{ id: string }>(
    `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
     VALUES ($1, 'w2-admin-a', 'w2-admin-a@example.test', 'Wave 2 admin A', 'active') RETURNING id`,
    [ORG],
  );
  await hq.query(
    `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
     VALUES ($1, $2, 'store_admin', 'store', $3)`,
    [ORG, user.rows[0]!.id, A],
  );
  // two promotions of A: one with a code, one automatic; the first EUR order of A used both (stacked)
  await hq.query(
    `INSERT INTO promotion (id, organization_id, store_id, code, name, type)
     VALUES ($1, $3, $4, 'SECRET10', 'Autumn sale', 'percentage'),
            ($2, $3, $4, NULL, 'Free gift', 'percentage')`,
    [P1, P2, ORG, A],
  );
  await hq.query(
    `UPDATE "order" SET metadata = jsonb_build_object('promotions', jsonb_build_array(
        jsonb_build_object('promotion_id', $1::text, 'code', 'SECRET10', 'discount_minor', 250),
        jsonb_build_object('promotion_id', $2::text, 'code', NULL, 'discount_minor', 100)))
     WHERE id = (SELECT id FROM "order" WHERE store_id = $3 AND currency = 'EUR' AND status = 'confirmed'
                 ORDER BY placed_at LIMIT 1)`,
    [P1, P2, A],
  );
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    moduleRouters: [metricsAdminRouter({ reader, spec: specWith(OPS) })],
  });
  app.use(coreErrorHandler);
  closed = express();
  mountCoreMiddleware(closed, new DevTokenVerifier(), {
    moduleRouters: [metricsAdminRouter({ reader, spec: specWith({}) })],
  });
  closed.use(coreErrorHandler);
}, 240_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

const cohorts = (body: object, subject?: string, on = app) =>
  as(request(on).post('/admin/metrics/cohorts').send(body), subject);
const backlog = (body: object, subject?: string, on = app) =>
  as(request(on).post('/admin/metrics/operations/backlog').send(body), subject);
const values = (query: Record<string, string>, subject?: string, on = app) =>
  as(request(on).get('/admin/metrics/dimension-values').query(query), subject);
const COHORT = { from_month: '2026-01', to_month: '2026-03', months: 3, currency: 'EUR' };

describe('access (#935 a3)', () => {
  it('fail closed (503) until the contract has the operations; 401 without a token', async () => {
    expect((await cohorts(COHORT, 'seed-owner', closed)).status).toBe(503);
    expect((await backlog({}, 'seed-owner', closed)).status).toBe(503);
    expect((await values({ dimension: 'store' }, 'seed-owner', closed)).status).toBe(503);
    expect((await cohorts(COHORT)).status).toBe(401);
    expect((await backlog({})).status).toBe(401);
    expect((await values({ dimension: 'store' })).status).toBe(401);
  });

  it('a store admin of A asking for store B is a 403 on every operation, before any read', async () => {
    seen.length = 0;
    expect((await cohorts({ ...COHORT, store_ids: [B] }, 'w2-admin-a')).status).toBe(403);
    expect((await backlog({ store_ids: [B] }, 'w2-admin-a')).status).toBe(403);
    expect((await values({ dimension: 'country', store_ids: B }, 'w2-admin-a')).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('a bad body is a 400 naming the field', async () => {
    const r = await cohorts({ ...COHORT, currency: 'eur' }, 'w2-admin-a');
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ field: 'currency' });
    expect((await values({ dimension: 'email' }, 'w2-admin-a')).status).toBe(400);
  });
});

describe('getCustomerCohorts', () => {
  it('binds the caller scope in both statements; a cohort with no customers is suppressed', async () => {
    seen.length = 0;
    const r = await cohorts(COHORT, 'w2-admin-a');
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s.scope).toEqual([A]);
    expect(r.body.cohorts.map((c: { cohort_month: string }) => c.cohort_month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
    expect(r.body.cohorts[0]).toMatchObject({ size: null, suppressed: true });
  });
});

describe('getOperationsBacklog (Postgres)', () => {
  it('the paid orders of A with no shipment are unassigned and older than 7 days; nothing of B', async () => {
    const r = await backlog({}, 'w2-admin-a');
    expect(r.status).toBe(200);
    expect(r.body.buckets).toEqual(['lt_1d', 'd1_2', 'd3_7', 'gt_7d']);
    const unassigned = r.body.rows.filter((x: { kind: string }) => x.kind === 'unassigned');
    expect(unassigned.length).toBeGreaterThan(0);
    for (const x of r.body.rows) expect(x.store_id).toBe(A);
    expect(
      unassigned.every(
        (x: { bucket: string; warehouse_id: string | null }) =>
          x.bucket === 'gt_7d' && x.warehouse_id === null,
      ),
    ).toBe(true);
    // a2, a1 and a3 (captured, confirmed, no shipment) at least; the cancelled, failed and awaiting ones never
    expect(
      unassigned.reduce((n: number, x: { count: number }) => n + x.count, 0),
    ).toBeGreaterThanOrEqual(3);
    const all = await backlog({}, 'seed-owner');
    expect(all.body.rows.some((x: { store_id: string }) => x.store_id === B)).toBe(true);
  });
});

describe('listMetricDimensionValues', () => {
  it('the store picker lists only the caller stores', async () => {
    const r = await values({ dimension: 'store' }, 'w2-admin-a');
    expect(r.status).toBe(200);
    expect(r.body.values.map((v: { id: string }) => v.id)).toEqual([A]);
  });

  it('a promotion is found by its name, never by its code; the code is never returned', async () => {
    const byName = await values({ dimension: 'promotion', q: 'autumn' }, 'w2-admin-a');
    expect(byName.body.values).toEqual([{ id: P1, label: 'Autumn sale' }]);
    const byCode = await values({ dimension: 'promotion', q: 'SECRET' }, 'w2-admin-a');
    expect(byCode.body.values).toEqual([]);
    expect(
      JSON.stringify((await values({ dimension: 'promotion' }, 'w2-admin-a')).body),
    ).not.toContain('SECRET');
  });

  it('ClickHouse pickers read the caller stores only', async () => {
    seen.length = 0;
    expect((await values({ dimension: 'carrier' }, 'w2-admin-a')).status).toBe(200);
    expect(seen.map((s) => s.scope)).toEqual([[A]]);
  });
});

describe('promotion metrics (Postgres, R1)', () => {
  it('each promotion of a stacked order counts with its own share; labelled by name; scoped', async () => {
    const r = await as(
      request(app)
        .post('/admin/metrics/query')
        .send({
          metrics: ['promotion_orders', 'promotion_discount_minor'],
          dimensions: ['promotion'],
          grain: 'total',
          from: '2026-03-01',
          to: '2026-04-01',
        }),
      'w2-admin-a',
    );
    expect(r.status).toBe(200);
    const by = Object.fromEntries(
      r.body.rows.map((x: { promotion_id: string; values: object }) => [x.promotion_id, x.values]),
    );
    expect(by).toEqual({
      [P1]: { promotion_orders: 1, promotion_discount_minor: 250 },
      [P2]: { promotion_orders: 1, promotion_discount_minor: 100 },
    });
    expect(r.body.labels.promotion).toEqual({ [P1]: 'Autumn sale', [P2]: 'Free gift' });
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
  });
});
