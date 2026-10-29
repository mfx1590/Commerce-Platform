// Recommendations (task P5.8, #607). The pure lift rule on a hand-made basket set, then the rebuild and the read
// path on a seeded throwaway database: idempotent re-run, store isolation (brand A orders never produce a brand B
// recommendation, and the composite keys refuse one even if the job tried), the published / in-stock / currency
// filters at read time, and the popular fallback reported in `kind`.
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initDb } from '../../lib/db';
import { runIndexRecommendations } from '../../jobs/index-recommendations';
import {
  countsFromBaskets,
  DEFAULT_THRESHOLDS,
  FixtureBasketSource,
  liftOf,
  listProductRecommendations,
  loadSearchRecords,
  rebuildStoreRecommendations,
  recommendPairs,
  recommendPopular,
  thresholdsFromEnv,
  type FixtureLine,
  type Thresholds,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const NOW = new Date('2026-10-27T12:00:00Z');
const DAY = 86_400_000;

/** `placed_at` n days before NOW. */
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let productsA: string[];
let productsB: string[];
let currencyA: string;
let storeCodeA: string;

/** One order of the fixture, every line `placed` and `days` old. */
function order(storeId: string, orderId: string, products: string[], days = 1): FixtureLine[] {
  return products.map((product_id) => ({
    store_id: storeId,
    order_id: orderId,
    product_id,
    quantity: 1,
    placed_at: daysAgo(days),
    order_status: 'placed' as const,
  }));
}

async function rows(client: ReturnType<typeof createTenantClient>, storeId: string) {
  const r = await client.query<{
    product_id: string | null;
    related_product_id: string;
    kind: string;
    window_days: number;
    score: string;
  }>(
    `SELECT product_id, related_product_id, kind, window_days, score::text
     FROM product_recommendation WHERE store_id = $1
     ORDER BY kind, window_days, product_id NULLS FIRST, related_product_id`,
    [storeId],
  );
  return r.rows;
}

beforeAll(async () => {
  db = await createTestDatabase('core_recommendations');
  await seed(db.owner, { productsPerStore: 6, log: () => {} });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });

  // Sellable products of each store, taken from the read model the rail itself uses, so the fixtures never
  // depend on which seeded rows happen to have a price or stock.
  const recA = await loadSearchRecords(a, A);
  const recB = await loadSearchRecords(b, B);
  productsA = recA.map((r) => r.objectID);
  productsB = recB.map((r) => r.objectID);
  currencyA = recA[0]?.currencies[0] as string;
  expect(productsA.length).toBeGreaterThanOrEqual(5);
  expect(productsB.length).toBeGreaterThanOrEqual(2);

  // The job resolves its stores through the shared pool, so it needs the same throwaway database.
  await initDb({ connectionString: db.app.options.connectionString as string });
  const codes = await a.query<{ code: string }>(`SELECT code FROM store WHERE id = $1`, [A]);
  storeCodeA = codes.rows[0]?.code as string;
}, 120_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('the lift rule (pure, the worked example from recommendations-types.ts)', () => {
  // N = 10 baskets: tee in 6, cap in 5, 4 together; mug in 2, scarf in 2, 2 together.
  const baskets = [
    ['tee', 'cap'],
    ['tee', 'cap'],
    ['tee', 'cap'],
    ['tee', 'cap'],
    ['tee'],
    ['tee'],
    ['cap'],
    ['mug', 'scarf'],
    ['mug', 'scarf'],
    ['belt'],
  ];
  const counts = countsFromBaskets(baskets);

  it('counts baskets, products and pairs', () => {
    expect(counts.basketCount).toBe(10);
    expect(counts.singles.get('tee')).toBe(6);
    expect(counts.singles.get('cap')).toBe(5);
    expect(counts.pairs.get('cap|tee')).toBe(4);
  });

  it('computes the documented lift', () => {
    // 4 * 10 / (6 * 5) = 1.333…
    expect(liftOf(counts, 'tee', 'cap')).toBeCloseTo(4 / 3, 10);
    // symmetric
    expect(liftOf(counts, 'cap', 'tee')).toBeCloseTo(4 / 3, 10);
    // mug+scarf has the HIGHEST lift in the store: 2 * 10 / (2 * 2) = 5
    expect(liftOf(counts, 'mug', 'scarf')).toBeCloseTo(5, 10);
  });

  it('keeps the supported pair in both directions and drops the unsupported one', () => {
    const out = recommendPairs(counts, DEFAULT_THRESHOLDS);
    expect(out).toEqual([
      { productId: 'cap', relatedProductId: 'tee', score: 1.3333 },
      { productId: 'tee', relatedProductId: 'cap', score: 1.3333 },
    ]);
    // mug/scarf: lift 5.0 but only 2 baskets < minSupportBaskets 3 — thin evidence never becomes a rail.
    expect(out.some((r) => r.productId === 'mug' || r.relatedProductId === 'mug')).toBe(false);
  });

  it('drops a pair below the minimum lift even when it is well supported', () => {
    // tee+cap at lift 1.333 fails a 1.5 floor; nothing else is supported.
    expect(recommendPairs(counts, { ...DEFAULT_THRESHOLDS, minLift: 1.5 })).toEqual([]);
  });

  it('counts a product twice in one basket only once', () => {
    const c = countsFromBaskets([['tee', 'tee', 'cap']]);
    expect(c.basketCount).toBe(1);
    expect(c.singles.get('tee')).toBe(1);
    expect(c.pairs.get('cap|tee')).toBe(1);
  });

  it('orders the popular list by units, then by id', () => {
    const units = new Map([
      ['b', 5],
      ['a', 5],
      ['c', 9],
      ['d', 0],
    ]);
    expect(recommendPopular(units, 3)).toEqual([
      { relatedProductId: 'c', score: 9 },
      { relatedProductId: 'a', score: 5 },
      { relatedProductId: 'b', score: 5 },
    ]);
  });
});

