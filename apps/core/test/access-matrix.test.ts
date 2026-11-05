// The Integration 5 access matrix (gate 3, #612): every BI, metrics, AI and recommendation route the core serves ×
// the principals that matter (owner, finance, HQ analyst, HQ support, store admin of A, store admin of B, no token;
// for the Store API route: the publishable key of A, of B, none) → the status the contract and ADR 0002 decide.
// The table below IS the documentation: one row per route, the rule that decides it, and one printed summary line.
//
// Completeness: the routes are enumerated from the contract (admin-api.yaml operations tagged `reports`, window 17's
// three marketing reports, every operation that documents an `ai_*` error; store-api.yaml's recommendations) AND from
// the mounted routers' own stacks (`reportingAdminRouter()` with metrics + ask nested, the marketing `/reports/`
// routes, `moduleStoreRouters()`). A route in either list without a row here fails the test.
//
// The leak: store-A principals call every row-returning route with data in brand A and brand B; no id of a brand-B
// row (and no brand-B-only marker) may appear in any response.
//
// Unit job only: Postgres, the core's REAL routers (`moduleAdminRouters()`, `moduleStoreRouters()`) and only public
// module APIs (ADR 0005). Principals are dev tokens, decided by the `role_assignment` stub that mirrors ADR 0002
// (src/http/permissions.ts); OpenFGA's parity with the stub is auth-live's (window 2).
//
// What needs ClickHouse or the model, and is covered elsewhere: queryMetrics and askMetrics read ClickHouse
// (analytics_ro) and askMetrics calls the model. Here ClickHouse is a dead port (never the shared dev one) and
// AI_ENABLED=0, so a principal the guard lets through gets 503 `unavailable` / `ai_disabled` — the cell proves the
// GUARD; the rows a permitted caller gets (and that store A never sees store B's) are window 12's
// `reporting/metrics/metrics-live.test.ts` (leak property on real ClickHouse) and its fake-reader route tests
// (`metrics/routes.test.ts`, `ask/routes.test.ts`: every compiled statement scoped to the caller's stores). What the
// unit job proves for them: who is refused, and that naming store B is a 403 BEFORE any read.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAiGateway,
  createFakeTransport,
  createMemoryAuditSink,
  createMemoryLimiter,
} from '@platform/ai';
import { createOrganizationClient, seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  coreErrorHandler,
  DevTokenVerifier,
  moduleAdminRouters,
  moduleStoreRouters,
  openApiDir,
} from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { setCopyDraftGatewayFactory, type CopyDraftGatewayFactory } from '../src/modules/catalog';
import { marketingAdminRouter } from '../src/modules/marketing';
import { reportingAdminRouter } from '../src/modules/reporting';
import { mountCoreMiddleware } from '../src/server';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const KEY = { A: SEED_IDS.publishableKeys.brandA, B: SEED_IDS.publishableKeys.brandB };
const WINDOW = 'from=2026-03-01&to=2026-04-01';
const MARKETING_WINDOW = 'from=2026-03-01T00:00:00Z&to=2026-04-01T00:00:00Z';
const MARKER = { A: 'MATRIX-A-ONLY', B: 'MATRIX-B-ONLY' };
/** abandoned carts per store: an aggregate report carries no ids, so the leak shows in the count */
const ABANDONED = { A: 1, B: 2 };

// ---- principals -------------------------------------------------------------------------------------------------

const STAFF = [
  'owner',
  'finance',
  'analyst',
  'support',
  'adminA',
  'adminB',
  'noRole',
  'none',
] as const;
const STORE_KEYS = ['keyA', 'keyB', 'noKey'] as const;
type Staff = (typeof STAFF)[number];
type StoreKey = (typeof STORE_KEYS)[number];
type Principal = Staff | StoreKey;

