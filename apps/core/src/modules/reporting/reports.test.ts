// #479: the four Admin API report operations (Admin API 0.4.19, CONTRACT CHANGE #493) on a seeded throwaway
// database (0200 views) with the shared reporting fixtures. The HTTP tests go through the production router list
// (`moduleAdminRouters()`, window 1's mount, REQUEST #494) behind the real middleware chain, and validate every
// response against admin-api.yaml.
import express from 'express';
import request from 'supertest';
import {
  createOrganizationClient,
  createTenantClient,
  SEED_IDS,
  type ScopedClient,
} from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier, loadSpec, moduleAdminRouters } from '../../http';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import {
  hqFinanceReport,
  hqSalesReport,
  parseReportWindow,
  storeSalesReport,
  storeStockReport,
} from './index';
import { createReportingDatabase, insertReportingFixtures } from './testing/fixtures';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const MARCH = { from: '2026-03-01', to: '2026-04-01' };
const PII =
  /email|name|phone|address|provider_.*id|idempotency|keycloak|subject|metadata|consent|note|customer/;

type Row = Record<string, unknown>;
type Paths = Record<string, Record<string, unknown>>;

const OPERATIONS = [
  'getStoreSalesReport',
  'getStoreStockReport',
  'getHqSalesReport',
  'getHqFinanceReport',
];

let db: TestDatabase;
let hq: ScopedClient;
let a: ScopedClient;
let app: express.Express;

const as = (subject: string) => (path: string) =>
  request(app).get(path).set('Authorization', `Bearer dev:${subject}`);

async function rows(client: ScopedClient, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await client.query<Row>(sql, params)).rows;
}

function piiKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => piiKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(PII.test(k) ? [`${path}.${k}`] : []),
      ...piiKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

function expectSchema(name: string, body: unknown): void {
  const validate = loadSpec('admin-api.yaml').schema(name);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(piiKeys(body)).toEqual([]);
}

beforeAll(async () => {
  process.env.CORE_DEV_TOKENS = '1';
  db = await createReportingDatabase('reports');
  await initDb({ connectionString: db.app.options.connectionString! });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  await insertReportingFixtures(hq);

  // A store admin of brand A only (the seeded store-admin holds A and B).
  const user = await rows(
    hq,
    `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
     VALUES ($1, 'rpt-store-admin-a', 'rpt-admin-a@example.test', 'Report admin A', 'active') RETURNING id`,
    [ORG],
  );
  await rows(
    hq,
    `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
     VALUES ($1, $2, 'store_admin', 'store', $3)`,
    [ORG, user[0]!.id, A],
  );

  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), { moduleRouters: moduleAdminRouters() });
  app.use(coreErrorHandler);
}, 240_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('report window', () => {
  it('accepts UTC days, from inclusive and to exclusive, at most 366 days, an optional currency', () => {
    expect(parseReportWindow({ from: '2026-03-01', to: '2026-03-02' })).toEqual({
      from: '2026-03-01',
      to: '2026-03-02',
    });
    expect(parseReportWindow({ from: '2025-03-01', to: '2026-03-02', currency: 'EUR' })).toEqual({
      from: '2025-03-01',
      to: '2026-03-02',
      currency: 'EUR',
    });
  });

  it.each([
    [{ from: '2026-03-02', to: '2026-03-01' }, 'to'],
    [{ from: '2026-03-01', to: '2026-03-01' }, 'to'],
    [{ from: '2025-01-01', to: '2026-03-01' }, 'to'],
    [{ from: '2026-02-30', to: '2026-03-01' }, 'from'],
    [{ from: '2026-03-01T00:00:00Z', to: '2026-03-02' }, 'from'],
    [{ to: '2026-03-02' }, 'from'],
    [{ from: '2026-03-01', to: '2026-03-02', currency: 'eur' }, 'currency'],
  ])('refuses %j with validation_error on %s', (query, field) => {
    try {
      parseReportWindow(query);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({
        code: 'validation_error',
        details: { [field]: expect.any(String) },
      });
    }
  });
});

