// The BI Q&A golden set (#606 acceptance: 30 questions, a fake model, recorded tool calls), two ways:
//   * unit (always): a fake analytics reader that answers every metric for the stores a statement is scoped to;
//   * live (ANALYTICS_LIVE=1 with the machine; CI=true): the generated month in a throwaway ClickHouse database, the
//     real compiler and executor — the figures in each answer are checked against what ClickHouse returned.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METRIC_IDS } from '../../metrics/catalogue';
import type { MetricsReader } from '../../metrics/execute';
import { GOLDEN, type GoldenEnv } from './cases';
import { runGoldenCase, type GoldenStores } from './run';

it('the golden set has 30 questions with distinct ids', () => {
  expect(GOLDEN).toHaveLength(30);
  expect(new Set(GOLDEN.map((c) => c.id)).size).toBe(30);
});

describe('golden set on the fake reader (CI)', () => {
  const stores: GoldenStores = {
    A: { id: '00000000-0000-4000-8000-000000000031', code: 'brand-a' },
    B: { id: '00000000-0000-4000-8000-000000000032', code: 'brand-b' },
  };
  const env: GoldenEnv = {
    A: stores.A.id,
    B: stores.B.id,
    product: '00000000-0000-4000-8000-000000000071',
  };
  const reader: MetricsReader = {
    async query({ query, query_params }) {
      if (query.includes('FROM raw_events')) return { json: async <T>() => [{ t: null }] as T[] };
      const scope = (query_params?.scope as string[]) ?? [];
      const rows = scope.map((s, i) => ({
        out_period: '2026-10-01',
        out_currency: 'EUR',
        out_store: s,
        out_product: env.product,
        out_reason: 'return',
        out_provider: 'stripe',
        ...Object.fromEntries(METRIC_IDS.map((m, j) => [`m_${m}`, 1_000 * (i + 1) + j])),
      }));
      return { json: async <T>() => rows as T[] };
    },
  };

  it('the checks are not vacuous: a figure no result holds, or a citation of nothing, is caught', async () => {
    const one = GOLDEN.find((c) => c.id === 1)!;
    const made = await runGoldenCase(one, env, stores, reader, 'bookings_minor EUR 999999.99 [q1]');
    expect(made.problems).toEqual(['999999.99 [q1] is not in that result']);
    const dangling = await runGoldenCase(one, env, stores, reader, 'bookings_minor EUR 1.00 [q7]');
    expect(dangling.problems).toEqual(['[q7] cites no result']);
  });

  it.each(GOLDEN.map((c) => [c.id, c.question, c] as const))('#%i %s', async (_id, _q, c) => {
    const { problems } = await runGoldenCase(c, env, stores, reader);
    expect(problems).toEqual([]);
  });
});

// ---- live: the generated month on ClickHouse ----------------------------------------------------------------------

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
if (skip) console.warn(`golden.test (live): ${skip} — the ClickHouse golden run is skipped`);

describe.runIf(skip === null)('golden set on the generated month (ClickHouse)', () => {
  const db = `analytics_test_${Math.random().toString(36).slice(2, 8)}`;
  let close: () => Promise<void> = async () => {};
  let reader: MetricsReader;
  let env: GoldenEnv;
  let stores: GoldenStores;

  beforeAll(async () => {
    const ingest = await import('@platform/analytics-ingest');
    const { generateMonth, STORE_A, STORE_B } = await import('@platform/test-utils');
    const { createValidator } = await import('@platform/events');
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
      seed: 6060,
    });
    const validator = createValidator();
    const rows = month.events.map((e, i) => {
      const c = ingest.classify(
        { key: null, value: JSON.stringify(e), headers: {}, offset: String(i), timestamp: '0' },
        { groupId: 'analytics.raw', validator, now: new Date('2026-11-01T00:00:00Z') },
      );
      if (c.kind !== 'row') throw new Error(`fixture ${e.topic} dead-lettered`);
      return c.row;
    });
    await ingest.createRawEventsSink(ch).insert(rows);
    reader = ch as unknown as MetricsReader;
    const productRows = await (
      await ch.query({
        query:
          'SELECT toString(product_id) AS p FROM fct_order_line WHERE store_id = {a:UUID} LIMIT 1',
        format: 'JSONEachRow',
        query_params: { a: STORE_A },
      })
    ).json<{ p: string }>();
    stores = { A: { id: STORE_A, code: 'brand-a' }, B: { id: STORE_B, code: 'brand-b' } };
    env = {
      A: STORE_A,
      B: STORE_B,
      product: productRows[0]?.p ?? '00000000-0000-4000-8000-000000000071',
    };
  }, 300_000);

  afterAll(async () => {
    await close();
  });

  it('all 30 questions: queries valid or refused as expected, every figure backed by its result, no other store', async () => {
    const failures: string[] = [];
    for (const c of GOLDEN) {
      const { problems } = await runGoldenCase(c, env, stores, reader);
      for (const p of problems) failures.push(`#${c.id} ${c.question}: ${p}`);
    }
    expect(failures).toEqual([]);
  });
});