/** Dev-token subjects (CORE_DEV_TOKENS=1). adminA / adminB hold `store_admin` on ONE store (the seeded store-admin holds both). */
const SUBJECT: Record<Staff, string | undefined> = {
  owner: 'seed-owner', // owner on organization:hq
  finance: 'seed-finance', // finance on organization:hq
  analyst: 'seed-analyst', // analyst on organization:hq
  support: 'seed-support', // support on organization:hq
  adminA: 'matrix-admin-a', // store_admin on store:brand-a only
  adminB: 'matrix-admin-b', // store_admin on store:brand-b only
  noRole: 'matrix-no-role', // an active staff_user with NO role_assignment row (#720 review)
  none: undefined,
};

// ---- the app: the real middleware chain, routers and admin-api.yaml permissions; only the copy-draft model is faked ---

let db: TestDatabase;
let app: express.Express;
let previousCopyFactory: CopyDraftGatewayFactory;
const productOf: Record<'A' | 'B', string> = { A: '', B: '' };
/** Every id of a brand-B row (any public table with a store_id) + brand B's id and marker: none may reach store A. */
let brandBIds: string[] = [];

function metricQuery(extra: Record<string, unknown> = {}) {
  return {
    metrics: ['bookings_minor'],
    dimensions: ['store'],
    grain: 'total',
    from: '2026-03-01',
    to: '2026-04-01',
    ...extra,
  };
}

const staff = (who: Staff, req: request.Test): request.Test => {
  const subject = SUBJECT[who];
  return subject ? req.set('Authorization', `Bearer dev:${subject}`) : req;
};
const store = (who: StoreKey, req: request.Test): request.Test =>
  who === 'noKey' ? req : req.set('X-Publishable-Key', who === 'keyA' ? KEY.A : KEY.B);

// ---- the matrix -------------------------------------------------------------------------------------------------

interface Row {
  operationId: string;
  method: 'get' | 'post';
  /** the Express path, exactly as the router declares it */
  path: string;
  /** the rule that decides every cell of the row */
  rule: string;
  expect: Partial<Record<Principal, number>>;
  call: (who: Principal) => Promise<request.Response>;
  /** returns rows of a store's data: part of the leak sweep */
  leak?: boolean;
}

/** Appended to every admin rule: the column that fails if a route's `requirePermission` guard is removed (#720). */
const NO_ROLE =
  ' · noRole: a staff user with no role_assignment holds no relation (ADR 0002: every relation comes from a tuple) → 403';
const VIEWER_A =
  'x-permission viewer on store:{storeId} (path = brand A). ADR 0002 L35: store viewer = store_staff (⊇ store_admin, ' +
  'L32; ⊇ owner from organization, L31) or support (incl. support FROM ORGANIZATION, L33 — HQ support reads every ' +
  'store by design, reviewed on #612) or analyst / operations / finance from organization. store_admin of B: none of these on A → 403' +
  NO_ROLE;
const ANY_STORE =
  'x-permission viewer on store:* = viewer on at least one store (ADR 0002 L35, as VIEWER_A); every principal with a role views ' +
  'some store → 200, and the route narrows to the stores it may view (leak sweep)' +
  NO_ROLE;
const HQ_ANALYST =
  'x-permission analyst on organization:hq. ADR 0002 L25: analyst = [user] or owner; finance, support and store admins hold no analyst → 403' +
  NO_ROLE;
const HQ_FINANCE =
  'x-permission finance on organization:hq. ADR 0002 L23: finance = [user] or owner; analyst, support and store admins → 403' +
  NO_ROLE;
const STAFF_A =
  'x-permission store_staff on store:{storeId} (path = brand A). ADR 0002 L32: store_staff = [user] or store_admin ' +
  '(⊇ owner from organization, L31); finance, analyst and support are viewers, not staff → 403' +
  NO_ROLE;
const NEEDS_CLICKHOUSE =
  'needs ClickHouse (dead port here): a principal the guard lets through gets 503 `unavailable` — the rows are ' +
  'metrics-live (window 12)';
const STORE_KEY =
  'Store API: the publishable key selects the store (no x-permission, no staff token); no key → 401. Each key reads its own store only';

// what the real routes answer once the guard has passed, in the unit job (no ClickHouse, AI off) — see the header
const QUERY_STATUS = 503;
const ASK_STATUS = 503;
const FEEDBACK_STATUS = 404;

