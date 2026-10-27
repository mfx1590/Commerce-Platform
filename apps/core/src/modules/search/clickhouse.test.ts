// The ClickHouse read side (task P5.8, #607). Two halves:
//
//  * the client and the fixture source, over a stubbed fetch — always run. They cover what the aggregation
//    CONTRACT is (bound parameters, never interpolated SQL), that credentials never reach an error message, the
//    retry, and that the fixture source applies the same two filters and the same windowing as the SQL.
//  * one ClickHouse-backed test, SKIPPED with a printed reason until window 12's #601 (PR #619) is on main and
//    `analytics.fct_order_line` exists. The manager says when; `CORE_RECOMMENDATIONS_CLICKHOUSE_TESTS=1` plus a
//    reachable ClickHouse turns it on.
import { describe, expect, it } from 'vitest';
import {
  ClickHouseBasketSource,
  ClickHouseClient,
  clickhouseCredentialsFrom,
  ClickHouseError,
  DEFAULT_THRESHOLDS,
  FixtureBasketSource,
  pairKey,
  type FixtureLine,
} from './index';

const CREDS = {
  url: 'http://clickhouse.invalid:18123',
  database: 'analytics',
  user: 'analytics_ro',
  // A word, not a secret-shaped literal: gitleaks scans every branch's history.
  password: 'readonly-word-alpha',
};

const STORE = '30000000-0000-4000-8000-000000000031';
const NOW = new Date('2026-10-27T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** A fetch stub that records the calls and answers JSONEachRow bodies in order. */
function stubFetch(bodies: string[]) {
  const calls: { url: string; sql: string }[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), sql: String(init?.body ?? '') });
    const body = bodies[Math.min(i++, bodies.length - 1)] ?? '';
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

