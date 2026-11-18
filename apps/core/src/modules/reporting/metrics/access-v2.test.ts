// BI v2 (#871): the access matrix's two new rows, run HERE until they land in apps/core/test/access-matrix.test.ts
// (window 1's file; the REQUEST carries the exact diff) together with the contract (the matrix refuses a row the
// contract does not declare, and a declared route without a row). Until then this overlay is the proof.
//
// Unit job only: Postgres, the REAL metrics router, dev tokens (the role_assignment stub of ADR 0002), the two
// operations' x-permission overlaid on the spec exactly as #871 a3 declares it (viewer on store:*). ClickHouse is a
// dead reader: a principal the guard lets through gets movers 503 `unavailable` (fail closed), and inventory health a
// 200 from the Postgres position alone (`rate_available: false`, #871 review 12).
import { createOrganizationClient, SEED_IDS } from '@platform/db';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MetricsReader } from './execute';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const dead: MetricsReader = {
  query: () =>
    Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { name: 'ConnectionError' })),
};

type Who = 'owner' | 'finance' | 'analyst' | 'support' | 'adminA' | 'adminB' | 'noRole' | 'none';
const SUBJECT: Record<Who, string | undefined> = {
  owner: 'seed-owner',
  finance: 'seed-finance',
  analyst: 'seed-analyst',
  support: 'seed-support',
  adminA: 'v2-matrix-admin-a',
  adminB: 'v2-matrix-admin-b',
  noRole: 'v2-matrix-no-role',
  none: undefined,
};
const PERMITTED: Who[] = ['owner', 'finance', 'analyst', 'support', 'adminA', 'adminB'];

describe('access matrix overlay: listMetricMovers and getInventoryHealth (#871, until the matrix rows land)', () => {
  let app: express.Express;
  let db: { drop(): Promise<void> } | undefined;
  let closePool: () => Promise<void> = async () => {};
  const post = (who: Who, path: string, body: Record<string, unknown>) => {
    const r = request(app).post(path).send(body);
    return SUBJECT[who] ? r.set('Authorization', `Bearer dev:${SUBJECT[who]}`) : r;
  };

  beforeAll(async () => {
    const { createReportingDatabase } = await import('../testing/fixtures');
    const { coreErrorHandler, DevTokenVerifier, loadSpec } = await import('../../../http');
    const lib = await import('../../../lib/db');
    const { mountCoreMiddleware } = await import('../../../server');
    const { metricsAdminRouter } = await import('./routes');
    process.env.CORE_DEV_TOKENS = '1';
    const created = await createReportingDatabase('access_v2');
    db = created;
    await lib.initDb({ connectionString: created.app.options.connectionString! });
    closePool = lib.closePool;
    const hq = createOrganizationClient(created.app, { organizationId: ORG });
    for (const [subject, store] of [
      ['v2-matrix-admin-a', A],
      ['v2-matrix-admin-b', B],
      ['v2-matrix-no-role', null],
    ] as const) {
      const u = await hq.query<{ id: string }>(
        `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
         VALUES ($1, $2, $2 || '@example.test', $2, 'active') RETURNING id`,
        [ORG, subject],
      );
      if (store)
        await hq.query(
          `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
           VALUES ($1, $2, 'store_admin', 'store', $3)`,
          [ORG, u.rows[0]!.id, store],
        );
    }
    // the real spec, with the two operations #871 a3 adds (until the contract lands)
    const real = loadSpec('admin-api.yaml');
    const added: Record<string, { relation: string; object: string }> = {
      listMetricMovers: { relation: 'viewer', object: 'store:*' },
      getInventoryHealth: { relation: 'viewer', object: 'store:*' },
    };
    app = express();
    mountCoreMiddleware(app, new DevTokenVerifier(), {
      moduleRouters: [
        metricsAdminRouter({
          reader: dead,
          spec: {
            permission: (op) => added[op] ?? real.permission(op),
            validateBody: (op, body) => (added[op] ? undefined : real.validateBody(op, body)),
          },
        }),
      ],
    });
    app.use(coreErrorHandler);
  }, 240_000);

  afterAll(async () => {
    await closePool();
    await db?.drop();
  });

  const movers = {
    metric: 'net_sales_minor',
    dimension: 'store',
    from: '2026-10-01',
    to: '2026-11-01',
  };

  it('listMetricMovers: viewer on store:* — every role through the guard (503: the analytics store is down), no relation 403, no token 401', async () => {
    const cells: string[] = [];
    for (const who of [...PERMITTED, 'noRole', 'none'] as Who[]) {
      const r = await post(who, '/admin/metrics/movers', movers);
      const want = who === 'none' ? 401 : who === 'noRole' ? 403 : 503;
      expect(r.status, `${who}: ${JSON.stringify(r.body)}`).toBe(want);
      cells.push(`${who} ${r.status}`);
    }
    // naming another store is a 403 BEFORE any read
    const b = await post('adminA', '/admin/metrics/movers', {
      ...movers,
      filters: { store_ids: [B] },
    });
    expect([b.status, b.body.details]).toEqual([403, { relation: 'viewer', object: `store:${B}` }]);
    console.info(JSON.stringify({ test: 'access-v2', row: 'listMetricMovers', cells }));
  });

  it('getInventoryHealth: every role answered from the position (rate_available false), store admins their own stores only', async () => {
    const cells: string[] = [];
    for (const who of [...PERMITTED, 'noRole', 'none'] as Who[]) {
      const r = await post(who, '/admin/metrics/inventory', { limit: 500 });
      const want = who === 'none' ? 401 : who === 'noRole' ? 403 : 200;
      expect(r.status, `${who}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(want);
      if (want === 200) {
        expect(r.body.rate_available).toBe(false);
        expect(r.body.incoming_tracked).toBe(false);
        const own = who === 'adminA' ? A : who === 'adminB' ? B : null;
        if (own)
          for (const row of r.body.rows as { store_ids: string[] }[])
            expect(row.store_ids).toEqual([own]);
        expect((r.body.rows as unknown[]).length, who).toBeGreaterThan(0);
      }
      cells.push(`${who} ${r.status}`);
    }
    const b = await post('adminA', '/admin/metrics/inventory', { store_ids: [B] });
    expect([b.status, b.body.details]).toEqual([403, { relation: 'viewer', object: `store:${B}` }]);
    console.info(JSON.stringify({ test: 'access-v2', row: 'getInventoryHealth', cells }));
  });
});