const viewerA = {
  owner: 200,
  finance: 200,
  analyst: 200,
  support: 200,
  adminA: 200,
  adminB: 403,
  noRole: 403,
  none: 401,
};
const anyStore = {
  owner: 200,
  finance: 200,
  analyst: 200,
  support: 200,
  adminA: 200,
  adminB: 200,
  noRole: 403,
  none: 401,
};

/** A guard that lets every principal with a token through, and an answer that needs what the unit job lacks. */
const passes = (status: number) => ({
  owner: status,
  finance: status,
  analyst: status,
  support: status,
  adminA: status,
  adminB: status,
  noRole: 403,
  none: 401,
});

const ROWS: Row[] = [
  {
    operationId: 'getStoreSalesReport',
    method: 'get',
    path: '/admin/stores/:storeId/reports/sales',
    rule: VIEWER_A,
    expect: viewerA,
    leak: true,
    call: (who) =>
      staff(who as Staff, request(app).get(`/admin/stores/${A}/reports/sales?${WINDOW}`)),
  },
  {
    operationId: 'getStoreStockReport',
    method: 'get',
    path: '/admin/stores/:storeId/reports/stock',
    rule: VIEWER_A,
    expect: viewerA,
    leak: true,
    call: (who) =>
      staff(who as Staff, request(app).get(`/admin/stores/${A}/reports/stock?limit=100`)),
  },
  {
    operationId: 'getHqSalesReport',
    method: 'get',
    path: '/admin/hq/reports/sales',
    rule: HQ_ANALYST,
    expect: {
      owner: 200,
      finance: 403,
      analyst: 200,
      support: 403,
      adminA: 403,
      adminB: 403,
      noRole: 403,
      none: 401,
    },
    call: (who) => staff(who as Staff, request(app).get(`/admin/hq/reports/sales?${WINDOW}`)),
  },
  {
    operationId: 'getHqFinanceReport',
    method: 'get',
    path: '/admin/hq/reports/finance',
    rule: HQ_FINANCE,
    expect: {
      owner: 200,
      finance: 200,
      analyst: 403,
      support: 403,
      adminA: 403,
      adminB: 403,
      noRole: 403,
      none: 401,
    },
    call: (who) => staff(who as Staff, request(app).get(`/admin/hq/reports/finance?${WINDOW}`)),
  },
  {
    operationId: 'getAttributionReport',
    method: 'get',
    path: '/admin/stores/:storeId/marketing/reports/attribution',
    rule: VIEWER_A,
    expect: viewerA,
    leak: true,
    call: (who) =>
      staff(
        who as Staff,
        request(app).get(`/admin/stores/${A}/marketing/reports/attribution?${MARKETING_WINDOW}`),
      ),
  },
  {
    operationId: 'getAbandonedCartReport',
    method: 'get',
    path: '/admin/stores/:storeId/marketing/reports/abandoned-carts',
    rule: VIEWER_A,
    expect: viewerA,
    leak: true,
    call: (who) =>
      staff(
        who as Staff,
        request(app).get(
          `/admin/stores/${A}/marketing/reports/abandoned-carts?${MARKETING_WINDOW}`,
        ),
      ),
  },
  {
    operationId: 'getPromotionReport',
    method: 'get',
    path: '/admin/stores/:storeId/marketing/reports/promotions',
    rule: VIEWER_A,
    expect: viewerA,
    leak: true,
    call: (who) =>
      staff(
        who as Staff,
        request(app).get(`/admin/stores/${A}/marketing/reports/promotions?${MARKETING_WINDOW}`),
      ),
  },
  {
    operationId: 'listMetrics',
    method: 'get',
    path: '/admin/metrics',
    rule: ANY_STORE,
    expect: anyStore,
    leak: true,
    call: (who) => staff(who as Staff, request(app).get('/admin/metrics')),
  },
  {
    operationId: 'queryMetrics',
    method: 'post',
    path: '/admin/metrics/query',
    rule: `${ANY_STORE.replace(' → 200', '')}; ${NEEDS_CLICKHOUSE}`,
    expect: passes(QUERY_STATUS),
    call: (who) =>
      staff(who as Staff, request(app).post('/admin/metrics/query')).send(metricQuery()),
  },
  {
    operationId: 'askMetrics',
    method: 'post',
    path: '/admin/metrics/ask',
    rule:
      `${ANY_STORE.replace(' → 200', '')}; with AI_ENABLED=0 the gateway refuses (ai_disabled) after the guard; ` +
      "the answer and its tool calls under the asker's scope are window 12's ask route tests",
    expect: passes(ASK_STATUS),
    call: (who) =>
      staff(who as Staff, request(app).post('/admin/metrics/ask')).send({ question: 'bookings?' }),
  },
  {
    operationId: 'askMetricsFeedback',
    method: 'post',
    path: '/admin/metrics/ask/:conversationId/feedback',
    rule:
      `${ANY_STORE.replace(' → 200', '')}; a conversation the caller never had (none can be held here: asking ` +
      "needs the model) is 404 — a rating never confirms that someone else's conversation exists",
    expect: passes(FEEDBACK_STATUS),
    call: (who) =>
      staff(who as Staff, request(app).post(`/admin/metrics/ask/${randomUUID()}/feedback`)).send({
        rating: 'up',
      }),
  },
  {
    operationId: 'draftProductCopy',
    method: 'post',
    path: '/admin/stores/:storeId/products/:productId/copy-drafts',
    rule: STAFF_A,
    expect: {
      owner: 200,
      finance: 403,
      analyst: 403,
      support: 403,
      adminA: 200,
      adminB: 403,
      noRole: 403,
      none: 401,
    },
    leak: true,
    call: (who) =>
      staff(
        who as Staff,
        request(app).post(`/admin/stores/${A}/products/${productOf.A}/copy-drafts`),
      ).send({ locale: 'de-DE', fields: ['title'] }),
  },
  {
    operationId: 'listProductRecommendations',
    method: 'get',
    path: '/store/recommendations',
    rule: STORE_KEY,
    expect: { keyA: 200, keyB: 200, noKey: 401 },
    leak: true,
    call: (who) =>
      store(
        who as StoreKey,
        request(app).get('/store/recommendations?kind=popular&window_days=30'),
      ),
  },
];

