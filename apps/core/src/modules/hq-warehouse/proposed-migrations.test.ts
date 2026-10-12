// The stock pool's schema on a seeded throwaway database (#435; migrations 0190 + 0191 in packages/db). Asserted:
// every variant has a stock item (the seed's two shared variants map ONE), the naming rule, only organization
// scope may map a variant, and row-level security holds the line the manager drew (2026-10-12): a store-scoped
// session reaches a pool row ONLY when one of its stores maps the item, the ledger only for its own stores'
// movements, and reservations stay store-scoped.
import { createOrganizationClient, createTenantClient, SEED_IDS } from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPoolDatabase } from './testing/pool-database';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const EU = SEED_IDS.warehouses.eu;

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let hq: ReturnType<typeof createOrganizationClient>;

interface Variant {
  id: string;
  sku: string;
  product_id: string;
  stock_item_id: string;
}
// Brand A: `shared` (brand B's `mapped` variant is pooled onto its item) and `clash` (its sku is copied onto a
// brand B variant). Brand B: `own` stays alone on its item. None of them is the seed's shared pair.
let shared: Variant;
let clash: Variant;
let mapped: Variant;
let own: Variant;
let clashCopyId: string;
let variantsBefore: number;

const VARIANT_COLS = `id, sku, product_id, stock_item_id`;
/** A store's variants that sit alone on their item (the seed's shared pair, SEED_IDS.sharedStock, is left out). */
async function variantsOf(storeId: string, limit: number): Promise<Variant[]> {
  const { rows } = await db.owner.query<Variant>(
    `SELECT ${VARIANT_COLS} FROM product_variant
     WHERE store_id = $1 AND manage_inventory AND title <> 'Clash copy' AND stock_item_id <> $3
     ORDER BY sku LIMIT $2`,
    [storeId, limit, SEED_IDS.sharedStock.stockItem],
  );
  return rows;
}

interface Counter {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}
async function count(client: Counter, from: string, params: unknown[] = []): Promise<number> {
  const { rows } = await client.query(`SELECT count(*)::text AS n FROM ${from}`, params);
  return Number((rows[0] as { n: string }).n);
}

beforeAll(async () => {
  db = await createPoolDatabase();
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  hq = createOrganizationClient(db.app, { organizationId: ORG });

  // One sku carried by two brands: brand B gets a variant with a sku brand A already sells.
  const seedA = await db.owner.query<Variant>(
    `SELECT ${VARIANT_COLS} FROM product_variant WHERE store_id = $1 ORDER BY sku DESC LIMIT 1`,
    [A],
  );
  clash = seedA.rows[0]!;
  const copy = await db.owner.query<{ id: string }>(
    `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title)
     SELECT organization_id, store_id, id, $2, 'Clash copy' FROM product WHERE store_id = $1 ORDER BY id LIMIT 1
     RETURNING id`,
    [B, clash.sku],
  );
  clashCopyId = copy.rows[0]!.id;
  variantsBefore = await count(db.owner, `product_variant`);
}, 240_000);

afterAll(async () => {
  await db?.drop();
});