describe('thresholdsFromEnv', () => {
  it('defaults with an empty environment', () => {
    expect(thresholdsFromEnv({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_THRESHOLDS);
  });

  it('refuses a minimum lift at or below 1, which would carry no signal', () => {
    for (const bad of ['1', '1.0', '0.9', '0']) {
      expect(() =>
        thresholdsFromEnv({ CORE_RECOMMENDATIONS_MIN_LIFT: bad } as NodeJS.ProcessEnv),
      ).toThrow(/greater than 1/);
    }
    expect(
      thresholdsFromEnv({ CORE_RECOMMENDATIONS_MIN_LIFT: '1.5' } as NodeJS.ProcessEnv).minLift,
    ).toBe(1.5);
  });

  it('refuses a non-positive or non-integer count', () => {
    expect(() =>
      thresholdsFromEnv({ CORE_RECOMMENDATIONS_MIN_SUPPORT: '0' } as NodeJS.ProcessEnv),
    ).toThrow(/positive integer/);
    expect(() =>
      thresholdsFromEnv({ CORE_RECOMMENDATIONS_MAX_PAIRS: '2.5' } as NodeJS.ProcessEnv),
    ).toThrow(/positive integer/);
  });
});

describe('rebuild (write side)', () => {
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, minSupportBaskets: 2, minLift: 1.0 };

  it('writes both kinds, both windows, and is byte-identical on a re-run', async () => {
    const [p0, p1, p2] = productsA as [string, string, string];
    const lines: FixtureLine[] = [
      ...order(A, 'o1', [p0, p1], 1),
      ...order(A, 'o2', [p0, p1], 2),
      ...order(A, 'o3', [p2], 3),
      // 20 days old: inside the 30-day popular window, outside the 7-day one.
      ...order(A, 'o4', [p2], 20),
    ];
    const source = new FixtureBasketSource(lines, () => NOW);

    const first = await rebuildStoreRecommendations(a, A, source, thresholds, NOW);
    expect(first.pairs).toBe(2); // p0 -> p1 and p1 -> p0
    expect(first.popular[7]).toBe(3); // p0, p1, p2 sold within 7 days
    expect(first.popular[30]).toBe(3);

    const after = await rows(a, A);
    expect(after.filter((r) => r.kind === 'bought_together')).toHaveLength(2);
    expect(after.filter((r) => r.kind === 'popular' && r.window_days === 7)).toHaveLength(3);
    // p2 has 2 units in 30 days but only 1 in 7 — the windows really differ.
    const p2_30 = after.find(
      (r) => r.kind === 'popular' && r.window_days === 30 && r.related_product_id === p2,
    );
    const p2_7 = after.find(
      (r) => r.kind === 'popular' && r.window_days === 7 && r.related_product_id === p2,
    );
    expect(p2_30?.score).toBe('2');
    expect(p2_7?.score).toBe('1');

    const second = await rebuildStoreRecommendations(a, A, source, thresholds, NOW);
    expect(second).toEqual(first);
    expect(await rows(a, A)).toEqual(after);
  });

  it('removes a pair that fell below the support threshold instead of leaving it behind', async () => {
    const [p0, p1] = productsA as [string, string];
    const supported = new FixtureBasketSource(
      [...order(A, 'o1', [p0, p1], 1), ...order(A, 'o2', [p0, p1], 2)],
      () => NOW,
    );
    await rebuildStoreRecommendations(a, A, supported, thresholds, NOW);
    expect((await rows(a, A)).filter((r) => r.kind === 'bought_together')).toHaveLength(2);

    // The same pair, now seen in ONE basket only: below minSupportBaskets 2.
    const thin = new FixtureBasketSource([...order(A, 'o1', [p0, p1], 1)], () => NOW);
    await rebuildStoreRecommendations(a, A, thin, thresholds, NOW);
    expect((await rows(a, A)).filter((r) => r.kind === 'bought_together')).toHaveLength(0);
  });

  it('a brand A rebuild never produces a brand B recommendation', async () => {
    const [a0, a1] = productsA as [string, string];
    const [b0, b1] = productsB as [string, string];
    // One fixture holding BOTH stores' orders, as ClickHouse would.
    const both = new FixtureBasketSource(
      [
        ...order(A, 'oa1', [a0, a1], 1),
        ...order(A, 'oa2', [a0, a1], 2),
        ...order(B, 'ob1', [b0, b1], 1),
        ...order(B, 'ob2', [b0, b1], 2),
      ],
      () => NOW,
    );

    await rebuildStoreRecommendations(a, A, both, thresholds, NOW);
    const written = await rows(a, A);
    const brandBIds = new Set(productsB);
    expect(written.length).toBeGreaterThan(0);
    for (const r of written) {
      expect(brandBIds.has(r.related_product_id)).toBe(false);
      if (r.product_id) expect(brandBIds.has(r.product_id)).toBe(false);
    }

    // And brand B's own rebuild stays inside brand B.
    await rebuildStoreRecommendations(b, B, both, thresholds, NOW);
    const brandAIds = new Set(productsA);
    for (const r of await rows(b, B)) {
      expect(brandAIds.has(r.related_product_id)).toBe(false);
    }
  });

  it('refuses a cross-store row at the database level (migration 0204 composite keys)', async () => {
    const [a0] = productsA as [string];
    const [b0] = productsB as [string];
    await expect(
      db.owner.query(
        `INSERT INTO product_recommendation
           (organization_id, store_id, product_id, related_product_id, kind, window_days, score, computed_at)
         VALUES ($1, $2, $3, $4, 'bought_together', 0, 2.0, now())`,
        [ORG, A, a0, b0],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('skips a product ClickHouse knows but this store does not have', async () => {
    const [a0, a1] = productsA as [string, string];
    const ghost = '30000000-0000-4000-8000-0000000000ff';
    const source = new FixtureBasketSource(
      [
        ...order(A, 'o1', [a0, a1], 1),
        ...order(A, 'o2', [a0, a1], 2),
        ...order(A, 'o3', [a0, ghost], 1),
        ...order(A, 'o4', [a0, ghost], 2),
      ],
      () => NOW,
    );
    const result = await rebuildStoreRecommendations(a, A, source, thresholds, NOW);
    // The a0/ghost pair is computed but cannot be written: the INSERT joins `product`.
    expect(result.pairs).toBe(2);
    for (const r of await rows(a, A)) {
      expect(r.related_product_id).not.toBe(ghost);
      expect(r.product_id).not.toBe(ghost);
    }
  });
});

describe('the job, dry run', () => {
  it('reports the rows a real run would write, not the raw candidate count', async () => {
    const [p0, p1, p2, p3, p4] = productsA as [string, string, string, string, string];
    // Default thresholds (minSupport 3, minLift 1.2) over 12 baskets:
    //   p0+p1  support 2  -> dropped (support), and its lift would be 0.96 anyway
    //   p2+p3  support 4, lift 4*12/(4*4) = 3.0        -> KEPT, 2 rows (both directions)
    //   p2+p4 / p3+p4  support 2                        -> dropped (support)
    // So the raw candidate count is 4 unordered pairs; what a run writes is 2 rows.
    const lines: FixtureLine[] = [
      ...order(A, 'o1', [p0, p1], 1),
      ...order(A, 'o2', [p0, p1], 2),
      ...order(A, 'o3', [p0], 1),
      ...order(A, 'o4', [p0], 1),
      ...order(A, 'o5', [p0], 1),
      ...order(A, 'o6', [p1], 1),
      ...order(A, 'o7', [p1], 1),
      ...order(A, 'o8', [p1], 1),
      ...order(A, 'o9', [p2, p3], 1),
      ...order(A, 'o10', [p2, p3], 1),
      ...order(A, 'o11', [p2, p3, p4], 1),
      ...order(A, 'o12', [p2, p3, p4], 1),
    ];
    const source = new FixtureBasketSource(lines, () => NOW);
    const counts = await source.counts(A, DEFAULT_THRESHOLDS);
    expect(counts.pairs.size).toBe(4); // the raw count the dry run must NOT report

    // Earlier tests in this file share the seeded database, so compare against what is there now.
    const before = await rows(a, A);

    const summary = await runIndexRecommendations({
      organizationId: ORG,
      storeCode: storeCodeA,
      dryRun: true,
      source,
      now: NOW,
    });
    expect(summary.source).toBe('fixture');
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.pairs).toBe(2);
    // And the popular windows are reported too, instead of a hard-coded zero.
    expect(summary.results[0]?.popular[30]).toBe(5);
    expect(summary.results[0]?.popular[7]).toBe(5);

    // A dry run writes nothing: the table is exactly as it was.
    expect(await rows(a, A)).toEqual(before);
  });
});

describe('read path', () => {
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, minSupportBaskets: 2, minLift: 1.0 };
  const ctx = () => ({ client: a, storeId: A, defaultCurrency: currencyA });

  it('serves the pair list for an anchor, and reports kind bought_together', async () => {
    const [p0, p1] = productsA as [string, string];
    const source = new FixtureBasketSource(
      [...order(A, 'o1', [p0, p1], 1), ...order(A, 'o2', [p0, p1], 2)],
      () => NOW,
    );
    await rebuildStoreRecommendations(a, A, source, thresholds, NOW);

    const out = await listProductRecommendations(ctx(), {
      kind: 'bought_together',
      productId: p0,
      windowDays: 30,
      limit: 8,
    });
    expect(out.kind).toBe('bought_together');
    expect(out.items.map((i) => i.id)).toEqual([p1]);
    expect(out.items[0]?.price.currency).toBe(currencyA);
    expect(out.items[0]?.handle).toBeTruthy();
  });

  it('never recommends the anchor back, and merges a cart of anchors', async () => {
    const [p0, p1, p2] = productsA as [string, string, string];
    const source = new FixtureBasketSource(
      [
        ...order(A, 'o1', [p0, p1], 1),
        ...order(A, 'o2', [p0, p1], 2),
        ...order(A, 'o3', [p1, p2], 1),
        ...order(A, 'o4', [p1, p2], 2),
      ],
      () => NOW,
    );
    await rebuildStoreRecommendations(a, A, source, thresholds, NOW);

    const out = await listProductRecommendations(ctx(), {
      kind: 'bought_together',
      variantIds: await variantsOf([p0, p1]),
      windowDays: 30,
      limit: 8,
    });
    expect(out.kind).toBe('bought_together');
    // p0 and p1 are the anchors, so only p2 may come back.
    expect(out.items.map((i) => i.id)).toEqual([p2]);
  });

  it('falls back to popular and says so in kind when the anchor has no pairs', async () => {
    const [p0, p1, p2] = productsA as [string, string, string];
    // p2 is in no pair at all, but the store has a popular list.
    const source = new FixtureBasketSource(
      [...order(A, 'o1', [p0, p1], 1), ...order(A, 'o2', [p0, p1], 2), ...order(A, 'o3', [p2], 1)],
      () => NOW,
    );
    await rebuildStoreRecommendations(a, A, source, thresholds, NOW);

    const out = await listProductRecommendations(ctx(), {
      kind: 'bought_together',
      productId: p2,
      windowDays: 30,
      limit: 8,
    });
    expect(out.kind).toBe('popular');
    expect(out.items.length).toBeGreaterThan(0);
    // The anchor is excluded from its own fallback list.
    expect(out.items.map((i) => i.id)).not.toContain(p2);
  });

  it('serves the asked popular window store-wide', async () => {
    const [p0, p1] = productsA as [string, string];
    const source = new FixtureBasketSource(
      [...order(A, 'o1', [p0], 1), ...order(A, 'o2', [p1], 20)],
      () => NOW,
    );
    await rebuildStoreRecommendations(a, A, source, thresholds, NOW);

    const seven = await listProductRecommendations(ctx(), {
      kind: 'popular',
      windowDays: 7,
      limit: 8,
    });
    expect(seven.kind).toBe('popular');
    expect(seven.items.map((i) => i.id)).toEqual([p0]);

    const thirty = await listProductRecommendations(ctx(), {
      kind: 'popular',
      windowDays: 30,
      limit: 8,
    });
    expect(thirty.items.map((i) => i.id).sort()).toEqual([p0, p1].sort());
  });

  it('honours limit', async () => {
    const [p0, p1, p2, p3] = productsA as [string, string, string, string];
    const source = new FixtureBasketSource(
      [...order(A, 'o1', [p0, p1, p2, p3], 1), ...order(A, 'o2', [p0, p1, p2, p3], 2)],
      () => NOW,
    );
    await rebuildStoreRecommendations(a, A, source, thresholds, NOW);
    const out = await listProductRecommendations(ctx(), {
      kind: 'bought_together',
      productId: p0,
      windowDays: 30,
      limit: 2,
    });
    expect(out.items).toHaveLength(2);
  });

  it('drops a recommendation whose product is no longer published', async () => {
    const [p0, p1] = productsA as [string, string];
    const source = new FixtureBasketSource(
      [...order(A, 'o1', [p0, p1], 1), ...order(A, 'o2', [p0, p1], 2)],
      () => NOW,
    );
    await rebuildStoreRecommendations(a, A, source, thresholds, NOW);
    await db.owner.query(`UPDATE product SET status = 'draft' WHERE id = $1`, [p1]);
    try {
      const out = await listProductRecommendations(ctx(), {
        kind: 'bought_together',
        productId: p0,
        windowDays: 30,
        limit: 8,
      });
      // The only pair is unpublished: the rail falls back rather than showing it.
      expect(out.items.map((i) => i.id)).not.toContain(p1);
    } finally {
      await db.owner.query(`UPDATE product SET status = 'published' WHERE id = $1`, [p1]);
    }
  });

  it('drops a recommendation that is out of stock', async () => {
    const [p0, p1] = productsA as [string, string];
    const source = new FixtureBasketSource(
      [...order(A, 'o1', [p0, p1], 1), ...order(A, 'o2', [p0, p1], 2)],
      () => NOW,
    );
    await rebuildStoreRecommendations(a, A, source, thresholds, NOW);
    await db.owner.query(
      `UPDATE product_variant SET manage_inventory = true, allow_backorder = false WHERE product_id = $1`,
      [p1],
    );
    // `available` is GENERATED ALWAYS AS (on_hand - reserved) (migration 0007), so the quantity is what moves.
    await db.owner.query(
      `UPDATE inventory_level SET on_hand = 0, reserved = 0
       WHERE stock_item_id IN (SELECT stock_item_id FROM product_variant WHERE product_id = $1)`,
      [p1],
    );
    const out = await listProductRecommendations(ctx(), {
      kind: 'bought_together',
      productId: p0,
      windowDays: 30,
      limit: 8,
    });
    expect(out.items.map((i) => i.id)).not.toContain(p1);
  });

  it('404s for an anchor that is not a published product of this store', async () => {
    const [b0] = productsB as [string];
    await expect(
      listProductRecommendations(ctx(), {
        kind: 'bought_together',
        productId: b0,
        windowDays: 30,
        limit: 8,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('400s for a currency the store does not have', async () => {
    const [p0] = productsA as [string];
    await expect(
      listProductRecommendations(ctx(), {
        kind: 'bought_together',
        productId: p0,
        windowDays: 30,
        limit: 8,
        currency: 'JPY',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

/** Variant ids of the given products (the cart sends these). */
async function variantsOf(productIds: string[]): Promise<string[]> {
  const r = await a.query<{ id: string }>(
    `SELECT id FROM product_variant WHERE product_id = ANY($1::uuid[]) ORDER BY id`,
    [productIds],
  );
  return r.rows.map((x) => x.id);
}