// ---- completeness: the contract's and the routers' lists ----------------------------------------------------------

const MARKETING_REPORTS = ['getAttributionReport', 'getAbandonedCartReport', 'getPromotionReport'];

type Op = { operationId: string; method: string; path: string };

function operations(file: string): (Op & { tags: string[]; text: string })[] {
  const spec = parse(readFileSync(join(openApiDir(), file), 'utf8')) as {
    paths: Record<string, Record<string, { operationId?: string; tags?: string[] }>>;
  };
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([, op]) => typeof op === 'object' && op?.operationId)
      .map(([method, op]) => ({
        operationId: op.operationId!,
        method,
        path: path.replace(/\{(\w+)\}/g, ':$1'),
        tags: op.tags ?? [],
        text: JSON.stringify(op),
      })),
  );
}

/** An admin operation's `x-permission`, read from admin-api.yaml (the same source the routes read). */
function xPermission(operationId: string): { relation: string; object: string } {
  const op = operations('admin-api.yaml').find((o) => o.operationId === operationId);
  const perm =
    op &&
    (JSON.parse(op.text) as { 'x-permission'?: { relation: string; object: string } })[
      'x-permission'
    ];
  if (!perm) throw new Error(`${operationId} has no x-permission in admin-api.yaml`);
  return perm;
}

/** Every route an Express router declares, nested routers included (they mount without a prefix here). */
function routesOf(router: express.Router): { method: string; path: string }[] {
  type Layer = {
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
  };
  return ((router as unknown as { stack: Layer[] }).stack ?? []).flatMap((layer) => {
    if (layer.route) {
      return Object.keys(layer.route.methods).map((method) => ({
        method,
        path: layer.route!.path,
      }));
    }
    return layer.handle?.stack ? routesOf(layer.handle as unknown as express.Router) : [];
  });
}

const key = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;