describe('service: the reports equal the views', () => {
  it('store sales: one store, the window, per currency; EUR and GBP never one total', async () => {
    const report = await storeSalesReport(a, A, MARCH);
    const view = await rows(
      a,
      `SELECT day::text AS day, currency, net_minor::text AS net FROM rpt_sales_daily
        WHERE store_id = $1 AND day >= '2026-03-01' AND day < '2026-04-01' ORDER BY day, currency`,
      [A],
    );
    expect(report.rows.map((r) => [r.day, r.currency, String(r.net_minor)])).toEqual(
      view.map((v) => [v.day, String(v.currency).trim(), v.net]),
    );
    expect(report.rows.every((r) => r.store_id === A)).toBe(true);
    expect(report.totals.map((t) => t.currency).sort()).toEqual(['EUR', 'GBP']);
    expect(report.currency_totals.map((t) => t.currency).sort()).toEqual(['EUR', 'GBP']);
    for (const t of report.currency_totals) {
      const same = report.rows.filter((r) => r.currency === t.currency);
      expect(t.net_minor).toBe(same.reduce((s, r) => s + r.net_minor, 0));
      expect(t.orders).toBe(same.reduce((s, r) => s + r.orders, 0));
    }
  });

  it('from is inclusive and to exclusive (UTC days)', async () => {
    const one = await storeSalesReport(a, A, {
      from: '2026-03-01',
      to: '2026-03-02',
      currency: 'EUR',
    });
    expect(one.rows.map((r) => r.day)).toEqual(['2026-03-01']);
    // the fixture's 10 000 order (refunded 2 500 later) + the awaiting 2 200 order; a2 (00:30 on 03-02) is out
    expect(one.rows[0]).toMatchObject({
      orders: 2,
      total_minor: 12200,
      refunded_minor: 2500,
      net_minor: 9700,
    });
  });

  it('HQ sales cover every store, totals per store and currency', async () => {
    const report = await hqSalesReport(hq, MARCH);
    expect(new Set(report.rows.map((r) => r.store_id))).toEqual(new Set([A, B]));
    const keys = report.totals.map((t) => `${t.store_id}|${t.currency}`);
    expect(new Set(keys).size).toBe(keys.length);
    const gbp = report.currency_totals.find((t) => t.currency === 'GBP')!;
    expect(gbp.net_minor).toBe(
      report.totals.filter((t) => t.currency === 'GBP').reduce((s, t) => s + t.net_minor, 0),
    );
  });

  it('a store-scoped client never reports another store, even when asked for it', async () => {
    const report = await storeSalesReport(a, A, MARCH);
    expect(report.rows.some((r) => r.store_id === B)).toBe(false);
    await expect(storeSalesReport(a, B, MARCH)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('store stock: the pool rows the store maps, paged, matching the view', async () => {
    const page = await storeStockReport(a, A, { page: 1, limit: 5 });
    const [count] = await rows(a, `SELECT count(*)::int AS n FROM rpt_stock_position`);
    expect(page.total).toBe(count!.n);
    expect(page.items).toHaveLength(5);
    const sorted = [...page.items].sort(
      (x, y) => x.sku.localeCompare(y.sku) || x.warehouse_code.localeCompare(y.warehouse_code),
    );
    expect(page.items).toEqual(sorted);
  });

  it('HQ finance per currency equals the payments and refunds views (contract test)', async () => {
    const report = await hqFinanceReport(hq, MARCH);
    const payments = await rows(
      hq,
      `SELECT currency, sum(captured_minor)::text AS captured, sum(fee_minor)::text AS fee,
              sum(fee_unknown)::text AS unknown
         FROM rpt_payments_daily WHERE day >= '2026-03-01' AND day < '2026-04-01' GROUP BY currency`,
    );
    const refunds = await rows(
      hq,
      `SELECT currency, sum(refunded_minor)::text AS refunded FROM rpt_refunds_daily
        WHERE day >= '2026-03-01' AND day < '2026-04-01' GROUP BY currency`,
    );
    for (const p of payments) {
      const t = report.currency_totals.find((c) => c.currency === String(p.currency).trim())!;
      expect([String(t.captured_minor), String(t.fee_minor), String(t.fee_unknown)]).toEqual([
        p.captured,
        p.fee,
        p.unknown,
      ]);
    }
    for (const r of refunds) {
      const t = report.currency_totals.find((c) => c.currency === String(r.currency).trim())!;
      expect(String(t.refunded_minor)).toBe(r.refunded);
      expect(Object.values(t.refunded_by_reason).reduce((s, n) => s + n, 0)).toBe(t.refunded_minor);
    }
    expect(report.fees_reconciled).toBe(false);
    // Brand A EUR by hand: captured 10 000 + 4 000 + 9 900 (the cancelled order was captured, then refunded);
    // fees 290 + 280 known, one unknown; refunds 2 500 goodwill + 9 900 cancellation (the failed one is out).
    expect(report.rows.find((r) => r.store_id === A && r.currency === 'EUR')).toMatchObject({
      captured_count: 3,
      captured_minor: 23900,
      fee_minor: 570,
      fee_unknown: 1,
      refunds: 2,
      refunded_minor: 12400,
      refunded_by_reason: { return: 0, cancellation: 9900, goodwill: 2500, chargeback: 0 },
    });
  });
});

describe('the router: permissions and the wire shape', () => {
  const q = `?from=${MARCH.from}&to=${MARCH.to}`;

  it('store admin of brand A: 200 on A, 403 on B, 403 on both HQ operations', async () => {
    const get = as('rpt-store-admin-a');
    const sales = await get(`/admin/stores/${A}/reports/sales${q}`);
    expect(sales.status).toBe(200);
    expectSchema('SalesReport', sales.body);
    const stock = await get(`/admin/stores/${A}/reports/stock?limit=3`);
    expect(stock.status).toBe(200);
    expectSchema('StockReport', stock.body);

    for (const path of [
      `/admin/stores/${B}/reports/sales${q}`,
      `/admin/stores/${B}/reports/stock`,
      `/admin/hq/reports/sales${q}`,
      `/admin/hq/reports/finance${q}`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('forbidden');
    }
  });

  it('analyst: 200 on HQ sales with every store, 403 on finance', async () => {
    const sales = await as('seed-analyst')(`/admin/hq/reports/sales${q}`);
    expect(sales.status).toBe(200);
    expectSchema('SalesReport', sales.body);
    expect(new Set((sales.body.rows as Row[]).map((r) => r.store_id))).toEqual(new Set([A, B]));
    expect((await as('seed-analyst')(`/admin/hq/reports/finance${q}`)).status).toBe(403);
  });

  it('analyst: reads a store’s stock (store.viewer includes analyst from organization) — the BI stock tab', async () => {
    for (const store of [A, B]) {
      const res = await as('seed-analyst')(`/admin/stores/${store}/reports/stock?limit=5`);
      expect(res.status, store).toBe(200);
      expectSchema('StockReport', res.body);
      expect((res.body.items as Row[]).length).toBeGreaterThan(0);
    }
  });

  it('finance and owner: 200 on HQ finance', async () => {
    for (const subject of ['seed-finance', 'seed-owner']) {
      const res = await as(subject)(`/admin/hq/reports/finance${q}`);
      expect(res.status, subject).toBe(200);
      expectSchema('FinanceReport', res.body);
      expect(res.body.fees_reconciled).toBe(false);
    }
  });

  it('400 validation_error on a bad or oversized window, 404 on an unknown store, 401 without a token', async () => {
    const get = as('seed-owner');
    for (const bad of [
      `?from=${MARCH.to}&to=${MARCH.from}`,
      `?from=2025-01-01&to=2026-03-01`,
      `?from=${MARCH.from}`,
      `${q}&currency=euro`,
    ]) {
      const res = await get(`/admin/hq/reports/sales${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.code, bad).toBe('validation_error');
    }
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    const missing = await get(`/admin/stores/${unknown}/reports/sales${q}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
    expect((await request(app).get(`/admin/hq/reports/sales${q}`)).status).toBe(401);
  });

  it('the four operations are in admin-api.yaml with the planned permissions, and their examples validate', () => {
    const paths = loadSpec('admin-api.yaml').doc.paths as Paths;
    const found = new Map<string, { op: Record<string, unknown>; path: string }>();
    for (const [path, item] of Object.entries(paths)) {
      const op = item.get as { operationId?: string } | undefined;
      if (op?.operationId && OPERATIONS.includes(op.operationId)) {
        found.set(op.operationId, { op: op as Record<string, unknown>, path });
      }
    }
    expect([...found.keys()].sort()).toEqual([...OPERATIONS].sort());
    const perms = Object.fromEntries(
      OPERATIONS.map((id) => [id, loadSpec('admin-api.yaml').permission(id)]),
    );
    expect(perms).toEqual({
      getStoreSalesReport: { relation: 'viewer', object: 'store:{storeId}' },
      getStoreStockReport: { relation: 'viewer', object: 'store:{storeId}' },
      getHqSalesReport: { relation: 'analyst', object: 'organization:hq' },
      getHqFinanceReport: { relation: 'finance', object: 'organization:hq' },
    });
    for (const { op } of found.values()) {
      const ok = (
        op.responses as Record<
          string,
          { content?: Record<string, { schema: { $ref: string }; example: unknown }> }
        >
      )['200']!.content!['application/json']!;
      expectSchema(ok.schema.$ref.split('/').pop()!, ok.example);
    }
  });
});
