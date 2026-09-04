import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganizationClient, createTenantClient } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

const ORG = '10000000-0000-4000-8000-000000000001';
const OTHER_ORG = '10000000-0000-4000-8000-000000000002';
const LE = '10000000-0000-4000-8000-000000000011';
const STORE_A = '10000000-0000-4000-8000-000000000031';
const STORE_B = '10000000-0000-4000-8000-000000000032';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  // Fixtures through the owner role, but FORCE RLS still applies: organization scope must be set explicitly.
  const hq = createOrganizationClient(db.owner, { organizationId: ORG });
  await hq.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq', 'HQ')`, [ORG]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le-a', 'A BV', 'NL', 'EUR')`,
      [LE, ORG],
    );
    for (const [id, code] of [
      [STORE_A, 'brand-a'],
      [STORE_B, 'brand-b'],
    ] as const) {
      await tx.query(
        `INSERT INTO store (id, organization_id, legal_entity_id, code, name, default_currency, default_locale, default_country)
         VALUES ($1, $2, $3, $4, $4, 'EUR', 'en-GB', 'NL')`,
        [id, ORG, LE, code],
      );
      await tx.query(
        `INSERT INTO product (organization_id, store_id, handle, title, status) VALUES ($1, $2, 'tee', 'Tee ' || $3, 'published')`,
        [ORG, id, code],
      );
    }
  });
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe('row-level security (platform_app role)', () => {
  it('a store-A session reads only store-A rows', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const products = await a.query<{ store_id: string }>('SELECT store_id FROM product');
    expect(products.rows).toHaveLength(1);
    expect(products.rows[0]?.store_id).toBe(STORE_A);

    const stores = await a.query<{ id: string }>('SELECT id FROM store');
    expect(stores.rows.map((r) => r.id)).toEqual([STORE_A]);
  });

  it('a store-A session cannot read store-B rows even when filtering for them', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const r = await a.query('SELECT id FROM product WHERE store_id = $1', [STORE_B]);
    expect(r.rowCount).toBe(0);
    const s = await a.query('SELECT id FROM store WHERE id = $1', [STORE_B]);
    expect(s.rowCount).toBe(0);
  });

  it('a store-A session cannot insert a row for store B', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    await expect(
      a.query(
        `INSERT INTO product (organization_id, store_id, handle, title) VALUES ($1, $2, 'hack', 'Hack')`,
        [ORG, STORE_B],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a store-A session cannot move its own row to store B', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    await expect(
      a.query('UPDATE product SET store_id = $1 WHERE store_id = $2', [STORE_B, STORE_A]),
    ).rejects.toThrow(/row-level security/);
  });

  it('a multi-store session sees exactly its stores', async () => {
    const ab = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A, STORE_B] });
    const r = await ab.query<{ store_id: string }>(
      'SELECT store_id FROM product ORDER BY store_id',
    );
    expect(r.rows.map((x) => x.store_id)).toEqual([STORE_A, STORE_B]);
  });

  it('organization scope sees every store; a foreign organization sees nothing', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    expect((await hq.query('SELECT id FROM product')).rowCount).toBe(2);
    expect((await hq.query('SELECT id FROM store')).rowCount).toBe(2);

    const other = createOrganizationClient(db.app, { organizationId: OTHER_ORG });
    expect((await other.query('SELECT id FROM product')).rowCount).toBe(0);
    expect((await other.query('SELECT id FROM organization')).rowCount).toBe(0);
  });

  it('no context means no rows (a pooled connection never leaks a previous tenant)', async () => {
    const client = await db.app.connect();
    try {
      expect((await client.query('SELECT id FROM product')).rowCount).toBe(0);
      expect((await client.query('SELECT id FROM store')).rowCount).toBe(0);
      expect((await client.query('SELECT id FROM organization')).rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('organization-level audit rows (store_id NULL) are hidden from store scope', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.query(
      `INSERT INTO audit_log (organization_id, store_id, actor_type, action, entity_type, entity_id)
       VALUES ($1, NULL, 'system', 'organization.update', 'organization', $1),
              ($1, $2, 'system', 'product.update', 'product', $1)`,
      [ORG, STORE_A],
    );
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const r = await a.query<{ action: string }>('SELECT action FROM audit_log');
    expect(r.rows.map((x) => x.action)).toEqual(['product.update']);
    expect((await hq.query('SELECT id FROM audit_log')).rowCount).toBe(2);
  });

  it('the app role cannot update or delete append-only tables', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await expect(hq.query(`DELETE FROM audit_log`)).rejects.toThrow(/permission denied/);
  });

  it('order display ids are per store and sequential', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const ids = await hq.transaction(async (tx) => {
      const out: Array<{ store_id: string; display_id: string }> = [];
      for (const store of [STORE_A, STORE_A, STORE_B]) {
        const ch = await tx.query<{ id: string }>(
          `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, 'web-' || gen_random_uuid(), 'Web', 'web') RETURNING id`,
          [ORG, store],
        );
        const o = await tx.query<{ store_id: string; display_id: string }>(
          `INSERT INTO "order" (organization_id, store_id, sales_channel_id, email, currency, locale,
             shipping_address, billing_address, subtotal_minor, total_minor)
           VALUES ($1, $2, $3, 'x@example.com', 'EUR', 'en-GB', '{}', '{}', 1000, 1000)
           RETURNING store_id, display_id`,
          [ORG, store, ch.rows[0]!.id],
        );
        out.push(o.rows[0]!);
      }
      return out;
    });
    expect(ids.map((x) => [x.store_id, Number(x.display_id)])).toEqual([
      [STORE_A, 1000],
      [STORE_A, 1001],
      [STORE_B, 1000],
    ]);
  });
});
