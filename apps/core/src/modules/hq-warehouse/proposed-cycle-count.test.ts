// The proposed cycle-count migration (proposed/0192, #436) on a seeded throwaway database migrated to main's
// head: its CHECKs hold a count's story
// together, and row-level security is `organization_only` — counts are an HQ record no store session touches.
import { createOrganizationClient, createTenantClient, SEED_IDS } from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPoolDatabase } from './testing/pool-database';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const EU = SEED_IDS.warehouses.eu;

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let hq: ReturnType<typeof createOrganizationClient>;
let other: ReturnType<typeof createOrganizationClient>;
let item: string;
let countId: string;

// a manual count, by the first seeded staff user
const insert = `INSERT INTO cycle_count
     (organization_id, warehouse_id, stock_item_id, counted_quantity, counted_at, counted_by)
   SELECT $1, $2, $3, $4, now(), id FROM staff_user ORDER BY id LIMIT 1 RETURNING id`;
const insertFrom = `INSERT INTO cycle_count
     (organization_id, warehouse_id, stock_item_id, counted_quantity, counted_at, source, counted_by)
   VALUES ($1, $2, $3, 4, now(), $4, $5) RETURNING id`;

async function count(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  from: string,
  params: unknown[] = [],
): Promise<number> {
  const { rows } = await client.query(`SELECT count(*)::text AS n FROM ${from}`, params);
  return Number((rows[0] as { n: string }).n);
}

beforeAll(async () => {
  db = await createPoolDatabase('0192');

  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  const second = await db.owner.query<{ id: string }>(
    `INSERT INTO organization (slug, name) VALUES ('other-organization', 'Other') RETURNING id`,
  );
  other = createOrganizationClient(db.app, { organizationId: second.rows[0]!.id });

  const variant = await db.owner.query<{ stock_item_id: string }>(
    `SELECT stock_item_id FROM product_variant WHERE store_id = $1 ORDER BY sku LIMIT 1`,
    [A],
  );
  item = variant.rows[0]!.stock_item_id;
  countId = (await hq.query<{ id: string }>(insert, [ORG, EU, item, 12])).rows[0]!.id;
}, 240_000);

afterAll(async () => {
  await db?.drop();
});

describe('0192: row-level security (organization_only)', () => {
  it('organization scope records and reads a count', async () => {
    expect(await count(hq, `cycle_count WHERE id = $1 AND status = 'recorded'`, [countId])).toBe(1);
  });

  it('a store session cannot SELECT a count, even for an item it maps', async () => {
    expect(await count(a, `stock_item WHERE id = $1`, [item])).toBe(1);
    expect(await count(a, `cycle_count`)).toBe(0);
  });

  it('a store session cannot INSERT a count, even for an item it maps', async () => {
    await expect(a.query(insert, [ORG, EU, item, 3])).rejects.toMatchObject({ code: '42501' });
  });

  it('a store session cannot UPDATE a count', async () => {
    const r = await a.query(`UPDATE cycle_count SET counted_quantity = 0 WHERE id = $1`, [countId]);
    expect(r.rowCount).toBe(0);
  });

  it('another organization sees none', async () => {
    expect(await count(other, `cycle_count`)).toBe(0);
  });

  it('leaves the existing kinds as they were: a store session still sees only its own stock items', async () => {
    expect(await count(a, `stock_item`)).toBe(await count(a, `product_variant`));
  });
});

describe("0192: a count's story holds together", () => {
  const set = (assignments: string) =>
    hq.query(`UPDATE cycle_count SET ${assignments} WHERE id = $1`, [countId]);

  it('refuses a manual count with no counter', async () => {
    await expect(hq.query(insertFrom, [ORG, EU, item, 'manual', null])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('refuses a WMS pull that names a staff user, and accepts one that names none', async () => {
    const staff = await db.owner.query<{ id: string }>(
      `SELECT id FROM staff_user ORDER BY id LIMIT 1`,
    );
    await expect(
      hq.query(insertFrom, [ORG, EU, item, 'wms', staff.rows[0]!.id]),
    ).rejects.toMatchObject({ code: '23514' });
    const pulled = await hq.query(insertFrom, [ORG, EU, item, 'wms', null]);
    expect(pulled.rowCount).toBe(1);
  });

  it('never lets the application role delete a count', async () => {
    await expect(
      hq.query(`DELETE FROM cycle_count WHERE id = $1`, [countId]),
    ).rejects.toMatchObject({
      code: '42501',
    });
    expect(await count(hq, `cycle_count WHERE id = $1`, [countId])).toBe(1);
  });

  it('refuses a negative count', async () => {
    await expect(hq.query(insert, [ORG, EU, item, -1])).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a reconciled status without what was computed', async () => {
    await expect(set(`status = 'flagged'`)).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a delta that is not counted minus on-hand as of the count', async () => {
    await expect(
      set(`status = 'flagged', on_hand_as_of_count = 10, delta = 5, reconciled_at = now()`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an applied non-zero delta with no movement', async () => {
    await expect(
      set(`status = 'applied', on_hand_as_of_count = 10, delta = 2, reconciled_at = now()`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an approval on a count that is not applied', async () => {
    await expect(
      set(
        `status = 'flagged', on_hand_as_of_count = 10, delta = 2, reconciled_at = now(), approved_at = now(),
         approved_by = (SELECT id FROM staff_user ORDER BY id LIMIT 1)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts a flagged count, and an applied one with a zero delta and no movement', async () => {
    await set(`status = 'flagged', on_hand_as_of_count = 10, delta = 2, reconciled_at = now()`);
    await set(`status = 'applied', on_hand_as_of_count = 12, delta = 0`);
    expect(
      await count(
        hq,
        `cycle_count WHERE id = $1 AND status = 'applied' AND stock_movement_id IS NULL`,
        [countId],
      ),
    ).toBe(1);
  });

  it('lets one movement settle one count only', async () => {
    expect(
      await count(
        db.owner,
        `pg_constraint WHERE conrelid = 'cycle_count'::regclass AND contype = 'u'
         AND pg_get_constraintdef(oid) = 'UNIQUE (stock_movement_id)'`,
      ),
    ).toBe(1);
  });
});
