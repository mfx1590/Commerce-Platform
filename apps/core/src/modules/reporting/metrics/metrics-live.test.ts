// #603 against ClickHouse: the generated month (two brands, three currencies) in raw_events of a throwaway database,
// every model migrated, then the REAL compiler and executor:
//   * every metric compiles to SQL ClickHouse runs, at every grain;
//   * the leak property: 300 random valid queries for a store-A scope never return a row of another store, and their
//     per-currency totals equal the marts read directly for store A;
//   * a two-store scope's per-store rows equal each store's own answer (scoping is exact, not approximate);
//   * p95 latency over 200 random queries < 300 ms (measured, printed);
//   * the READ path: one compiled query through `analytics_ro` on `analytics` (readonly = 1, no per-query settings).
// Opt-in like the other ClickHouse tests (ANALYTICS_LIVE=1 with the machine; CI=true), skipped with a printed reason.
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
    for (const m of Object.keys(METRICS) as MetricId[])
      for (const grain of METRICS[m].grains ?? ['day', 'week', 'month', 'total'])
        await executeMetricQuery(
          reader,
          parseMetricQuery({ metrics: [m], grain, from: '2026-10-01', to: '2026-11-01' }),
          [A],
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
    for (let i = 0; i < 300; i++) {
      const q = randomQuery(random, [A]);
      const r = await executeMetricQuery(reader, q, [A]);
      for (const row of r.rows) expect([null, A], JSON.stringify(q)).toContain(row.store_id);
      if (
        q.metrics.includes('bookings_minor') &&
        q.to === '2027-01-01' &&
        q.dimensions.length === 0
      )
        for (const t of r.currency_totals)
          expect(t.values.bookings_minor, JSON.stringify(q)).toBe(truth.get(t.currency!) ?? 0);
    }
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
    if (!ro) return ctx.skip();
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
          "SELECT count() AS n FROM system.tables WHERE database = currentDatabase() AND name = 'mart_bookings_daily'",
        format: 'JSONEachRow',
      })
    ).json<{ n: string }>();
    if (Number(marts[0]!.n) === 0) {
      console.warn(
        'metrics-live.test: the shared analytics database has no models yet (ch:migrate not run on it): the compiled query through analytics_ro is skipped; reading and the readonly refusal are proven above',
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
    });
  });
});