// ---- setup --------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  process.env.CORE_DEV_TOKENS = '1';
  // never the shared dev ClickHouse, never a real model: the routes that need them stop after the guard
  process.env.CLICKHOUSE_URL = 'http://127.0.0.1:9';
  // configured as in production (a reader exists), unreachable: the routes run their scope checks, then fail the read
  process.env.CLICKHOUSE_READONLY_USER = 'analytics_ro';
  process.env.AI_ENABLED = '0';
  db = await createTestDatabase('access_matrix');
  await seed(db.owner, { log: () => {} });
  await initDb({ connectionString: db.app.options.connectionString! });
  const hq = createOrganizationClient(db.app, { organizationId: ORG });

  for (const [subject, storeId] of [
    ['matrix-admin-a', A],
    ['matrix-admin-b', B],
  ] as const) {
    const user = await hq.query<{ id: string }>(
      `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
       VALUES ($1, $2, $3, $2, 'active') RETURNING id`,
      [ORG, subject, `${subject}@example.test`],
    );
    await hq.query(
      `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
       VALUES ($1, $2, 'store_admin', 'store', $3)`,
      [ORG, user.rows[0]!.id, storeId],
    );
  }

  // an active staff user with no role at all: the guard is the only thing that refuses it on the store:* routes
  await hq.query(
    `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
     VALUES ($1, 'matrix-no-role', 'matrix-no-role@example.test', 'matrix-no-role', 'active')`,
    [ORG],
  );

  // data in BOTH stores for every row-returning route: a promotion-coded order with an attributed last touch,
  // abandoned carts with a recovery row, and popular recommendations
  for (const [s, storeId] of [
    ['A', A],
    ['B', B],
  ] as const) {
    const products = (
      await db.owner.query<{ id: string }>(
        `SELECT id FROM product WHERE store_id = $1 AND status = 'published' ORDER BY handle LIMIT 3`,
        [storeId],
      )
    ).rows.map((r) => r.id);
    expect(products.length, `published products in ${s}`).toBe(3);
    productOf[s] = products[0]!;
    for (const [i, product] of products.entries()) {
      await db.owner.query(
        `INSERT INTO product_recommendation (organization_id, store_id, product_id, related_product_id, kind,
                                             window_days, score, computed_at)
         VALUES ($1, $2, NULL, $3, 'popular', 30, $4, now())`,
        [ORG, storeId, product, 10 - i],
      );
    }
    const channel = await db.owner.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
      [storeId],
    );
    const address = JSON.stringify({ line1: 'Matrix street 1', city: 'Testville', country: 'DE' });
    const order = await db.owner.query<{ id: string }>(
      `INSERT INTO "order" (organization_id, store_id, sales_channel_id, email, currency, locale, status,
                            shipping_address, billing_address, subtotal_minor, discount_minor, total_minor,
                            promotion_codes, placed_at)
       VALUES ($1, $2, $3, $4, 'EUR', 'en-GB', 'confirmed', $5, $5, 10000, 1000, 9000, ARRAY[$6], '2026-03-10T10:00:00Z')
       RETURNING id`,
      [ORG, storeId, channel.rows[0]!.id, `matrix-${s}@example.test`, address, MARKER[s]],
    );
    await db.owner.query(
      `INSERT INTO attribution (organization_id, store_id, order_id, touch, utm_source, utm_medium, utm_campaign,
                                captured_at)
       VALUES ($1, $2, $3, 'last', 'newsletter', 'email', $4, '2026-03-10T09:00:00Z')`,
      [ORG, storeId, order.rows[0]!.id, MARKER[s]],
    );
    const currency = (
      await db.owner.query<{ c: string }>(`SELECT default_currency AS c FROM store WHERE id = $1`, [
        storeId,
      ])
    ).rows[0]!.c;
    for (let i = 0; i < ABANDONED[s]; i++) {
      const cart = await db.owner.query<{ id: string }>(
        `INSERT INTO cart (organization_id, store_id, sales_channel_id, currency, locale, country, status)
         VALUES ($1, $2, $3, $4, 'en-GB', 'DE', 'abandoned') RETURNING id`,
        [ORG, storeId, channel.rows[0]!.id, currency],
      );
      // the token hash is computed by the database: no hash-shaped literal in the test
      await db.owner.query(
        `INSERT INTO cart_recovery (organization_id, store_id, cart_id, currency, total_minor, line_item_count,
                                    abandoned_at, token_hash, token_expires_at)
         VALUES ($1, $2, $3, $4, 1000, 1, '2026-03-12T10:00:00Z',
                 encode(sha256(gen_random_uuid()::text::bytea), 'hex'), '2026-04-12T10:00:00Z')`,
        [ORG, storeId, cart.rows[0]!.id, currency],
      );
    }
  }

  const tables = await db.owner.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND c.column_name = 'store_id' AND t.table_type = 'BASE TABLE'
        AND EXISTS (SELECT 1 FROM information_schema.columns i
                     WHERE i.table_schema = 'public' AND i.table_name = c.table_name AND i.column_name = 'id')`,
  );
  const ids = new Set<string>([B, MARKER.B]);
  for (const { table_name } of tables.rows) {
    const r = await db.owner.query<{ id: string }>(
      `SELECT id::text AS id FROM "${table_name}" WHERE store_id = $1`,
      [B],
    );
    for (const row of r.rows) ids.add(row.id);
  }
  brandBIds = [...ids];

  const transport = createFakeTransport(() => ({
    text: JSON.stringify({ title: 'Matrix title' }),
  }));
  const limiter = createMemoryLimiter();
  const audit = createMemoryAuditSink();
  previousCopyFactory = setCopyDraftGatewayFactory((ctx) =>
    createAiGateway({
      ...ctx,
      purpose: 'drafting',
      transport,
      limiter,
      audit,
      env: { AI_ENABLED: '1' },
    }),
  );

  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    moduleRouters: moduleAdminRouters(),
    storeRouters: moduleStoreRouters(),
  });
  app.use(coreErrorHandler);
}, 240_000);

afterAll(async () => {
  if (previousCopyFactory) setCopyDraftGatewayFactory(previousCopyFactory);
  await closePool();
  await db?.drop();
});

// ---- the tests ----------------------------------------------------------------------------------------------------

describe('access matrix (#612 gate 3)', () => {
  it('covers every BI, metrics, AI and recommendation route: the contract, the routers and the table agree', () => {
    const admin = operations('admin-api.yaml');
    const fromContract = [
      ...admin.filter(
        (op) =>
          op.tags.includes('reports') ||
          MARKETING_REPORTS.includes(op.operationId) ||
          /"ai_[a-z_]+"|ai_rate_limited|ai_disabled/.test(op.text),
      ),
      ...operations('store-api.yaml').filter((op) => /recommendation/i.test(op.operationId)),
    ];
    const fromRouters = [
      ...routesOf(reportingAdminRouter()),
      ...routesOf(marketingAdminRouter()).filter((r) => r.path.includes('/reports/')),
      ...moduleStoreRouters().flatMap(routesOf),
    ];
    for (const row of ROWS) {
      const axis = row.path.startsWith('/store/') ? STORE_KEYS : STAFF;
      expect(Object.keys(row.expect).sort(), `${row.operationId}: one cell per principal`).toEqual(
        [...axis].sort(),
      );
    }
    const rows = new Set(ROWS.map(key));
    const byId = new Set(ROWS.map((r) => r.operationId));

    for (const op of fromContract) {
      expect(byId.has(op.operationId), `no matrix row for ${op.operationId}`).toBe(true);
      expect(
        rows.has(key(op)),
        `${op.operationId}: the row's method/path is not the contract's`,
      ).toBe(true);
    }
    for (const r of fromRouters) expect(rows.has(key(r)), `no matrix row for ${key(r)}`).toBe(true);
    // and no stale row: each row is a route the contract AND a router declare (draftProductCopy is core's own
    // admin router, so it is checked against the contract only)
    const contractKeys = new Set(fromContract.map(key));
    const routerKeys = new Set(fromRouters.map(key));
    for (const row of ROWS) {
      expect(contractKeys.has(key(row)), `stale row ${key(row)} (not in the contract)`).toBe(true);
      if (row.operationId !== 'draftProductCopy') {
        expect(routerKeys.has(key(row)), `stale row ${key(row)} (no router declares it)`).toBe(
          true,
        );
      }
    }
  });

  for (const row of ROWS) {
    it(`${row.operationId}: ${row.method.toUpperCase()} ${row.path}`, async () => {
      const cells: string[] = [];
      for (const [who, status] of Object.entries(row.expect) as [Principal, number][]) {
        const res = await row.call(who);
        expect(res.status, `${row.operationId} as ${who}: ${JSON.stringify(res.body)}`).toBe(
          status,
        );
        if (status === 401 || status === 403) {
          expect(res.body.code, `${row.operationId} as ${who}`).toBe(
            status === 401 ? 'unauthorized' : 'forbidden',
          );
        }
        if (who === 'noRole') {
          // the GUARD refused it, not a handler's own check (listMetrics and askMetrics also 403 a caller with no
          // store, so the status alone would survive a removed guard): requirePermission's dev-token message names
          // exactly the operation's x-permission (src/http/permissions.ts)
          const perm = xPermission(row.operationId);
          expect(res.body.message, `${row.operationId} as noRole: refused by the guard`).toBe(
            `requires ${perm.relation} on ${perm.object.replace('{storeId}', A)}`,
          );
        }
        cells.push(`${who} ${status}`);
      }
      console.info(
        `[access-matrix] ${row.operationId} ${row.method.toUpperCase()} ${row.path} — ${cells.join(', ')}`,
      );
    });
  }
});

describe('the store A / store B leak (#612 gate 3)', () => {
  const leakRows = ROWS.filter((r) => r.leak);
  /** store-A principals: the store admin of A only, the seeded store staff of A only; on the Store API, A's key */
  const storeAPrincipals = (row: Row): Principal[] =>
    row.path.startsWith('/store/') ? ['keyA'] : ['adminA'];

  it('no brand-B id or marker in any response a store-A principal gets — and the responses are not empty', async () => {
    expect(brandBIds.length).toBeGreaterThan(20);
    for (const row of leakRows) {
      for (const who of storeAPrincipals(row)) {
        const res = await row.call(who);
        expect(res.status, `${row.operationId} as ${who}`).toBe(200);
        const body = JSON.stringify(res.body);
        const leaked = brandBIds.filter((id) => body.includes(id));
        expect(leaked, `${row.operationId} as ${who} leaks brand B`).toEqual([]);
      }
    }
    // the sweep is not vacuous: store A's own data is in the answers
    const sales = await ROWS.find((r) => r.operationId === 'getStoreSalesReport')!.call('adminA');
    expect(JSON.stringify(sales.body)).toContain(A);
    expect((sales.body.rows as unknown[]).length).toBeGreaterThan(0);
    const stock = await ROWS.find((r) => r.operationId === 'getStoreStockReport')!.call('adminA');
    expect((stock.body.items as unknown[]).length).toBeGreaterThan(0);
    const promotions = await ROWS.find((r) => r.operationId === 'getPromotionReport')!.call(
      'adminA',
    );
    expect(JSON.stringify(promotions.body)).toContain(MARKER.A);
    const attribution = await ROWS.find((r) => r.operationId === 'getAttributionReport')!.call(
      'adminA',
    );
    expect(JSON.stringify(attribution.body)).toContain(MARKER.A);
    const abandoned = await ROWS.find((r) => r.operationId === 'getAbandonedCartReport')!.call(
      'adminA',
    );
    expect(abandoned.body.abandoned_count).toBe(ABANDONED.A); // brand B's carts would make it 3
    const recs = await ROWS.find((r) => r.operationId === 'listProductRecommendations')!.call(
      'keyA',
    );
    expect(JSON.stringify(recs.body)).toContain(productOf.A);
    const catalogue = await ROWS.find((r) => r.operationId === 'listMetrics')!.call('adminA');
    expect(catalogue.body.stores.map((x: { id: string }) => x.id)).toEqual([A]);
  });

  it('the seeded store staff of A (store_staff on A only) leaks nothing either', async () => {
    const asStaff = (req: request.Test) => req.set('Authorization', 'Bearer dev:seed-store-staff');
    for (const path of [
      `/admin/stores/${A}/reports/sales?${WINDOW}`,
      `/admin/stores/${A}/reports/stock?limit=100`,
      `/admin/stores/${A}/marketing/reports/promotions?${MARKETING_WINDOW}`,
      '/admin/metrics',
    ]) {
      const res = await asStaff(request(app).get(path));
      expect(res.status, path).toBe(200);
      expect(
        brandBIds.filter((id) => JSON.stringify(res.body).includes(id)),
        path,
      ).toEqual([]);
    }
  });

  it('asking for brand B as a store-A principal is refused, never answered empty', async () => {
    const asA = (req: request.Test) => staff('adminA', req);
    for (const path of [
      `/admin/stores/${B}/reports/sales?${WINDOW}`,
      `/admin/stores/${B}/reports/stock`,
      `/admin/stores/${B}/marketing/reports/attribution?${MARKETING_WINDOW}`,
      `/admin/stores/${B}/marketing/reports/abandoned-carts?${MARKETING_WINDOW}`,
      `/admin/stores/${B}/marketing/reports/promotions?${MARKETING_WINDOW}`,
    ]) {
      const res = await asA(request(app).get(path));
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('forbidden');
    }
    const query = await asA(request(app).post('/admin/metrics/query')).send(
      metricQuery({ filters: { store_ids: [B] } }),
    );
    expect(query.status).toBe(403);
    expect(query.body).toMatchObject({ code: 'forbidden', details: { object: `store:${B}` } });
    const ask = await asA(request(app).post('/admin/metrics/ask')).send({
      question: 'bookings?',
      store_ids: [B],
    });
    expect(ask.status, JSON.stringify(ask.body)).toBe(403);
    const copy = await asA(
      request(app).post(`/admin/stores/${B}/products/${productOf.B}/copy-drafts`),
    ).send({ locale: 'de-DE', fields: ['title'] });
    expect(copy.status).toBe(403);
  });

  it('a store admin of BOTH stores: askMetrics without naming one is a 400 store_required before any read (ask.ts:139); queryMetrics has no such rule', async () => {
    const both = (req: request.Test) => req.set('Authorization', 'Bearer dev:seed-store-admin');
    // askMetrics: a store-level caller with several stores names exactly ONE — the question is charged to that
    // store's AI budget (admin-api.yaml askMetrics: "must name exactly ONE in store_ids … store_required")
    const ask = await both(request(app).post('/admin/metrics/ask')).send({ question: 'bookings?' });
    expect(ask.status, JSON.stringify(ask.body)).toBe(400);
    expect(ask.body).toMatchObject({
      code: 'validation_error',
      details: { field: 'store_ids', reason: 'store_required' },
    });
    // queryMetrics: the contract restricts the query to EVERY store the caller views — two stores are allowed, so
    // it passes validation and reaches the read (503 here: no ClickHouse); never a store_required
    const query = await both(request(app).post('/admin/metrics/query')).send(metricQuery());
    expect(query.status, JSON.stringify(query.body)).toBe(503);
    expect(query.body.code).toBe('unavailable');
  });

  it('a brand-B product through a brand-A path is a 404 that names nothing of brand B', async () => {
    const copy = await staff(
      'adminA',
      request(app).post(`/admin/stores/${A}/products/${productOf.B}/copy-drafts`),
    ).send({ locale: 'de-DE', fields: ['title'] });
    expect(copy.status).toBe(404);
    expect(JSON.stringify(copy.body)).not.toContain(MARKER.B);
  });

  it('the Store API key of A never returns brand B’s products, and B’s key never returns A’s', async () => {
    const path = '/store/recommendations?kind=popular&window_days=30';
    const a = await store('keyA', request(app).get(path));
    const b = await store('keyB', request(app).get(path));
    expect(JSON.stringify(a.body)).toContain(productOf.A);
    expect(JSON.stringify(a.body)).not.toContain(productOf.B);
    expect(JSON.stringify(b.body)).toContain(productOf.B);
    expect(JSON.stringify(b.body)).not.toContain(productOf.A);
  });
});
