// #603 against ClickHouse: the generated month (two brands, three currencies) in raw_events of a throwaway database,
// every model migrated, then the REAL compiler and executor:
//   * every metric compiles to SQL ClickHouse runs, at every grain;
//   * the leak property: 300 random valid queries for a store-A scope never return a row of another store, and their
//     per-currency totals equal the marts read directly for store A;
//   * a two-store scope's per-store rows equal each store's own answer (scoping is exact, not approximate);
//   * p95 latency over 200 random queries < 300 ms (measured, printed);
//   * the READ path: one compiled query through `analytics_ro` on `analytics` (readonly = 1, no per-query settings).
// Opt-in like the other ClickHouse tests (ANALYTICS_LIVE=1 with the machine; CI=true), skipped with a printed reason.
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
      for (const grain of ['day', 'week', 'month', 'total'])
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

  it('the read path: a compiled query runs as analytics_ro on analytics (readonly, no per-query settings)', async (ctx) => {
    if (!ro) return ctx.skip();
    const q = parseMetricQuery({
      metrics: ['orders'],
      grain: 'total',
      from: '2026-01-01',
      to: '2027-01-01',
    });
    // the dev database may hold anything or nothing: the point is that the read path is accepted
    await expect(executeMetricQuery(ro, q, [A])).resolves.toMatchObject({ truncated: false });
    expect(compileMetricQuery(q, [A]).sources).toHaveLength(1);
  });
});
