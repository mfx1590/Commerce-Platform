import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganizationClient,
  createTenantClient,
  seed,
  SEED_IDS,
  topUpStock,
} from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

let db: TestDatabase;
const ORG = SEED_IDS.organization;

beforeAll(async () => {
  db = await createTestDatabase('platform_seed');
  await seed(db.owner, { productsPerStore: 25, log: () => {} });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe('seed data', () => {
  it('is idempotent (second run adds nothing)', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const before = (await hq.query<{ n: string }>('SELECT count(*) n FROM product')).rows[0]!.n;
    await seed(db.owner, { productsPerStore: 25, log: () => {} });
    const after = (await hq.query<{ n: string }>('SELECT count(*) n FROM product')).rows[0]!.n;
    expect(after).toBe(before);
  });

  it('creates 4 stores with the fixed ids, 2 warehouses, 4 legal entities, one user per role', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const stores = await hq.query<{ id: string; code: string; default_currency: string }>(
      'SELECT id, code, default_currency FROM store ORDER BY code',
    );
    expect(stores.rows).toEqual([
      { id: SEED_IDS.stores.brandA, code: 'brand-a', default_currency: 'EUR' },
      { id: SEED_IDS.stores.brandB, code: 'brand-b', default_currency: 'GBP' },
      { id: SEED_IDS.stores.brandC, code: 'brand-c', default_currency: 'USD' },
      { id: SEED_IDS.stores.brandD, code: 'brand-d', default_currency: 'JPY' },
    ]);
    expect((await hq.query('SELECT id FROM warehouse')).rowCount).toBe(2);
    expect((await hq.query('SELECT id FROM legal_entity')).rowCount).toBe(4);
    const roles = await hq.query<{ relation: string }>(
      'SELECT DISTINCT relation FROM role_assignment ORDER BY relation',
    );
    expect(roles.rows.map((r) => r.relation)).toEqual([
      'analyst',
      'finance',
      'operations',
      'owner',
      'store_admin',
      'store_staff',
      'support',
    ]);
    expect((await hq.query('SELECT id FROM staff_user')).rowCount).toBe(9); // 7 people + 2 service accounts (#565, #622)
  });

  it('topUpStock raises every low level to the floor, writes the ledger, leaves reservations and is idempotent', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    // a variant that test journeys drained: everything on hand is reserved by placed orders
    const drained = (
      await db.owner.query<{ id: string }>(
        `UPDATE inventory_level SET on_hand = 7, reserved = 7
         WHERE id = (SELECT id FROM inventory_level ORDER BY id LIMIT 1) RETURNING id`,
      )
    ).rows[0]!.id;
    const low = Number(
      (await hq.query<{ n: string }>('SELECT count(*) n FROM inventory_level WHERE available < 25'))
        .rows[0]!.n,
    );
    expect(low).toBeGreaterThan(0);

    const first = await topUpStock(db.owner, { log: () => {} });
    expect(first.levels).toBe(low);
    const after = await hq.query<{ min: number; on_hand: number; reserved: number }>(
      `SELECT (SELECT min(available) FROM inventory_level) AS min, on_hand, reserved
       FROM inventory_level WHERE id = $1`,
      [drained],
    );
    expect(after.rows[0]).toEqual({ min: 25, on_hand: 32, reserved: 7 });
    const ledger = await hq.query<{ n: string; units: string }>(
      `SELECT count(*) n, sum(delta) units FROM stock_movement WHERE note LIKE 'seed top-up%'`,
    );
    expect(Number(ledger.rows[0]!.n)).toBe(first.levels);
    expect(Number(ledger.rows[0]!.units)).toBe(first.units);

    expect(await topUpStock(db.owner, { log: () => {} })).toEqual({ levels: 0, units: 0 });
    await expect(topUpStock(db.owner, { floor: 0, log: () => {} })).rejects.toThrow(/floor/);
  });

  it('seeds the requested number of published products per store, each with variants, prices and stock in both warehouses', async () => {
    for (const storeId of Object.values(SEED_IDS.stores)) {
      const t = createTenantClient(db.app, { organizationId: ORG, storeIds: [storeId] });
      const r = await t.query<{
        products: string;
        published: string;
        variants: string;
        priced: string;
        levels: string;
      }>(`
        SELECT (SELECT count(*) FROM product) products,
               (SELECT count(*) FROM product WHERE status = 'published') published,
               (SELECT count(*) FROM product_variant) variants,
               (SELECT count(DISTINCT variant_id) FROM price) priced,
               (SELECT count(*) FROM inventory_level) levels`);
      const row = r.rows[0]!;
      expect(Number(row.products)).toBe(25);
      expect(Number(row.published)).toBe(25);
      expect(Number(row.variants)).toBeGreaterThan(25);
      expect(row.priced).toBe(row.variants);
      expect(Number(row.levels)).toBe(Number(row.variants) * 2);
    }
  });

  it('store A sees only its own catalog; HQ sees all four', async () => {
    const a = createTenantClient(db.app, {
      organizationId: ORG,
      storeIds: [SEED_IDS.stores.brandA],
    });
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    expect((await a.query('SELECT id FROM product')).rowCount).toBe(25);
    expect((await hq.query('SELECT id FROM product')).rowCount).toBe(100);
    expect((await a.query('SELECT id FROM price_list')).rowCount).toBe(1);
  });

  it('the publishable key resolves the store and sales channel by hash', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const hash = createHash('sha256').update(SEED_IDS.publishableKeys.brandB).digest('hex');
    const r = await hq.query<{ store_id: string; type: string; code: string }>(
      `SELECT k.store_id, k.type, c.code FROM store_api_key k JOIN sales_channel c ON c.id = k.sales_channel_id WHERE k.key_hash = $1`,
      [hash],
    );
    expect(r.rows[0]).toEqual({
      store_id: SEED_IDS.stores.brandB,
      type: 'publishable',
      code: 'web',
    });
  });

  it('every seeded row carries the organization and every store row its store', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const r = await hq.query<{ bad: string }>(`
      SELECT (SELECT count(*) FROM product WHERE store_id NOT IN (SELECT id FROM store)) +
             (SELECT count(*) FROM inventory_level il
               WHERE NOT EXISTS (SELECT 1 FROM product_variant v WHERE v.stock_item_id = il.stock_item_id)) AS bad`);
    expect(Number(r.rows[0]!.bad)).toBe(0);
  });

  it('the shared stock item: brand A and brand B each map it with one variant, and it is ONE pool row per warehouse, stocked in wh-eu', async () => {
    const { stockItem, variantBrandA, variantBrandB } = SEED_IDS.sharedStock;
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const mapped = await hq.query<{ id: string; store_id: string }>(
      'SELECT id, store_id FROM product_variant WHERE stock_item_id = $1 ORDER BY id',
      [stockItem],
    );
    expect(mapped.rows).toEqual([
      { id: variantBrandA, store_id: SEED_IDS.stores.brandA },
      { id: variantBrandB, store_id: SEED_IDS.stores.brandB },
    ]);
    // every other variant has an item of its own: items = variants − 1
    const counts = await hq.query<{ variants: string; items: string }>(
      'SELECT (SELECT count(*) FROM product_variant) variants, (SELECT count(*) FROM stock_item) items',
    );
    expect(Number(counts.rows[0]!.items)).toBe(Number(counts.rows[0]!.variants) - 1);
    const levels = await hq.query<{ warehouse_id: string; available: number }>(
      'SELECT warehouse_id, available FROM inventory_level WHERE stock_item_id = $1 ORDER BY warehouse_id',
      [stockItem],
    );
    expect(levels.rows.map((r) => r.warehouse_id)).toEqual(
      [SEED_IDS.warehouses.eu, SEED_IDS.warehouses.us].sort(),
    );
    expect(
      levels.rows.find((r) => r.warehouse_id === SEED_IDS.warehouses.eu)?.available,
    ).toBeGreaterThan(0); // seeded at 40 or more; the top-up test above rewrites levels
    // both brands read the same pool row; brand C, which does not map the item, reads none of it
    const sees = async (storeId: string): Promise<number> => {
      const t = createTenantClient(db.app, { organizationId: ORG, storeIds: [storeId] });
      const r = await t.query('SELECT id FROM inventory_level WHERE stock_item_id = $1', [
        stockItem,
      ]);
      return r.rows.length;
    };
    expect(await sees(SEED_IDS.stores.brandA)).toBe(2);
    expect(await sees(SEED_IDS.stores.brandB)).toBe(2);
    expect(await sees(SEED_IDS.stores.brandC)).toBe(0);
  });
});

