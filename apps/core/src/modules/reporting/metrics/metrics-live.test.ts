// #603 against ClickHouse: the generated month (two brands, three currencies) in raw_events of a throwaway database,
// every model migrated, then the REAL compiler and executor:
//   * every metric compiles to SQL ClickHouse runs, at every grain;
//   * the leak property: 300 random valid queries for a store-A scope never return a row of another store, and their
//     per-currency totals equal the marts read directly for store A;
//   * a two-store scope's per-store rows equal each store's own answer (scoping is exact, not approximate);
//   * p95 latency over 200 random queries < 300 ms (measured, printed);
//   * the READ path: one compiled query through `analytics_ro` on `analytics` (readonly = 1, no per-query settings).
// Opt-in like the other ClickHouse tests (ANALYTICS_LIVE=1 with the machine; CI=true), skipped with a printed reason.
// CI (Integration 5 gates 3/5, #612): every block prints one JSON line when it passes (`test: 'metrics-live'`), the
// p95 included, and a skipped block prints why; the describe titles are pinned by require-live-tests.
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METRICS, type MetricId } from './catalogue';
import { compileMetricQuery } from './compile';
import { executeMetricQuery, type MetricsReader } from './execute';
import { randomQuery } from '../testing/metrics-queries';
import { parseMetricQuery } from './query';

const CH = {
  url: process.env.CLICKHOUSE_URL?.trim() || 'http://127.0.0.1:18123',
  username: process.env.CLICKHOUSE_USER?.trim() || 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? '',
};

