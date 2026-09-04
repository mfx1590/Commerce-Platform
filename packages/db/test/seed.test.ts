import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganizationClient, createTenantClient, seed, SEED_IDS } from '../src/index.js';
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
    expect((await hq.query('SELECT id FROM staff_user')).rowCount).toBe(7);
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
             (SELECT count(*) FROM inventory_level il JOIN product_variant v ON v.id = il.variant_id WHERE v.store_id <> il.store_id) AS bad`);
    expect(Number(r.rows[0]!.bad)).toBe(0);
  });
});