// #832: brand D (Japan) is seeded so CI's live job hosts its journeys. JPY is a ZERO-decimal currency: the minor unit
// is the yen, so every amount is whole yen and nothing may be divided or multiplied by 100 on the way.
describe('brand D (#832): JPY, whole yen, and A–C untouched', () => {
  const D = SEED_IDS.stores.brandD;
  const ABC = [SEED_IDS.stores.brandA, SEED_IDS.stores.brandB, SEED_IDS.stores.brandC];

  it('brand D: JPY / ja-JP / JP / Asia/Tokyo, JCT 10%, invoice allowed, its key resolves', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const store = await hq.query(
      `SELECT s.code, s.default_currency, s.default_locale, s.default_country, s.timezone, s.status,
              s.settings->'payment'->>'invoice_allowed' AS invoice, le.name AS entity, le.country AS entity_country
       FROM store s JOIN legal_entity le ON le.id = s.legal_entity_id WHERE s.id = $1`,
      [D],
    );
    expect(store.rows[0]).toEqual({
      code: 'brand-d',
      default_currency: 'JPY',
      default_locale: 'ja-JP',
      default_country: 'JP',
      timezone: 'Asia/Tokyo',
      status: 'active',
      invoice: 'true',
      entity: 'Brand D K.K.',
      entity_country: 'JP',
    });
    const tax = await hq.query(`SELECT country, rate_bp FROM tax_rate WHERE store_id = $1`, [D]);
    expect(tax.rows).toEqual([{ country: 'JP', rate_bp: 1000 }]);
    const key = await hq.query<{ store_id: string }>(
      `SELECT store_id FROM store_api_key WHERE key_hash = $1`,
      [createHash('sha256').update(SEED_IDS.publishableKeys.brandD).digest('hex')],
    );
    expect(key.rows).toEqual([{ store_id: D }]);
  });

  it('every brand D amount is an integer number of yen: prices (¥1,980 among them) and shipping (¥990 / ¥1,980)', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const prices = await hq.query<{ currency: string; amount: string; compare: string | null }>(
      `SELECT currency, amount_minor::text AS amount, compare_at_minor::text AS compare FROM price WHERE store_id = $1`,
      [D],
    );
    expect(prices.rows.length).toBeGreaterThan(0);
    for (const p of prices.rows) {
      expect(p.currency).toBe('JPY');
      expect(p.amount).toMatch(/^[1-9][0-9]*$/); // bigint minor units = whole yen
      if (p.compare !== null) expect(p.compare).toMatch(/^[1-9][0-9]*$/);
    }
    expect(prices.rows.map((p) => p.amount)).toContain('1980');
    const shipping = await hq.query(
      `SELECT code, price_minor::text AS price, currency, countries FROM shipping_option WHERE store_id = $1 ORDER BY code`,
      [D],
    );
    expect(shipping.rows).toEqual([
      { code: 'express', price: '1980', currency: 'JPY', countries: ['JP'] },
      { code: 'standard', price: '990', currency: 'JPY', countries: ['JP'] },
    ]);
  });

  it('brand D can host its journeys: ≥3 published products in ≥2 categories, with stock and images', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const r = await hq.query<{
      products: string;
      categories: string;
      stocked: string;
      thumbs: string;
    }>(
      `SELECT count(*)::text AS products, count(DISTINCT p.category_id)::text AS categories,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM product_variant v JOIN inventory_level il ON il.stock_item_id = v.stock_item_id
                WHERE v.product_id = p.id AND il.on_hand > 0))::text AS stocked,
              count(p.thumbnail_url)::text AS thumbs
       FROM product p WHERE p.store_id = $1 AND p.status = 'published'`,
      [D],
    );
    const c = r.rows[0]!;
    expect(Number(c.products)).toBeGreaterThanOrEqual(3);
    expect(Number(c.categories)).toBeGreaterThanOrEqual(2);
    expect(Number(c.stocked)).toBeGreaterThanOrEqual(3);
    expect(c.thumbs).toBe(c.products);
  });

  it('no brand A–C amount changed: their price and shipping rows digest exactly as under the seed before #832', async () => {
    // Digests computed by origin/main's seed (0fc7476c, productsPerStore 25) on a throwaway database. Each store's
    // generator has its own RNG (mulberry32(1000 + index)), so adding brand D cannot shift A–C's rows.
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const r = await hq.query<{ prices: string; shipping: string; n: string }>(
      `SELECT (SELECT md5(string_agg(id::text||':'||store_id||':'||currency||':'||amount_minor||':'||coalesce(compare_at_minor::text,'-'), ',' ORDER BY id))
                 FROM price WHERE store_id = ANY($1)) AS prices,
              (SELECT md5(string_agg(id::text||':'||store_id||':'||currency||':'||price_minor||':'||array_to_string(countries, '|'), ',' ORDER BY id))
                 FROM shipping_option WHERE store_id = ANY($1)) AS shipping,
              (SELECT count(*)::text FROM price WHERE store_id = ANY($1)) AS n`,
      [ABC],
    );
    expect(r.rows[0]).toEqual({
      prices: '7a70bb7a2e84b7cf3d89a4937e9a7ffb',
      shipping: '2a2aeb0da04a224f88cf924e3de8d788',
      n: '349',
    });
  });
});