async function skipReason(): Promise<string | null> {
  if (process.env.ANALYTICS_LIVE !== '1' && process.env.CI !== 'true')
    return 'not opted in (set ANALYTICS_LIVE=1 once you hold the machine)';
  try {
    const auth = Buffer.from(`${CH.username}:${CH.password}`).toString('base64');
    const res = await fetch(`${CH.url}/?query=SELECT%201`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok ? null : `ClickHouse ${CH.url}: HTTP ${res.status} for user ${CH.username}`;
  } catch (err) {
    return `ClickHouse ${CH.url}: ${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name}`;
  }
}
const skip = await skipReason();
if (skip) console.warn(`metrics-live.test: ${skip} — the metrics API ClickHouse tests are skipped`);

describe.runIf(skip === null)('metrics API on ClickHouse (#603)', () => {
  const db = `analytics_test_${Math.random().toString(36).slice(2, 8)}`;
  let close: () => Promise<void> = async () => {};
  let reader: MetricsReader;
  let A: string;
  let B: string;
  let ro: MetricsReader | null = null;
  /** BI v2 (#871): schema-valid events into this test's raw_events (classified like the ingest does) */
  let insertEvents: (events: unknown[]) => Promise<void>;
  let templateOrder: Record<string, unknown>;

  beforeAll(async () => {
    const ingest = await import('@platform/analytics-ingest');
    const { generateMonth, STORE_A, STORE_B } = await import('@platform/test-utils');
    const { createValidator } = await import('@platform/events');
    A = STORE_A;
    B = STORE_B;
    const admin = ingest.createChClient({ ...CH, database: 'default' }, 'default');
    const ch = ingest.createChClient({ ...CH, database: db }, db);
    close = async () => {
      await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => {});
      await Promise.allSettled([admin.close(), ch.close()]);
    };
    await ingest.migrate(admin, ch, db, ingest.readSqlFiles());
    const month = generateMonth({
      orders: 300,
      legalEntities: 3,
      deterministicIds: true,
      seed: 6030,
    });
    const validator = createValidator();
    const rows = month.events.map((e, i) => {
      const c = ingest.classify(
        {
          key: null,
          value: JSON.stringify(e),
          headers: { outbox_id: e.event_id },
          offset: String(i),
          timestamp: String(Date.parse(e.occurred_at)),
        },
        { topic: e.topic, partition: 0 },
        { groupId: 'analytics.raw', validator, now: new Date('2026-11-01T00:00:00Z') },
      );
      if (c.kind !== 'row') throw new Error(`fixture ${e.topic} dead-lettered`);
      return c.row;
    });
    await ingest.createRawEventsSink(ch).insert(rows);
    reader = ch as unknown as MetricsReader;
    templateOrder = month.events.find(
      (e) => e.topic === 'order.placed' && e.store_id === A,
    ) as never;
    insertEvents = async (events) => {
      const now = new Date();
      await ingest.createRawEventsSink(ch).insert(
        events.map((e, i) => {
          const ev = e as { event_id: string; topic: string; occurred_at: string };
          const c = ingest.classify(
            {
              key: null,
              value: JSON.stringify(e),
              headers: { outbox_id: ev.event_id },
              offset: String(100_000 + i),
              timestamp: String(Date.parse(ev.occurred_at)),
            },
            { topic: ev.topic, partition: 0 },
            { groupId: 'analytics.raw', validator, now },
          );
          if (c.kind !== 'row')
            throw new Error(`v2 fixture ${ev.topic} dead-lettered: ${c.letter.error_class}`);
          return c.row;
        }),
      );
    };
    const roUser = process.env.CLICKHOUSE_READONLY_USER?.trim();
    if (roUser) {
      const roClient = ingest.createChReader({
        url: CH.url,
        username: roUser,
        password: process.env.CLICKHOUSE_READONLY_PASSWORD ?? '',
        database: process.env.CLICKHOUSE_DATABASE?.trim() || 'analytics',
      });
      ro = roClient as unknown as MetricsReader;
      const prev = close;
      close = async () => {
        await roClient.close();
        await prev();
      };
    }
  }, 300_000);

  afterAll(async () => {
    await close();
  });

  it('every metric runs on ClickHouse at every grain', async () => {
    let runs = 0;
    for (const m of Object.keys(METRICS) as MetricId[])
      for (const grain of METRICS[m].grains ?? ['day', 'week', 'month', 'total']) {
        // snapshot metrics (stock now) are getInventoryHealth's (#871): queryMetrics refuses them
        if (METRICS[m].kind === 'snapshot') break;
        await executeMetricQuery(
          reader,
          parseMetricQuery({ metrics: [m], grain, from: '2026-10-01', to: '2026-11-01' }),
          [A],
          { stock: { stockItemIds: [] } },
        );
        runs += 1;
      }
    console.info(
      JSON.stringify({ test: 'metrics-live', block: 'every metric × grain', queries: runs }),
    );
  });

  it('300 random queries for a store-A scope never return another store, and their totals equal the marts for A', async () => {
    const direct = async (sql: string) =>
      (await reader.query({ query: sql, format: 'JSONEachRow', query_params: { a: A } })).json<
        Record<string, string>
      >();
    const truth = new Map(
      (
        await direct(
          `SELECT currency AS c, sum(total_minor) AS t FROM mart_bookings_daily WHERE store_id = {a:UUID} AND day >= '2026-10-01' AND day < '2027-01-01' GROUP BY c`,
        )
      ).map((r) => [r.c, Number(r.t)]),
    );
    let seed = 1;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    let rows = 0;
    let compared = 0;
    for (let i = 0; i < 300; i++) {
      const q = randomQuery(random, [A]);
      const r = await executeMetricQuery(reader, q, [A]);
      rows += r.rows.length;
      for (const row of r.rows) expect([null, A], JSON.stringify(q)).toContain(row.store_id);
      if (
        q.metrics.includes('bookings_minor') &&
        q.to === '2027-01-01' &&
        q.dimensions.length === 0
      )
        for (const t of r.currency_totals) {
          expect(t.values.bookings_minor, JSON.stringify(q)).toBe(truth.get(t.currency!) ?? 0);
          compared += 1;
        }
    }
    // and one comparison is always made (the random draw rarely lands on it with 42 metrics)
    const fixed = await executeMetricQuery(
      reader,
      parseMetricQuery({
        metrics: ['bookings_minor'],
        grain: 'total',
        from: '2026-10-01',
        to: '2027-01-01',
      }),
      [A],
    );
    for (const t of fixed.currency_totals) {
      expect(t.values.bookings_minor).toBe(truth.get(t.currency!) ?? 0);
      compared += 1;
    }
    // the property was exercised: rows came back, and totals were compared with the marts
    expect(rows).toBeGreaterThan(0);
    expect(compared).toBeGreaterThan(0);
    console.info(
      JSON.stringify({
        test: 'metrics-live',
        block: 'leak property (store A)',
        queries: 300,
        rows,
        totals_compared: compared,
      }),
    );
  });

  it('a two-store scope answers per store exactly what each store answers alone', async () => {
    const q = parseMetricQuery({
      metrics: ['bookings_minor', 'refunds_minor', 'units'],
      dimensions: ['store'],
      grain: 'month',
      from: '2026-10-01',
      to: '2027-01-01',
    });
    const both = await executeMetricQuery(reader, q, [A, B]);
    for (const s of [A, B]) {
      const alone = await executeMetricQuery(reader, q, [s]);
      expect(both.rows.filter((r) => r.store_id === s)).toEqual(alone.rows);
    }
    expect(both.rows.some((r) => r.store_id === A) && both.rows.some((r) => r.store_id === B)).toBe(
      true,
    );
    console.info(
      JSON.stringify({ test: 'metrics-live', block: 'two-store scope', rows: both.rows.length }),
    );
  });

  it('p95 latency of 200 random queries is under 300 ms', async () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const ms: number[] = [];
    for (let i = 0; i < 200; i++) {
      const q = randomQuery(random, [A, B]);
      const t = performance.now();
      await executeMetricQuery(reader, q, [A, B]);
      ms.push(performance.now() - t);
    }
    ms.sort((x, y) => x - y);
    const p50 = ms[Math.floor(ms.length * 0.5)]!;
    const p95 = ms[Math.floor(ms.length * 0.95)]!;
    console.info(
      JSON.stringify({
        test: 'metrics-live',
        queries: ms.length,
        p50_ms: Math.round(p50),
        p95_ms: Math.round(p95),
        max_ms: Math.round(ms.at(-1)!),
      }),
    );
    expect(p95).toBeLessThan(300);
  });

  it('the read path: analytics_ro reads with no per-query settings, is refused a write, and runs a compiled query', async (ctx) => {
    if (!ro) {
      console.warn(
        'metrics-live.test: CLICKHOUSE_READONLY_USER is not set — the analytics_ro read path is skipped',
      );
      return ctx.skip();
    }
    // reading is accepted without any per-query setting (the profile carries readonly and the limits)
    const r = await (
      await ro.query({ query: 'SELECT count() AS n FROM raw_events', format: 'JSONEachRow' })
    ).json<{ n: string }>();
    expect(Number(r[0]!.n)).toBeGreaterThanOrEqual(0);
    // readonly = 1: a write through the reader is refused by the server
    await expect(
      ro
        .query({
          query: 'CREATE TABLE ro_write_probe (x UInt8) ENGINE = Memory',
          format: 'JSONEachRow',
        })
        .then((x) => x.json()),
    ).rejects.toThrow();
    // a compiled query, when the shared database carries the models (it is migrated by the deploy, not by tests)
    const marts = await (
      await ro.query({
        query:
          "SELECT count() AS n FROM system.tables WHERE database = currentDatabase() AND name = 'mart_sales_daily'",
        format: 'JSONEachRow',
      })
    ).json<{ n: string }>();
    if (Number(marts[0]!.n) === 0) {
      console.warn(
        'metrics-live.test: the shared analytics database does not carry the catalogue v2 models yet (mart_sales_daily; ch:migrate not run on it): the compiled query through analytics_ro is skipped; reading and the readonly refusal are proven above',
      );
      return;
    }
    const q = parseMetricQuery({
      metrics: ['orders'],
      grain: 'total',
      from: '2026-01-01',
      to: '2027-01-01',
    });
    await expect(executeMetricQuery(ro, q, [A])).resolves.toMatchObject({ truncated: false });
    expect(compileMetricQuery(q, [A]).sources).toHaveLength(1);
    console.info(
      JSON.stringify({
        test: 'metrics-live',
        block: 'read path (analytics_ro)',
        compiled_query: true,
      }),
    );
  });

  describe('a store-scoped principal cannot escape its scope over HTTP (the real router, real data)', () => {
    let pg: { drop(): Promise<void> } | undefined;
    let app: Express;
    let closePg: () => Promise<void> = async () => {};
    const ask = (subject: string, body: Record<string, unknown>) =>
      request(app)
        .post('/admin/metrics/query')
        .set('Authorization', `Bearer dev:${subject}`)
        .send({ grain: 'total', from: '2026-10-01', to: '2027-01-01', ...body });

    beforeAll(async () => {
      const express = (await import('express')).default;
      const { createOrganizationClient, SEED_IDS } = await import('@platform/db');
      const { createReportingDatabase } = await import('../testing/fixtures');
      const { coreErrorHandler, DevTokenVerifier } = await import('../../../http');
      const { closePool, initDb } = await import('../../../lib/db');
      const { mountCoreMiddleware } = await import('../../../server');
      const { metricsAdminRouter } = await import('./routes');
      process.env.CORE_DEV_TOKENS = '1';
      const db = await createReportingDatabase('metrics_live');
      pg = db;
      await initDb({ connectionString: db.app.options.connectionString! });
      closePg = async () => {
        await closePool();
        await db.drop();
      };
      const hq = createOrganizationClient(db.app, { organizationId: SEED_IDS.organization });
      const user = await hq.query<{ id: string }>(
        `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
         VALUES ($1, 'escape-admin-a', 'escape-admin-a@example.test', 'Escape admin A', 'active') RETURNING id`,
        [SEED_IDS.organization],
      );
      await hq.query(
        `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
         VALUES ($1, $2, 'store_admin', 'store', $3)`,
        [SEED_IDS.organization, user.rows[0]!.id, A],
      );
      const posted = { relation: 'viewer', object: 'store:*' };
      app = express();
      mountCoreMiddleware(app, new DevTokenVerifier(), {
        moduleRouters: [
          metricsAdminRouter({
            reader,
            spec: { permission: () => posted, validateBody: () => {} },
          }),
        ],
      });
      app.use(coreErrorHandler);
    }, 240_000);

    afterAll(async () => {
      if (pg) await closePg();
    });

    it('(a) store_ids of another store → 403, nothing read', async () => {
      const r = await ask('escape-admin-a', {
        metrics: ['bookings_minor'],
        filters: { store_ids: [B] },
      });
      expect(r.status).toBe(403);
      expect(r.body.details).toEqual({ relation: 'viewer', object: `store:${B}` });
    });

    it('(b) no store_ids → exactly the totals of its own store (equal to store A asked for directly)', async () => {
      const mine = await ask('escape-admin-a', { metrics: ['bookings_minor', 'refunds_minor'] });
      const direct = await executeMetricQuery(
        reader,
        parseMetricQuery({
          metrics: ['bookings_minor', 'refunds_minor'],
          grain: 'total',
          from: '2026-10-01',
          to: '2027-01-01',
        }),
        [A],
      );
      expect(mine.status).toBe(200);
      expect(mine.body.currency_totals).toEqual(direct.currency_totals);
      expect(mine.body.currency_totals.length).toBeGreaterThan(0);
    });

    it('(c) a store dimension → only its own store appears', async () => {
      const r = await ask('escape-admin-a', {
        metrics: ['bookings_minor', 'units'],
        dimensions: ['store'],
      });
      expect(r.status).toBe(200);
      expect(r.body.rows.length).toBeGreaterThan(0);
      expect(new Set(r.body.rows.map((x: { store_id: string }) => x.store_id))).toEqual(
        new Set([A]),
      );
    });

    it('(d) a finance metric without finance → 403', async () => {
      const r = await ask('escape-admin-a', { metrics: ['captured_minor'] });
      expect(r.status).toBe(403);
      expect(r.body.details).toMatchObject({ relation: 'finance', object: 'organization:hq' });
    });

    it('an organization principal sees all three brands', async () => {
      const r = await ask('seed-analyst', { metrics: ['bookings_minor'], dimensions: ['store'] });
      expect(r.status).toBe(200);
      expect(new Set(r.body.rows.map((x: { store_id: string }) => x.store_id)).size).toBe(3);
      console.info(
        JSON.stringify({ test: 'metrics-live', block: 'HTTP scope escape (a)-(d) + organization' }),
      );
    });
  });

  // ---- BI v2 (#871): the two new operations, compare and the stock series over HTTP, on real data -------------------
  describe('BI v2 over HTTP: inventory health, movers, compare and the stock series stay in scope (#871)', () => {
    let pg: { drop(): Promise<void> } | undefined;
    let app: Express;
    let closePg: () => Promise<void> = async () => {};
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const post = (path: string, subject: string, body: Record<string, unknown>) =>
      request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body);
    let aItem: string;
    let bOnlyItem: string;
    let aSku: string;
    let bSku: string;
    const p95 = async (n: number, call: () => Promise<{ status: number }>) => {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        expect((await call()).status).toBe(200);
        ms.push(performance.now() - t);
      }
      ms.sort((x, y) => x - y);
      return {
        p50: Math.round(ms[Math.floor(n * 0.5)]!),
        p95: Math.round(ms[Math.floor(n * 0.95)]!),
        max: Math.round(ms.at(-1)!),
      };
    };

    beforeAll(async () => {
      const express = (await import('express')).default;
      const { createOrganizationClient, SEED_IDS } = await import('@platform/db');
      const { makeEvent } = await import('@platform/events');
      const { createReportingDatabase } = await import('../testing/fixtures');
      const { coreErrorHandler, DevTokenVerifier } = await import('../../../http');
      const { closePool, initDb } = await import('../../../lib/db');
      const { mountCoreMiddleware } = await import('../../../server');
      const { metricsAdminRouter } = await import('./routes');
      process.env.CORE_DEV_TOKENS = '1';
      const db = await createReportingDatabase('metrics_v2');
      pg = db;
      await initDb({ connectionString: db.app.options.connectionString! });
      closePg = async () => {
        await closePool();
        await db.drop();
      };
      const hq = createOrganizationClient(db.app, { organizationId: SEED_IDS.organization });
      const user = await hq.query<{ id: string }>(
        `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
         VALUES ($1, 'v2-admin-a', 'v2-admin-a@example.test', 'V2 admin A', 'active') RETURNING id`,
        [SEED_IDS.organization],
      );
      await hq.query(
        `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
         VALUES ($1, $2, 'store_admin', 'store', $3)`,
        [SEED_IDS.organization, user.rows[0]!.id, A],
      );
      // a stock item only store A sells from, one only store B sells from, and a warehouse each lies in
      const pick = async (store: string, other: string) =>
        (
          await hq.query<{ variant: string; item: string; sku: string; warehouse: string }>(
            `SELECT v.id::text AS variant, v.stock_item_id::text AS item, v.sku, il.warehouse_id::text AS warehouse
               FROM product_variant v JOIN inventory_level il ON il.stock_item_id = v.stock_item_id
              WHERE v.store_id = $1
                AND NOT EXISTS (SELECT 1 FROM product_variant o
                                 WHERE o.store_id = $2 AND o.stock_item_id = v.stock_item_id)
              ORDER BY v.id LIMIT 1`,
            [store, other],
          )
        ).rows[0]!;
      const a = await pick(A, B);
      const b = await pick(B, A);
      aItem = a.item;
      bOnlyItem = b.item;
      aSku = a.sku;
      bSku = b.sku;
      // sales two days ago (inside the 28-day rate window): 6 units of A's item at A, 4 of B's item at B
      const order = (store: string, variant: string, sku: string, quantity: number) => {
        const t = templateOrder as { payload: Record<string, unknown> };
        const line = (t.payload.line_items as Record<string, unknown>[])[0]!;
        const placed = new Date(Date.now() - 2 * 86_400_000);
        return makeEvent({
          topic: 'order.placed',
          organizationId: SEED_IDS.organization,
          storeId: store,
          aggregateType: 'order',
          aggregateId: crypto.randomUUID(),
          occurredAt: placed,
          payload: {
            ...(t.payload as object),
            order_id: crypto.randomUUID(),
            line_items: [
              {
                ...line,
                order_line_item_id: crypto.randomUUID(),
                variant_id: variant,
                sku,
                quantity,
              },
            ],
            placed_at: placed.toISOString(),
          } as never,
        });
      };
      // pool receipts yesterday (no store caused them): 50 of A's item, 70 of B's
      const receipt = (item: string, sku: string, warehouse: string, delta: number) =>
        makeEvent({
          topic: 'stock.moved',
          organizationId: SEED_IDS.organization,
          storeId: null,
          aggregateType: 'stock_item' as never,
          aggregateId: item,
          occurredAt: new Date(Date.now() - 86_400_000),
          payload: {
            stock_movement_id: crypto.randomUUID(),
            stock_item_id: item,
            sku,
            warehouse_id: warehouse,
            delta,
            reason: 'receipt',
            reference_type: null,
            reference_id: null,
            on_hand_after: 1000 + delta,
            reserved_after: 0,
          } as never,
        });
      await insertEvents([
        order(A, a.variant, a.sku, 6),
        order(B, b.variant, b.sku, 4),
        receipt(a.item, a.sku, a.warehouse, 50),
        receipt(b.item, b.sku, b.warehouse, 70),
      ]);
      const posted = { relation: 'viewer', object: 'store:*' };
      app = express();
      mountCoreMiddleware(app, new DevTokenVerifier(), {
        moduleRouters: [
          metricsAdminRouter({
            reader,
            spec: { permission: () => posted, validateBody: () => {} },
          }),
        ],
      });
      app.use(coreErrorHandler);
    }, 240_000);

    afterAll(async () => {
      if (pg) await closePg();
    });

    it('inventory: a store admin sees its own items and its own sales only; HQ sees every brand', async () => {
      const mine = await post('/admin/metrics/inventory', 'v2-admin-a', { limit: 500 });
      const mineA = await post('/admin/metrics/inventory', 'v2-admin-a', { q: aSku });
      const mineB = await post('/admin/metrics/inventory', 'v2-admin-a', { q: bSku });
      expect(mine.status).toBe(200);
      const rows = mine.body.rows as {
        stock_item_id: string;
        store_ids: string[];
        units_sold: number;
      }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.store_ids).toEqual([A]);
      expect(rows.some((r) => r.stock_item_id === bOnlyItem)).toBe(false);
      expect(
        (mineB.body.rows as { stock_item_id: string }[]).some((r) => r.stock_item_id === bOnlyItem),
      ).toBe(false);
      expect(
        (mineA.body.rows as { stock_item_id: string; units_sold: number }[]).find(
          (r) => r.stock_item_id === aItem,
        ),
      ).toMatchObject({ units_sold: 6 });
      expect(mine.body).toMatchObject({ incoming_tracked: false, rate_available: true });
      const hq = await post('/admin/metrics/inventory', 'seed-analyst', { q: bSku });
      expect(hq.status).toBe(200);
      expect(
        (hq.body.rows as { stock_item_id: string; units_sold: number }[]).find(
          (r) => r.stock_item_id === bOnlyItem,
        ),
      ).toMatchObject({ units_sold: 4 });
      // a warehouse the caller cannot see is a 403, never a silent narrowing
      const other = await post('/admin/metrics/inventory', 'v2-admin-a', {
        warehouse_ids: ['00000000-0000-4000-8000-00000000dead'],
      });
      expect(other.status).toBe(403);
      console.info(
        JSON.stringify({
          test: 'metrics-live',
          block: 'v2 inventory scope',
          store_rows: rows.length,
          hq_rows: hq.body.rows.length,
        }),
      );
    });

    it('the stock series: a store admin counts the pool receipts of its own items only (#871 review 1)', async () => {
      const body = { metrics: ['units_received'], grain: 'total', from: day(-7), to: day(1) };
      const mine = await post('/admin/metrics/query', 'v2-admin-a', body);
      const all = await post('/admin/metrics/query', 'seed-analyst', body);
      expect(mine.status).toBe(200);
      expect(mine.body.currency_totals).toEqual([
        { currency: null, values: { units_received: 50 } },
      ]);
      expect(all.body.currency_totals).toEqual([
        { currency: null, values: { units_received: 120 } },
      ]);
      console.info(
        JSON.stringify({
          test: 'metrics-live',
          block: 'v2 stock series leak',
          store_a: 50,
          hq: 120,
        }),
      );
    });

    it('movers and compare stay in scope, movers ranked per currency', async () => {
      const mv = { metric: 'net_sales_minor', dimension: 'store', from: day(-7), to: day(1) };
      const mine = await post('/admin/metrics/movers', 'v2-admin-a', mv);
      expect(mine.status).toBe(200);
      type Block = { risers: { key: string }[]; fallers: { key: string }[] };
      const keys = (mine.body.by_currency as Block[]).flatMap((b) => [
        ...b.risers.map((m) => m.key),
        ...b.fallers.map((m) => m.key),
      ]);
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys)).toEqual(new Set([A]));
      expect(mine.body.labels.store[A]).toBeTruthy();
      const hq = await post('/admin/metrics/movers', 'seed-analyst', mv);
      expect(
        new Set((hq.body.by_currency as Block[]).flatMap((b) => b.risers.map((m) => m.key))),
      ).toEqual(new Set([A, B]));
      const cmp = await post('/admin/metrics/query', 'v2-admin-a', {
        metrics: ['net_sales_minor', 'units'],
        grain: 'total',
        from: day(-7),
        to: day(1),
        compare: 'previous_period',
      });
      expect(cmp.status).toBe(200);
      expect(cmp.body.compare).toMatchObject({
        mode: 'previous_period',
        offset: '-8d',
        current_incomplete: true,
      });
      for (const r of [...cmp.body.rows, ...cmp.body.compare.rows])
        expect([null, A]).toContain(r.store_id);
      expect(cmp.body.compare.changes.length).toBeGreaterThan(0);
    });

    it('cost: p95 of the new operations on seeded data (inventory < 300 ms, movers and compare < 600 ms)', async () => {
      const inv = await p95(30, () => post('/admin/metrics/inventory', 'v2-admin-a', {}));
      const invHq = await p95(30, () => post('/admin/metrics/inventory', 'seed-analyst', {}));
      const mv = await p95(30, () =>
        post('/admin/metrics/movers', 'seed-analyst', {
          metric: 'net_sales_minor',
          dimension: 'store',
          from: '2026-10-01',
          to: '2026-11-01',
        }),
      );
      const cmp = await p95(30, () =>
        post('/admin/metrics/query', 'seed-analyst', {
          metrics: ['net_sales_minor', 'orders'],
          dimensions: ['store'],
          grain: 'day',
          from: '2026-10-01',
          to: '2026-11-01',
          compare: 'previous_period',
        }),
      );
      console.info(
        JSON.stringify({
          test: 'metrics-live',
          block: 'v2 cost (HTTP, ms)',
          inventory_store: inv,
          inventory_hq: invHq,
          movers: mv,
          compare: cmp,
        }),
      );
      expect(inv.p95).toBeLessThan(300);
      expect(invHq.p95).toBeLessThan(300);
      expect(mv.p95).toBeLessThan(600);
      expect(cmp.p95).toBeLessThan(600);
    });
  });
});
