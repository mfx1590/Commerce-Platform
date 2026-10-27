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

  it('creates 3 stores with the fixed ids, 2 warehouses, 3 legal entities, one user per role', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const stores = await hq.query<{ id: string; code: string; default_currency: string }>(
      'SELECT id, code, default_currency FROM store ORDER BY code',
    );
    expect(stores.rows).toEqual([
      { id: SEED_IDS.stores.brandA, code: 'brand-a', default_currency: 'EUR' },
      { id: SEED_IDS.stores.brandB, code: 'brand-b', default_currency: 'GBP' },
      { id: SEED_IDS.stores.brandC, code: 'brand-c', default_currency: 'USD' },
    ]);
    expect((await hq.query('SELECT id FROM warehouse')).rowCount).toBe(2);
    expect((await hq.query('SELECT id FROM legal_entity')).rowCount).toBe(3);
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

  it('store A sees only its own catalog; HQ sees all three', async () => {
    const a = createTenantClient(db.app, {
      organizationId: ORG,
      storeIds: [SEED_IDS.stores.brandA],
    });
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    expect((await a.query('SELECT id FROM product')).rowCount).toBe(25);
    expect((await hq.query('SELECT id FROM product')).rowCount).toBe(75);
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