describe("a store whose code exists under another id (#832: the wizard's brand-d on a shared database)", () => {
  let twin: TestDatabase;
  const FOREIGN_STORE = '9f3c3c2a-0000-4000-8000-0000000000aa';
  const FOREIGN_ENTITY = '9f3c3c2a-0000-4000-8000-0000000000bb';

  afterAll(async () => {
    await twin?.drop();
  });

  it('seed() skips ALL of brand D, says so once, leaves the existing store untouched and seeds A–C', async () => {
    twin = await createTestDatabase('platform_seed_twin');
    const owner = createOrganizationClient(twin.owner, { organizationId: ORG });
    await owner.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO organization (id, slug, name, default_currency) VALUES ($1, 'hq', 'HQ', 'EUR')`,
        [ORG],
      );
      await tx.query(
        `INSERT INTO legal_entity (id, organization_id, code, name, country, currency)
         VALUES ($1, $2, 'brand-d-kk', 'Brand D K.K. (wizard)', 'JP', 'JPY')`,
        [FOREIGN_ENTITY, ORG],
      );
      await tx.query(
        `INSERT INTO store (id, organization_id, legal_entity_id, code, name, status, default_currency, default_locale,
                            default_country, timezone)
         VALUES ($1, $2, $3, 'brand-d', 'Brand D (wizard)', 'active', 'JPY', 'ja-JP', 'JP', 'Asia/Tokyo')`,
        [FOREIGN_STORE, ORG, FOREIGN_ENTITY],
      );
    });
    const before = await owner.query(`SELECT * FROM store WHERE id = $1`, [FOREIGN_STORE]);
    const lines: string[] = [];

    await seed(twin.owner, { productsPerStore: 5, log: (m) => lines.push(m) }); // must not throw

    expect(lines.filter((l) => l.includes('brand-d'))).toEqual([
      `skipped brand-d: a store with this code already exists under another id (${FOREIGN_STORE}); left untouched`,
    ]);
    expect((await owner.query(`SELECT * FROM store WHERE id = $1`, [FOREIGN_STORE])).rows).toEqual(
      before.rows,
    );
    const stores = await owner.query<{ id: string }>(`SELECT id FROM store ORDER BY code`);
    expect(stores.rows.map((r) => r.id)).toEqual([
      SEED_IDS.stores.brandA,
      SEED_IDS.stores.brandB,
      SEED_IDS.stores.brandC,
      FOREIGN_STORE,
    ]);
    // none of D's seeded rows: entity, key, domain, tax, shipping, catalogue, stock
    for (const [sql, args] of [
      [`SELECT 1 FROM legal_entity WHERE id = $1`, [SEED_IDS.legalEntities.brandD]],
      [
        `SELECT 1 FROM store_api_key WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [
        `SELECT 1 FROM store_domain WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [
        `SELECT 1 FROM tax_rate WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [
        `SELECT 1 FROM shipping_option WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [`SELECT 1 FROM product WHERE store_id IN ($1, $2)`, [SEED_IDS.stores.brandD, FOREIGN_STORE]],
      [
        `SELECT 1 FROM store_locale WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [
        `SELECT 1 FROM store_currency WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [
        `SELECT 1 FROM sales_channel WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [
        `SELECT 1 FROM price_list WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [
        `SELECT 1 FROM promotion WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
      [
        `SELECT 1 FROM product_category WHERE store_id IN ($1, $2)`,
        [SEED_IDS.stores.brandD, FOREIGN_STORE],
      ],
    ] as const) {
      expect((await owner.query(sql, [...args])).rowCount, sql).toBe(0);
    }
    expect(
      (await owner.query(`SELECT 1 FROM product WHERE store_id = $1`, [SEED_IDS.stores.brandC]))
        .rowCount,
    ).toBe(5);
    // and a second run is just as quiet
    await seed(twin.owner, { productsPerStore: 5, log: () => {} });
  }, 180_000);
});
