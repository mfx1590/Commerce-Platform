// The ClickHouse read side (task P5.8, #607). Two halves:
//
//  * the client and the fixture source, over a stubbed fetch — always run. They cover what the aggregation
//    CONTRACT is (bound parameters, never interpolated SQL), that credentials never reach an error message, the
//    retry, and that the fixture source applies the same two filters and the same windowing as the SQL.
//  * three ClickHouse-backed tests, SKIPPED with a printed reason unless `CORE_RECOMMENDATIONS_CLICKHOUSE_TESTS=1`
//    and the CLICKHOUSE_* rows point at a ClickHouse with #601's models (#628, merged 2026-10-27). They ran green
//    on the shared stack on 2026-10-27: the frozen column set, the aggregates agreeing with an independent count,
//    and the documented lift computed by ClickHouse itself over a literal basket set (the dev data cannot exercise
//    the self-join — every `fct_order_line.product_id` is NULL there; see the module CHANGELOG).
import { SEED_IDS } from '@platform/db';
import { describe, expect, it } from 'vitest';
import {
  ClickHouseBasketSource,
  ClickHouseClient,
  clickhouseCredentialsFrom,
  ClickHouseError,
  DEFAULT_THRESHOLDS,
  FixtureBasketSource,
  liftOf,
  pairKey,
  recommendPairs,
  recommendPopular,
  type FixtureLine,
} from './index';

const CREDS = {
  url: 'http://clickhouse.invalid:18123',
  database: 'analytics',
  user: 'analytics_ro',
  // A word, not a secret-shaped literal: gitleaks scans every branch's history.
  password: 'readonly-word-alpha',
};

// The stub tests only need *a* uuid; the live tests need the REAL seeded store, so both use it. The invented id
// this file had before matched no row in ClickHouse, so the live test queried an empty store and passed while
// proving nothing (found on the first live run, 2026-10-27).
const BRAND_A = SEED_IDS.stores.brandA;
const STORE = BRAND_A;
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

/**
 * Every name a statement binds. ClickHouse resolves aliases everywhere in a query, so an output alias that
 * repeats a CTE name, a table alias or a source column silently changes what the statement means (Memory-main
 * global gotcha: three bugs in Phase 5, one of them a data-loss path). None of this SQL has ever executed, so
 * the guard is static.
 */
function namesOf(sql: string): { scope: Set<string>; outputs: Set<string> } {
  const scope = new Set<string>();
  for (const m of sql.matchAll(/\bWITH\s+(\w+)\s+AS\s*\(/g)) scope.add(m[1] as string);
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+[\w.]+\s+AS\s+(\w+)/g)) scope.add(m[1] as string);
  const outputs = new Set<string>();
  for (const m of sql.matchAll(/\bAS\s+(\w+)/g)) {
    const before = sql.slice(0, m.index).trimEnd();
    // Skip the two alias-DECLARING forms; what is left is a SELECT output alias.
    if (/\b(?:WITH|FROM|JOIN)\s+[\w.]+$/.test(before) || /\bWITH$/.test(before)) continue;
    outputs.add(m[1] as string);
  }
  return { scope, outputs };
}

/** The `fct_order_line` columns this job reads (#601's binding interface). */
const SOURCE_COLUMNS = [
  'organization_id',
  'store_id',
  'order_id',
  'order_line_item_id',
  'variant_id',
  'product_id',
  'sku',
  'quantity',
  'unit_price_minor',
  'discount_minor',
  'tax_minor',
  'total_minor',
  'currency',
  'placed_at',
  'order_status',
  'source_event_id',
];

/** Asserts a statement aliases nothing to a name it already uses for something else. */
function expectNoAliasShadowing(sql: string): void {
  const { scope, outputs } = namesOf(sql);
  for (const out of outputs) {
    expect(
      scope,
      `output alias "${out}" collides with a CTE or table alias in: ${sql}`,
    ).not.toContain(out);
    expect(
      SOURCE_COLUMNS,
      `output alias "${out}" repeats a fct_order_line column in: ${sql}`,
    ).not.toContain(out);
  }
}