describe('ClickHouseClient', () => {
  it('binds parameters through param_* and never interpolates them into the SQL', async () => {
    const { impl, calls } = stubFetch([jsonl([{ n: '1' }])]);
    const client = new ClickHouseClient({ ...CREDS, fetchImpl: impl });
    await client.query('SELECT {storeId:UUID} AS n', { storeId: STORE, lookbackDays: 90 });

    const call = calls[0] as { url: string; sql: string };
    expect(call.url).toContain(`param_storeId=${STORE}`);
    expect(call.url).toContain('param_lookbackDays=90');
    expect(call.url).toContain('default_format=JSONEachRow');
    expect(call.url).toContain('database=analytics');
    // The store id is a parameter, not part of the statement.
    expect(call.sql).toBe('SELECT {storeId:UUID} AS n');
    expect(call.sql).not.toContain(STORE);
  });

  it('parses JSONEachRow and ignores blank lines', async () => {
    const { impl } = stubFetch([`${jsonl([{ a: '1' }, { a: '2' }])}\n`]);
    const client = new ClickHouseClient({ ...CREDS, fetchImpl: impl });
    await expect(client.query<{ a: string }>('SELECT 1')).resolves.toEqual([
      { a: '1' },
      { a: '2' },
    ]);
  });

  it('keeps the credentials out of the error', async () => {
    const impl = (async () =>
      new Response(`Authentication failed for user analytics_ro with password ${CREDS.password}`, {
        status: 403,
      })) as unknown as typeof fetch;
    const client = new ClickHouseClient({ ...CREDS, fetchImpl: impl, retries: 0 });
    await expect(client.query('SELECT 1')).rejects.toThrow(ClickHouseError);
    const err = await client.query('SELECT 1').catch((e: unknown) => e as Error);
    expect(err.message).not.toContain(CREDS.password);
    expect(err.message).not.toContain(CREDS.user);
    expect(err.message).toContain('***');
  });

  it('retries a 500 and gives up after the configured attempts', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return new Response('upstream wobble', { status: 500 });
    }) as unknown as typeof fetch;
    const client = new ClickHouseClient({ ...CREDS, fetchImpl: impl, retries: 2 });
    await expect(client.query('SELECT 1')).rejects.toThrow(/clickhouse 500/);
    expect(calls).toBe(3);
  });

  it('builds the three aggregates a rebuild needs', async () => {
    const { impl, calls } = stubFetch([
      jsonl([{ baskets: '10' }]),
      jsonl([
        { product_id: 'p1', baskets: '6' },
        { product_id: 'p2', baskets: '5' },
      ]),
      jsonl([{ a: 'p1', b: 'p2', baskets: '4' }]),
    ]);
    const source = new ClickHouseBasketSource(new ClickHouseClient({ ...CREDS, fetchImpl: impl }));
    const counts = await source.counts(STORE, DEFAULT_THRESHOLDS);

    expect(counts.basketCount).toBe(10);
    expect(counts.singles.get('p1')).toBe(6);
    expect(counts.pairs.get(pairKey('p1', 'p2'))).toBe(4);
    // The manager's two filters are in every statement, and the support floor is pushed into the HAVING.
    for (const c of calls) {
      expect(c.sql).toContain("order_status != 'cancelled'");
      expect(c.sql).toContain('product_id IS NOT NULL');
    }
    expect(calls[2]?.sql).toContain('HAVING baskets >= {minSupport:UInt32}');
  });

  it('asks for no pair work at all when the store has no baskets', async () => {
    const { impl, calls } = stubFetch([jsonl([{ baskets: '0' }])]);
    const source = new ClickHouseBasketSource(new ClickHouseClient({ ...CREDS, fetchImpl: impl }));
    const counts = await source.counts(STORE, DEFAULT_THRESHOLDS);
    expect(counts.basketCount).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe('clickhouseCredentialsFrom', () => {
  it('reads the READ-ONLY pair, not the writer', () => {
    const creds = clickhouseCredentialsFrom({
      CLICKHOUSE_URL: 'http://127.0.0.1:18123',
      CLICKHOUSE_DATABASE: 'analytics',
      CLICKHOUSE_USER: 'platform',
      CLICKHOUSE_PASSWORD: 'platform',
      CLICKHOUSE_READONLY_USER: 'analytics_ro',
      CLICKHOUSE_READONLY_PASSWORD: 'analytics_ro',
    } as NodeJS.ProcessEnv);
    expect(creds).toEqual({
      url: 'http://127.0.0.1:18123',
      database: 'analytics',
      user: 'analytics_ro',
      password: 'analytics_ro',
    });
  });

  it('is null when the read-only pair is incomplete, so the job can skip instead of guessing', () => {
    expect(
      clickhouseCredentialsFrom({ CLICKHOUSE_URL: 'http://x' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe('FixtureBasketSource (the stand-in until #601 lands)', () => {
  const [p0, p1, p2] = ['pa', 'pb', 'pc'];
  const lines: FixtureLine[] = [
    {
      store_id: STORE,
      order_id: 'o1',
      product_id: p0,
      quantity: 2,
      placed_at: daysAgo(1),
      order_status: 'placed',
    },
    {
      store_id: STORE,
      order_id: 'o1',
      product_id: p1,
      quantity: 1,
      placed_at: daysAgo(1),
      order_status: 'placed',
    },
    {
      store_id: STORE,
      order_id: 'o2',
      product_id: p0,
      quantity: 1,
      placed_at: daysAgo(2),
      order_status: 'placed',
    },
    {
      store_id: STORE,
      order_id: 'o2',
      product_id: p1,
      quantity: 1,
      placed_at: daysAgo(2),
      order_status: 'placed',
    },
    // dropped: cancelled
    {
      store_id: STORE,
      order_id: 'o3',
      product_id: p2,
      quantity: 9,
      placed_at: daysAgo(1),
      order_status: 'cancelled',
    },
    // dropped: the variant was never published, so ClickHouse has no product for it
    {
      store_id: STORE,
      order_id: 'o4',
      product_id: null,
      quantity: 5,
      placed_at: daysAgo(1),
      order_status: 'placed',
    },
    // dropped from the 7-day window only
    {
      store_id: STORE,
      order_id: 'o5',
      product_id: p2,
      quantity: 3,
      placed_at: daysAgo(20),
      order_status: 'placed',
    },
    // dropped: another store
    {
      store_id: 'other',
      order_id: 'o6',
      product_id: p2,
      quantity: 7,
      placed_at: daysAgo(1),
      order_status: 'placed',
    },
  ];
  const source = new FixtureBasketSource(lines, () => NOW);

  it('drops cancelled orders, unmapped lines and other stores', async () => {
    const counts = await source.counts(STORE, DEFAULT_THRESHOLDS);
    expect(counts.basketCount).toBe(3); // o1, o2, o5
    expect(counts.singles.get(p0)).toBe(2);
    expect(counts.singles.has('')).toBe(false);
    expect(counts.pairs.get(pairKey(p0, p1))).toBe(2);
  });

  it('sums quantity for the popular list and respects the window', async () => {
    expect([...(await source.units(STORE, 7)).entries()].sort()).toEqual([
      [p0, 3],
      [p1, 2],
    ]);
    const thirty = await source.units(STORE, 30);
    expect(thirty.get(p2)).toBe(3);
  });
});

// ---- ClickHouse-backed, skipped with a reason until #601 is on main ----
const liveReason = (): string | null => {
  if (process.env.CORE_RECOMMENDATIONS_CLICKHOUSE_TESTS !== '1') {
    return 'CORE_RECOMMENDATIONS_CLICKHOUSE_TESTS is not 1 — window 12 #601 (PR #619) is not on main yet, so analytics.fct_order_line does not exist';
  }
  if (!clickhouseCredentialsFrom()) {
    return 'CLICKHOUSE_URL / CLICKHOUSE_READONLY_USER / CLICKHOUSE_READONLY_PASSWORD are not set';
  }
  return null;
};

describe('against a real ClickHouse (#601 interface)', () => {
  const reason = liveReason();
  it.skipIf(reason !== null)('reads fct_order_line with the read-only user', async () => {
    const creds = clickhouseCredentialsFrom();
    if (!creds) throw new Error('unreachable: the skip guard checked this');
    const source = new ClickHouseBasketSource(new ClickHouseClient(creds));
    const counts = await source.counts(STORE, DEFAULT_THRESHOLDS);
    expect(counts.basketCount).toBeGreaterThanOrEqual(0);
    const units = await source.units(STORE, 7);
    expect(units).toBeInstanceOf(Map);
  });

  if (reason !== null) {
    // Printed so a green local run never looks like proof that this seam works.
    console.info(`[search] recommendations ClickHouse tests SKIPPED: ${reason}`);
  }
});