describe('a stock item for every variant (0190 backfill, 0191 trigger)', () => {
  it("maps every variant, one item each — except the seed's shared pair, which maps ONE", async () => {
    expect(await count(db.owner, `product_variant WHERE stock_item_id IS NULL`)).toBe(0);
    expect(await count(db.owner, `stock_item`)).toBe(variantsBefore - 1);
    const pooled = await db.owner.query<{ stock_item_id: string; variants: string[] }>(
      `SELECT stock_item_id, array_agg(id::text ORDER BY id) AS variants FROM product_variant
       GROUP BY stock_item_id HAVING count(*) > 1`,
    );
    expect(pooled.rows).toEqual([
      {
        stock_item_id: SEED_IDS.sharedStock.stockItem,
        variants: [SEED_IDS.sharedStock.variantBrandA, SEED_IDS.sharedStock.variantBrandB].sort(),
      },
    ]);
  });

  it('keeps the variant sku when it is unique in the organization', async () => {
    const [v] = await variantsOf(A, 1);
    const item = await db.owner.query<{ sku: string; organization_id: string }>(
      `SELECT sku, organization_id FROM stock_item WHERE id = $1`,
      [v!.stock_item_id],
    );
    expect(item.rows[0]).toEqual({ sku: v!.sku, organization_id: ORG });
  });

  it('prefixes the store code for a variant whose sku already names an item, and never merges them', async () => {
    const { rows } = await db.owner.query<{ id: string; item_sku: string; stock_item_id: string }>(
      `SELECT v.id, si.sku AS item_sku, v.stock_item_id FROM product_variant v
       JOIN stock_item si ON si.id = v.stock_item_id WHERE v.id = ANY ($1::uuid[])`,
      [[clash.id, clashCopyId]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(clash.id)!.item_sku).toBe(clash.sku);
    expect(byId.get(clashCopyId)!.item_sku).toBe(`brand-b:${clash.sku}`);
    expect(byId.get(clash.id)!.stock_item_id).not.toBe(byId.get(clashCopyId)!.stock_item_id);
  });

  it('leaves the backfill nothing to do', async () => {
    const again = await db.owner.query<{ n: number }>(`SELECT app.backfill_stock_items() AS n`);
    expect(again.rows[0]!.n).toBe(0);
  });

  it('lets a store session see only the items its own variants map', async () => {
    expect(await count(a, `stock_item`)).toBe(
      await count(a, `(SELECT DISTINCT stock_item_id FROM product_variant) AS mine`),
    );
    expect(await count(hq, `stock_item`)).toBe(variantsBefore - 1);
  });
});

describe('the mapping guard (0190)', () => {
  const remap = `UPDATE product_variant SET stock_item_id = $2 WHERE id = $1`;
  const insertMapped = `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title, stock_item_id)
     VALUES ($1, $2, $3, $4, 'Mapped at insert', $5)`;
  let mine: Variant[];
  let theirs: Variant;

  beforeAll(async () => {
    mine = await variantsOf(A, 2);
    theirs = (await variantsOf(B, 1))[0]!;
  });

  it("refuses a store session that points its variant at another brand's item", async () => {
    await expect(a.query(remap, [mine[0]!.id, theirs.stock_item_id])).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('refuses a store session that points its variant at another of its own items', async () => {
    await expect(a.query(remap, [mine[0]!.id, mine[1]!.stock_item_id])).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('refuses an empty scope too: only organization scope maps', async () => {
    // the owner role bypasses row security and carries no scope at all
    await expect(
      db.owner.query(remap, [mine[0]!.id, mine[1]!.stock_item_id]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      await count(db.owner, `product_variant WHERE id = $1 AND stock_item_id = $2`, [
        mine[0]!.id,
        mine[0]!.stock_item_id,
      ]),
    ).toBe(1);
  });

  it('refuses a store session inserting a variant already mapped to an item it maps', async () => {
    await expect(
      a.query(insertMapped, [
        ORG,
        A,
        mine[0]!.product_id,
        'mapped-insert-one',
        mine[1]!.stock_item_id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a store session inserting a variant already mapped to an item it does not map', async () => {
    await expect(
      a.query(insertMapped, [
        ORG,
        A,
        mine[0]!.product_id,
        'mapped-insert-two',
        theirs.stock_item_id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await count(a, `stock_item WHERE id = $1`, [theirs.stock_item_id])).toBe(0);
  });

  it('lets a store session edit its variant without touching the mapping', async () => {
    const r = await a.query(`UPDATE product_variant SET title = title WHERE id = $1`, [
      mine[0]!.id,
    ]);
    expect(r.rowCount).toBe(1);
  });
});

describe('0191 (rekey)', () => {
  beforeAll(async () => {
    const [a1] = await variantsOf(A, 1);
    const [b1, b2] = await variantsOf(B, 2);
    shared = a1!;
    mapped = b1!;
    own = b2!;
    // HQ pools brand B's variant onto brand A's item (what mapVariantToStockItem will do).
    await hq.query(`UPDATE product_variant SET stock_item_id = $2 WHERE id = $1`, [
      mapped.id,
      shared.stock_item_id,
    ]);
  }, 240_000);

  it('makes the mapping mandatory', async () => {
    expect(
      await count(
        db.owner,
        `information_schema.columns WHERE table_name = 'product_variant'
         AND column_name = 'stock_item_id' AND is_nullable = 'NO'`,
      ),
    ).toBe(1);
  });

  it('keys a level by stock item: no store, no variant', async () => {
    expect(
      await count(
        db.owner,
        `information_schema.columns WHERE table_name = 'inventory_level'
         AND column_name IN ('store_id', 'variant_id')`,
      ),
    ).toBe(0);
  });

  it('holds one level per (stock item, warehouse)', async () => {
    await expect(
      db.owner.query(
        `INSERT INTO inventory_level (organization_id, stock_item_id, warehouse_id) VALUES ($1, $2, $3)`,
        [ORG, shared.stock_item_id, EU],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  describe('row-level security', () => {
    it('brand A cannot SELECT an item only brand B maps: item, level or movement', async () => {
      const item = [own.stock_item_id];
      expect(await count(a, `stock_item WHERE id = $1`, item)).toBe(0);
      expect(await count(a, `inventory_level WHERE stock_item_id = $1`, item)).toBe(0);
      expect(await count(a, `stock_movement WHERE stock_item_id = $1`, item)).toBe(0);
      // brand B, which maps it, does see its levels
      expect(await count(b, `inventory_level WHERE stock_item_id = $1`, item)).toBeGreaterThan(0);
    });

    it('brand A cannot UPDATE an item only brand B maps', async () => {
      const level = await a.query(
        `UPDATE inventory_level SET reserved = reserved + 1 WHERE stock_item_id = $1`,
        [own.stock_item_id],
      );
      expect(level.rowCount).toBe(0);
      const item = await a.query(`UPDATE stock_item SET name = 'taken' WHERE id = $1`, [
        own.stock_item_id,
      ]);
      expect(item.rowCount).toBe(0);
    });

    it('brand A cannot write a movement for an item only brand B maps', async () => {
      await expect(
        a.query(
          `INSERT INTO stock_movement (organization_id, stock_item_id, warehouse_id, delta, reason)
           VALUES ($1, $2, $3, 5, 'receipt')`,
          [ORG, own.stock_item_id, EU],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('both brands see and can lock the shared item', async () => {
      for (const client of [a, b]) {
        const locked = await client.transaction(async (tx) => {
          const item = await tx.query(`SELECT id FROM stock_item WHERE id = $1`, [
            shared.stock_item_id,
          ]);
          const level = await tx.query(
            `SELECT id FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2 FOR UPDATE`,
            [shared.stock_item_id, EU],
          );
          return [item.rowCount, level.rowCount];
        });
        expect(locked).toEqual([1, 1]);
      }
    });

    it('organization scope sees every pool row', async () => {
      expect(await count(hq, `stock_item`)).toBe(await count(db.owner, `stock_item`));
      expect(await count(hq, `inventory_level`)).toBe(await count(db.owner, `inventory_level`));
    });

    it("brand A sees the pool's reserved total but not brand B's reservation rows", async () => {
      // a reservation needs an order or a cart; the seed has neither, a bare cart of brand B will do
      const cart = await db.owner.query<{ id: string }>(
        `INSERT INTO cart (organization_id, store_id, sales_channel_id, currency, locale, country)
         SELECT organization_id, store_id, id, 'GBP', 'en-GB', 'GB' FROM sales_channel
         WHERE store_id = $1 ORDER BY id LIMIT 1 RETURNING id`,
        [B],
      );
      const level = `SELECT reserved FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`;
      const key = [shared.stock_item_id, EU];
      const before = await a.query<{ reserved: number }>(level, key);
      await b.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO reservation
             (organization_id, store_id, variant_id, stock_item_id, warehouse_id, cart_id, quantity, allocation_rule)
           VALUES ($1, $2, $3, $4, $5, $6, 2, 'priority')`,
          [ORG, B, mapped.id, shared.stock_item_id, EU, cart.rows[0]!.id],
        );
        await tx.query(
          `UPDATE inventory_level SET reserved = reserved + 2 WHERE stock_item_id = $1 AND warehouse_id = $2`,
          key,
        );
      });
      const after = await a.query<{ reserved: number }>(level, key);
      expect(after.rows[0]!.reserved).toBe(before.rows[0]!.reserved + 2);

      const theirs = `reservation WHERE stock_item_id = $1 AND store_id = $2`;
      expect(await count(a, theirs, [shared.stock_item_id, B])).toBe(0);
      expect(await count(b, theirs, [shared.stock_item_id, B])).toBe(1);
    });

    it('a store session cannot INSERT a stock item', async () => {
      await expect(
        a.query(
          `INSERT INTO stock_item (organization_id, sku, name) VALUES ($1, 'store-made-item', 'x')`,
          [ORG],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('a store session cannot re-map its variant; organization scope can', async () => {
      const [, other] = await variantsOf(A, 2);
      await expect(
        a.query(`UPDATE product_variant SET stock_item_id = $2 WHERE id = $1`, [
          other!.id,
          shared.stock_item_id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      const item = `product_variant WHERE id = $1 AND stock_item_id = $2`;
      expect(await count(db.owner, item, [other!.id, other!.stock_item_id])).toBe(1);
      // the organization-scope re-map in beforeAll went through
      expect(await count(db.owner, item, [mapped.id, shared.stock_item_id])).toBe(1);
    });

    describe('the ledger on a shared item (pool_ledger)', () => {
      const insert = `INSERT INTO stock_movement
           (organization_id, store_id, variant_id, stock_item_id, warehouse_id, delta, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
      const byId = `stock_movement WHERE id = $1`;
      let saleOfB: string;
      let receipt: string;

      beforeAll(async () => {
        const item = shared.stock_item_id;
        const sale = await hq.query<{ id: string }>(insert, [
          ORG,
          B,
          mapped.id,
          item,
          EU,
          -1,
          'sale',
        ]);
        const noStore = await hq.query<{ id: string }>(insert, [
          ORG,
          null,
          null,
          item,
          EU,
          9,
          'receipt',
        ]);
        saleOfB = sale.rows[0]!.id;
        receipt = noStore.rows[0]!.id;
      });

      it('brand A cannot INSERT a movement attributed to brand B', async () => {
        await expect(
          a.query(insert, [ORG, B, mapped.id, shared.stock_item_id, EU, -1, 'sale']),
        ).rejects.toMatchObject({ code: '42501' });
      });

      it("brand A cannot SELECT brand B's sale movement", async () => {
        expect(await count(a, byId, [saleOfB])).toBe(0);
        expect(await count(b, byId, [saleOfB])).toBe(1);
      });

      it('brand A cannot INSERT a movement with no store', async () => {
        await expect(
          a.query(insert, [ORG, null, null, shared.stock_item_id, EU, 3, 'receipt']),
        ).rejects.toMatchObject({ code: '42501' });
      });

      it('no store session can SELECT a movement with no store', async () => {
        expect(await count(a, byId, [receipt])).toBe(0);
        expect(await count(b, byId, [receipt])).toBe(0);
      });

      it('organization scope reads both (and wrote both)', async () => {
        expect(await count(hq, byId, [saleOfB])).toBe(1);
        expect(await count(hq, byId, [receipt])).toBe(1);
      });

      it('brand A writes and reads its own attributed movement', async () => {
        const own = await a.query<{ id: string }>(insert, [
          ORG,
          A,
          shared.id,
          shared.stock_item_id,
          EU,
          -1,
          'sale',
        ]);
        expect(await count(a, byId, [own.rows[0]!.id])).toBe(1);
        expect(await count(b, byId, [own.rows[0]!.id])).toBe(0);
      });
    });

    it('keeps the ledger append-only for the application role, and attribution all-or-nothing', async () => {
      await expect(hq.query(`UPDATE stock_movement SET delta = 1`)).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        hq.query(
          `INSERT INTO stock_movement (organization_id, store_id, stock_item_id, warehouse_id, delta, reason)
           VALUES ($1, $2, $3, $4, 1, 'sale')`,
          [ORG, B, own.stock_item_id, EU],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('a variant created after the rekey', () => {
    const insertVariant = `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title)
       VALUES ($1, $2, $3, $4, $5)`;
    const itemSku = `SELECT si.sku FROM product_variant v JOIN stock_item si ON si.id = v.stock_item_id
       WHERE v.store_id = $1 AND v.sku = $2`;

    it('gets its own stock item in a store session, with the sku rule applied', async () => {
      await a.query(insertVariant, [ORG, A, shared.product_id, 'fresh-variant-one', 'New size']);
      const plain = await a.query<{ sku: string }>(itemSku, [A, 'fresh-variant-one']);
      expect(plain.rows[0]!.sku).toBe('fresh-variant-one');

      // brand B's `own` sku already names a stock item brand A cannot even see: the rule still prefixes
      await a.query(insertVariant, [ORG, A, shared.product_id, own.sku, 'Same sku as brand B']);
      const prefixed = await a.query<{ sku: string }>(itemSku, [A, own.sku]);
      expect(prefixed.rows[0]!.sku).toBe(`brand-a:${own.sku}`);
    });

    const scope = `SELECT current_setting('app.scope', true) AS scope`;

    it('leaves the session in store scope after a successful insert', async () => {
      const seen = await a.transaction(async (tx) => {
        await tx.query(insertVariant, [ORG, A, shared.product_id, 'fresh-variant-two', 'Another']);
        const now = await tx.query<{ scope: string }>(scope);
        const r = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM stock_item WHERE id = $1`,
          [own.stock_item_id],
        );
        return [now.rows[0]!.scope, Number(r.rows[0]!.n)];
      });
      expect(seen).toEqual(['store', 0]);
    });

    it('leaves the scope as it was after an insert that fails inside the trigger', async () => {
      const seen = await a.transaction(async (tx) => {
        await tx.query('SAVEPOINT failing');
        // an empty sku passes product_variant's own checks and fails stock_item's CHECK inside the function
        const error = await tx
          .query(insertVariant, [ORG, A, shared.product_id, '', 'No sku'])
          .then(() => null)
          .catch((e: { code?: string }) => e.code);
        await tx.query('ROLLBACK TO SAVEPOINT failing');
        const now = await tx.query<{ scope: string }>(scope);
        return [error, now.rows[0]!.scope];
      });
      expect(seen).toEqual(['23514', 'store']);
    });

    it('leaves the scope as it was after a refused insert', async () => {
      const seen = await a.transaction(async (tx) => {
        await tx.query('SAVEPOINT refused');
        const error = await tx
          .query(
            `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title, stock_item_id)
             VALUES ($1, $2, $3, 'refused-variant-one', 'Refused', $4)`,
            [ORG, A, shared.product_id, shared.stock_item_id],
          )
          .then(() => null)
          .catch((e: { code?: string }) => e.code);
        await tx.query('ROLLBACK TO SAVEPOINT refused');
        const now = await tx.query<{ scope: string }>(scope);
        return [error, now.rows[0]!.scope];
      });
      expect(seen).toEqual(['42501', 'store']);
    });

    it('lets organization scope insert a variant already mapped', async () => {
      await hq.query(
        `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title, stock_item_id)
         VALUES ($1, $2, $3, 'hq-mapped-variant', 'Mapped by HQ', $4)`,
        [ORG, A, shared.product_id, shared.stock_item_id],
      );
      expect(
        await count(
          db.owner,
          `product_variant WHERE sku = 'hq-mapped-variant' AND stock_item_id = $1`,
          [shared.stock_item_id],
        ),
      ).toBe(1);
    });
  });
});