describe('ClickHouseClient', () => {
  it('binds parameters through param_* and never interpolates them into the SQL', async () => {
    const { impl, calls } = stubFetch([jsonl([{ n: '1' }])]);
    const client = new ClickHouseClient({ ...CREDS, fetchImpl: impl });
    await client.query('SELECT {storeId:UUID} AS n', { storeId: STORE, lookbackDays: 90 });

    const call = calls[0] as { url: string; sql: string };
    expect(call.url).toContain(`param_storeId=${STORE}`);
    expect(call.url).toContain('param_lookbackDays=90');
    expect(call.url).toContain('database=analytics');
    // The store id is a parameter, not part of the statement.
    expect(call.sql).toContain('SELECT {storeId:UUID} AS n');
    expect(call.sql).not.toContain(STORE);
  });

  it('sends no per-query setting, because analytics_ro is readonly = 1', async () => {
    const { impl, calls } = stubFetch([jsonl([{ n: '1' }])]);
    const client = new ClickHouseClient({ ...CREDS, fetchImpl: impl });
    await client.query('SELECT 1 AS n');

    const call = calls[0] as { url: string; sql: string };
    // `default_format` is a SETTING: a readonly user answers "Cannot modify … in readonly mode". The format
    // belongs in the statement instead. Only `database` and the param_* bindings may be in the URL.
    expect(call.url).not.toContain('default_format');
    expect(call.sql.trimEnd().endsWith('FORMAT JSONEachRow')).toBe(true);
    const settings = [...new URL(call.url).searchParams.keys()].filter(
      (k) => k !== 'database' && !k.startsWith('param_'),
    );
    expect(settings).toEqual([]);
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
      jsonl([{ total_baskets: '10' }]),
      jsonl([
        { product_id: 'p1', product_baskets: '6' },
        { product_id: 'p2', product_baskets: '5' },
      ]),
      jsonl([{ pa: 'p1', pb: 'p2', pair_baskets: '4' }]),
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
    expect(calls[2]?.sql).toContain('HAVING pair_baskets >= {minSupport:UInt32}');
  });

  it('aliases nothing to a name the same statement already uses (ClickHouse alias shadowing)', async () => {
    const { impl, calls } = stubFetch([
      jsonl([{ total_baskets: '10' }]),
      jsonl([{ product_id: 'p1', product_baskets: '6' }]),
      jsonl([{ pa: 'p1', pb: 'p2', pair_baskets: '4' }]),
    ]);
    const source = new ClickHouseBasketSource(new ClickHouseClient({ ...CREDS, fetchImpl: impl }));
    await source.counts(STORE, DEFAULT_THRESHOLDS);
    await source.units(STORE, 7);

    expect(calls.length).toBe(4);
    for (const c of calls) expectNoAliasShadowing(c.sql);
  });

  it('the shadowing guard itself catches the shapes that bit Phase 5', () => {
    // The exact bug this file shipped with: the output aliases repeated the table aliases, and `baskets`
    // repeated the CTE name.
    expect(() =>
      expectNoAliasShadowing(
        `WITH baskets AS (SELECT order_id, product_id FROM fct_order_line)
         SELECT a.product_id AS a, b.product_id AS b, count() AS baskets
         FROM baskets AS a INNER JOIN baskets AS b ON a.order_id = b.order_id
         GROUP BY a, b`,
      ),
    ).toThrow();
    // The gotcha's other shape: a computed value aliased to a source column's name.
    expect(() =>
      expectNoAliasShadowing(`SELECT toString(product_id) AS product_id FROM fct_order_line`),
    ).toThrow();
    // And it passes the real thing.
    expect(() =>
      expectNoAliasShadowing(
        `WITH basket_lines AS (SELECT order_id, product_id FROM fct_order_line)
         SELECT left_line.product_id AS pa, count() AS pair_baskets
         FROM basket_lines AS left_line GROUP BY pa`,
      ),
    ).not.toThrow();
  });

  it('asks for no pair work at all when the store has no baskets', async () => {
    const { impl, calls } = stubFetch([jsonl([{ total_baskets: '0' }])]);
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
    return 'CORE_RECOMMENDATIONS_CLICKHOUSE_TESTS is not 1 — these need a reachable ClickHouse with #601 models applied (#628, merged 2026-10-27); set it to 1 with the CLICKHOUSE_* rows to run them';
  }
  if (!clickhouseCredentialsFrom()) {
    return 'CLICKHOUSE_URL / CLICKHOUSE_READONLY_USER / CLICKHOUSE_READONLY_PASSWORD are not set';
  }
  return null;
};

describe('against a real ClickHouse (#601 interface)', () => {
  const reason = liveReason();

  it.skipIf(reason !== null)('the fct_order_line interface is still what #601 froze', async () => {
    const creds = clickhouseCredentialsFrom();
    if (!creds) throw new Error('unreachable: the skip guard checked this');
    const client = new ClickHouseClient(creds);
    const cols = await client.query<{ name: string }>(
      `SELECT name FROM system.columns WHERE database = {db:String} AND table = 'fct_order_line'`,
      { db: creds.database },
    );
    // Additive changes are allowed after #601 merged; a column this job reads disappearing is not.
    expect(cols.length).toBeGreaterThan(0);
    for (const needed of SOURCE_COLUMNS) {
      expect(cols.map((c) => c.name)).toContain(needed);
    }
  });

  it.skipIf(reason !== null)(
    'the aggregates execute and their counts are self-consistent',
    async () => {
      const creds = clickhouseCredentialsFrom();
      if (!creds) throw new Error('unreachable: the skip guard checked this');
      const client = new ClickHouseClient(creds);
      const source = new ClickHouseBasketSource(client);

      // What the two documented filters leave behind, independently of the source's own SQL.
      const usable = await client.query<{ lines: string; baskets: string }>(
        `SELECT count() AS lines, uniqExact(order_id) AS baskets
       FROM fct_order_line
       WHERE store_id = {storeId:UUID}
         AND product_id IS NOT NULL
         AND order_status != 'cancelled'
         AND placed_at >= now() - INTERVAL {lookbackDays:UInt16} DAY`,
        { storeId: BRAND_A, lookbackDays: DEFAULT_THRESHOLDS.lookbackDays },
      );
      const usableLines = Number(usable[0]?.lines ?? 0);
      const usableBaskets = Number(usable[0]?.baskets ?? 0);

      const counts = await source.counts(BRAND_A, DEFAULT_THRESHOLDS);
      const units = await source.units(BRAND_A, 7);

      // The source must agree with that independent count — this is what alias shadowing would break.
      expect(counts.basketCount).toBe(usableBaskets);
      // Invariants that hold at any volume: a product cannot appear in more baskets than exist, and a pair
      // cannot appear in more baskets than either of its products.
      for (const [product, n] of counts.singles) {
        expect(n, `single count for ${product}`).toBeLessThanOrEqual(counts.basketCount);
        expect(n).toBeGreaterThan(0);
      }
      for (const [key, n] of counts.pairs) {
        const [a, b] = key.split('|') as [string, string];
        const min = Math.min(counts.singles.get(a) ?? 0, counts.singles.get(b) ?? 0);
        expect(n, `pair count for ${key} exceeds its products' basket counts`).toBeLessThanOrEqual(
          min,
        );
      }
      for (const [product, u] of units) expect(u, `units for ${product}`).toBeGreaterThan(0);

      // Loud, because green here must never be mistaken for "recommendations work on this data".
      console.info(
        `[search] LIVE ClickHouse: store ${BRAND_A} — ${usableLines} usable line(s), ${counts.basketCount} basket(s), ` +
          `${counts.singles.size} product(s), ${counts.pairs.size} pair(s) above support, ${units.size} product(s) with 7d units`,
      );
      if (usableLines === 0) {
        console.info(
          '[search] LIVE ClickHouse: ZERO usable lines — every fct_order_line row has product_id NULL because ' +
            'dim_variant only knows variants that arrived via product.published/updated, and the dev orders were ' +
            'placed against SEEDED catalog variants that never went through the bus. The SQL is exercised, but no ' +
            'recommendation can be computed from this data (see the report on #607).',
        );
      } else {
        // With real data the pipeline must actually produce something.
        expect(counts.basketCount).toBeGreaterThan(0);
        expect(counts.singles.size).toBeGreaterThan(0);
      }
    },
  );

  // The dev data cannot exercise the self-join (every product_id is NULL), and a shadowed alias returns WRONG
  // results rather than an error — so "it ran" is not proof. This runs the SAME statements, on the same real
  // ClickHouse, over a literal row set whose lift is known by hand, and writes nothing (analytics_ro could not).
  it.skipIf(reason !== null)('computes the documented lift on the real engine', async () => {
    const creds = clickhouseCredentialsFrom();
    if (!creds) throw new Error('unreachable: the skip guard checked this');

    // The worked example: N = 10 baskets, tee in 6, cap in 5, 4 together; mug in 2, scarf in 2, 2 together.
    const id = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
    const [tee, cap, mug, scarf, belt] = [id(1), id(2), id(3), id(4), id(5)];
    const baskets: string[][] = [
      [tee, cap],
      [tee, cap],
      [tee, cap],
      [tee, cap],
      [tee],
      [tee],
      [cap],
      [mug, scarf],
      [mug, scarf],
      [belt],
    ];
    const rows = baskets.flatMap((products, i) =>
      products.map(
        (product) =>
          `SELECT toUUID('${BRAND_A}') AS store_id, toUUID('${id(50 + i)}') AS order_id, ` +
          `toNullable(toUUID('${product}')) AS product_id, 'placed' AS order_status, ` +
          `now() AS placed_at, toUInt32(1) AS quantity`,
      ),
    );
    const literal = `(${rows.join(' UNION ALL ')})`;

    const source = new ClickHouseBasketSource(new ClickHouseClient(creds), literal);
    const counts = await source.counts(BRAND_A, DEFAULT_THRESHOLDS);

    // Exactly the numbers the pure test asserts — now from ClickHouse's own self-join and GROUP BY.
    expect(counts.basketCount).toBe(10);
    expect(counts.singles.get(tee)).toBe(6);
    expect(counts.singles.get(cap)).toBe(5);
    expect(counts.singles.get(belt)).toBe(1);
    // Only tee+cap clears the default support floor of 3; mug+scarf (2 baskets) is filtered by the HAVING.
    expect([...counts.pairs.entries()]).toEqual([[pairKey(tee, cap), 4]]);
    expect(liftOf(counts, tee, cap)).toBeCloseTo(4 / 3, 10);

    // And the pure rule over these real counts yields the documented recommendation, both directions.
    // (Anchors come out sorted by product id, which for these uuids puts `tee` first.)
    expect(recommendPairs(counts, DEFAULT_THRESHOLDS)).toEqual([
      { productId: tee, relatedProductId: cap, score: 1.3333 },
      { productId: cap, relatedProductId: tee, score: 1.3333 },
    ]);

    // The popular path over the same rows: tee 6 units, cap 5, mug 2, scarf 2, belt 1.
    const units = await source.units(BRAND_A, 7);
    expect(units.get(tee)).toBe(6);
    expect(units.get(cap)).toBe(5);
    expect(recommendPopular(units, 2)).toEqual([
      { relatedProductId: tee, score: 6 },
      { relatedProductId: cap, score: 5 },
    ]);
  });

  if (reason !== null) {
    // Printed so a green local run never looks like proof that this seam works.
    console.info(`[search] recommendations ClickHouse tests SKIPPED: ${reason}`);
  }
});
