// The shared pool end to end (#435), on a seeded throwaway database: two brands map variants to one stock item,
// and the stock-aware allocation policy decides under the pool rows' locks. Nothing is faked: placements go
// through the inventory module's `reserveForOrder` with this module's policy registered behind its
// `setAllocationPolicy` seam (#454) — the registration `src/wiring.ts` makes at boot.
import {
  createOrganizationClient,
  createTenantClient,
  SEED_IDS,
  type ScopedClient,
} from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveForOrder, setAllocationPolicy, type AllocationPolicy } from '../inventory';
import { stockAwareAllocationPolicy } from './index';
import { createPoolDatabase } from './testing/pool-database';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const EU = SEED_IDS.warehouses.eu;
const US = SEED_IDS.warehouses.us;

let db: TestDatabase;
let a: ScopedClient;
let b: ScopedClient;
let hq: ScopedClient;
let previousPolicy: AllocationPolicy;
let displayId = 900_000;
// Two shared items: brand A's variant and brand B's variant of each map to the same stock item.
let one: { item: string; variantA: string; variantB: string };
let two: { item: string; variantA: string; variantB: string };

type Lines = { variantId: string; quantity: number }[];

/** Fixture (owner role): a bare order to hang reservations on; only its store and destination matter here. */
async function order(storeId: string, country: string | null): Promise<string> {
  const address = JSON.stringify(country === null ? {} : { country });
  const made = await db.owner.query<{ id: string }>(
    `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, email, currency, locale,
                          shipping_address, billing_address, subtotal_minor, total_minor)
     SELECT organization_id, store_id, $2, id, 'pool-test@example.invalid', 'EUR', 'en', $3::jsonb, $3::jsonb, 0, 0
     FROM sales_channel WHERE store_id = $1 ORDER BY id LIMIT 1 RETURNING id`,
    [storeId, displayId++, address],
  );
  return made.rows[0]!.id;
}

async function place(client: ScopedClient, storeId: string, lines: Lines, country: string | null) {
  const orderId = await order(storeId, country);
  const results = await client.transaction((tx) =>
    reserveForOrder(tx, { organizationId: ORG, storeId, orderId, lines }),
  );
  return { orderId, results };
}
const placeA = (lines: Lines, country: string | null = 'NL') => place(a, A, lines, country);
const placeB = (lines: Lines, country: string | null = 'NL') => place(b, B, lines, country);

/** Sets what is free on a pool row, whatever is reserved on it already (fixture: the owner role). */
async function shelf(item: string, warehouse: string, free: number): Promise<void> {
  await db.owner.query(
    `UPDATE inventory_level SET on_hand = reserved + $3 WHERE stock_item_id = $1 AND warehouse_id = $2`,
    [item, warehouse, free],
  );
}

/** What a store's catalog would show for its variant: the pool rows' `available`, summed over warehouses. */
async function availableFor(client: ScopedClient, variantId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT coalesce(sum(il.available), 0)::text AS n
     FROM product_variant v
     JOIN inventory_level il ON il.stock_item_id = v.stock_item_id
     JOIN warehouse w ON w.id = il.warehouse_id AND w.is_active
     WHERE v.id = $1`,
    [variantId],
  );
  return Number(rows[0]!.n);
}

async function level(item: string, warehouse: string) {
  const { rows } = await db.owner.query<{ on_hand: number; reserved: number; available: number }>(
    `SELECT on_hand, reserved, available FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`,
    [item, warehouse],
  );
  return rows[0]!;
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'placed' as const,
    (e: { code?: string }) => {
      if (e.code === 'out_of_stock') return 'out_of_stock' as const;
      throw e;
    },
  );

beforeAll(async () => {
  db = await createPoolDatabase();
  previousPolicy = setAllocationPolicy(stockAwareAllocationPolicy);
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  hq = createOrganizationClient(db.app, { organizationId: ORG });

  // Variants that sit alone on their item (not the seed's shared pair), so the pooling below is this test's.
  const variants = async (storeId: string) =>
    (
      await db.owner.query<{ id: string; stock_item_id: string }>(
        `SELECT id, stock_item_id FROM product_variant
         WHERE store_id = $1 AND manage_inventory AND NOT allow_backorder AND stock_item_id <> $2
         ORDER BY sku LIMIT 2`,
        [storeId, SEED_IDS.sharedStock.stockItem],
      )
    ).rows;
  const [a1, a2] = await variants(A);
  const [b1, b2] = await variants(B);
  one = { item: a1!.stock_item_id, variantA: a1!.id, variantB: b1!.id };
  two = { item: a2!.stock_item_id, variantA: a2!.id, variantB: b2!.id };
  // HQ pools brand B's variants onto brand A's items (what mapVariantToStockItem does).
  for (const s of [one, two]) {
    await hq.query(`UPDATE product_variant SET stock_item_id = $2 WHERE id = $1`, [
      s.variantB,
      s.item,
    ]);
  }
}, 240_000);

afterAll(async () => {
  if (previousPolicy) setAllocationPolicy(previousPolicy);
  await db?.drop();
});

describe('one pool for two brands', () => {
  it("store A reserves N and store B's availability drops by N", async () => {
    await shelf(one.item, EU, 10);
    await shelf(one.item, US, 4);
    expect(await availableFor(b, one.variantB)).toBe(14);
    expect(await availableFor(a, one.variantA)).toBe(14);

    const { results } = await placeA([{ variantId: one.variantA, quantity: 3 }]);
    expect(results).toEqual([
      {
        variantId: one.variantA,
        allocations: [{ warehouseId: EU, quantity: 3, rule: 'same_country' }],
        backorderQuantity: 0,
      },
    ]);

    expect(await availableFor(b, one.variantB)).toBe(11);
    expect(await availableFor(a, one.variantA)).toBe(11);
  });

  it("the second brand's order sees the first's reservation and splits around it", async () => {
    await shelf(one.item, EU, 5);
    await shelf(one.item, US, 2);
    await placeA([{ variantId: one.variantA, quantity: 3 }]); // EU now has 2 free
    const { results } = await placeB([{ variantId: one.variantB, quantity: 4 }]);
    expect(results[0]!.allocations).toEqual([
      { warehouseId: EU, quantity: 2, rule: 'same_country' },
      { warehouseId: US, quantity: 2, rule: 'split:priority' },
    ]);
    expect((await level(one.item, EU)).available).toBe(0);
    expect((await level(one.item, US)).available).toBe(0);
  });

  it('prefers one farther warehouse that covers the line over splitting the nearest', async () => {
    await shelf(one.item, EU, 3);
    await shelf(one.item, US, 9);
    const { results } = await placeB([{ variantId: one.variantB, quantity: 4 }]);
    expect(results[0]!.allocations).toEqual([{ warehouseId: US, quantity: 4, rule: 'priority' }]);
  });

  it('records the rule of every allocation on the reservation, for the admin', async () => {
    await shelf(one.item, EU, 2);
    await shelf(one.item, US, 2);
    const { orderId } = await placeB([{ variantId: one.variantB, quantity: 3 }]);
    const { rows } = await hq.query<{
      warehouse_id: string;
      quantity: number;
      allocation_rule: string;
      stock_item_id: string;
      store_id: string;
    }>(
      `SELECT warehouse_id, quantity, allocation_rule, stock_item_id, store_id FROM reservation
       WHERE order_id = $1 ORDER BY allocation_rule`,
      [orderId],
    );
    const row = { stock_item_id: one.item, store_id: B };
    expect(rows).toEqual([
      { warehouse_id: EU, quantity: 2, allocation_rule: 'same_country', ...row },
      { warehouse_id: US, quantity: 1, allocation_rule: 'split:priority', ...row },
    ]);
  });

  it("keeps each brand's reservation rows to itself while both see the pool's total", async () => {
    const mine = async (client: ScopedClient) =>
      Number(
        (
          await client.query<{ n: string }>(
            `SELECT coalesce(sum(quantity), 0)::text AS n FROM reservation WHERE stock_item_id = $1`,
            [one.item],
          )
        ).rows[0]!.n,
      );
    const fromA = await mine(a);
    const fromB = await mine(b);
    expect(fromA).toBeGreaterThan(0);
    expect(fromB).toBeGreaterThan(0);
    expect(await mine(hq)).toBe(fromA + fromB);

    const total = async (client: ScopedClient) =>
      Number(
        (
          await client.query<{ n: string }>(
            `SELECT sum(reserved)::text AS n FROM inventory_level WHERE stock_item_id = $1`,
            [one.item],
          )
        ).rows[0]!.n,
      );
    expect(await total(a)).toBe(await total(b));
    expect(await total(a)).toBeGreaterThanOrEqual(fromA + fromB);
  });

  it('refuses an order no warehouse can cover (409 out_of_stock) and reserves nothing of it', async () => {
    await shelf(one.item, EU, 1);
    await shelf(one.item, US, 1);
    const before = [await level(one.item, EU), await level(one.item, US)];
    await expect(placeB([{ variantId: one.variantB, quantity: 3 }])).rejects.toMatchObject({
      code: 'out_of_stock',
      status: 409,
      details: { variant_id: one.variantB, available: 2 },
    });
    expect([await level(one.item, EU), await level(one.item, US)]).toEqual(before);
  });

  it('honours the store override for the destination country', async () => {
    await shelf(one.item, EU, 9);
    await shelf(one.item, US, 9);
    await db.owner.query(
      `UPDATE store SET settings = jsonb_set(settings, '{fulfillment}', $2::jsonb) WHERE id = $1`,
      [B, JSON.stringify({ routing: { countries: { NL: 'wh-us' } } })],
    );
    try {
      const { results } = await placeB([{ variantId: one.variantB, quantity: 2 }]);
      expect(results[0]!.allocations).toEqual([
        { warehouseId: US, quantity: 2, rule: 'store_country' },
      ]);
      // brand A has no override: the same destination still goes to the warehouse in the country
      const fromA = await placeA([{ variantId: one.variantA, quantity: 2 }]);
      expect(fromA.results[0]!.allocations).toEqual([
        { warehouseId: EU, quantity: 2, rule: 'same_country' },
      ]);
    } finally {
      await db.owner.query(`UPDATE store SET settings = settings - 'fulfillment' WHERE id = $1`, [
        B,
      ]);
    }
  });
});

describe('concurrency on the shared pool', () => {
  it('gives the last unit to exactly one of two racing placements, one from each brand', async () => {
    for (let round = 0; round < 5; round++) {
      await shelf(one.item, EU, 1);
      await shelf(one.item, US, 0);
      const results = await Promise.all([
        outcome(placeA([{ variantId: one.variantA, quantity: 1 }])),
        outcome(placeB([{ variantId: one.variantB, quantity: 1 }])),
      ]);
      expect([...results].sort()).toEqual(['out_of_stock', 'placed']);
      expect((await level(one.item, EU)).available).toBe(0);
    }
  });

  // 8 placements issued at once; the test database's app pool has 4 connections, so 4 run concurrently.
  it('never over-allocates under 8 placements issued at once from both brands', async () => {
    await shelf(one.item, EU, 3);
    await shelf(one.item, US, 2);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        outcome(
          i % 2 === 0
            ? placeA([{ variantId: one.variantA, quantity: 1 }])
            : placeB([{ variantId: one.variantB, quantity: 1 }], 'US'),
        ),
      ),
    );
    expect(results.filter((r) => r === 'placed')).toHaveLength(5);
    expect(results.filter((r) => r === 'out_of_stock')).toHaveLength(3);
    expect((await level(one.item, EU)).available).toBe(0);
    expect((await level(one.item, US)).available).toBe(0);
  });

  it('does not deadlock when placements name two shared items in opposite order', async () => {
    for (const s of [one, two]) {
      await shelf(s.item, EU, 20);
      await shelf(s.item, US, 20);
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? placeA([
              { variantId: one.variantA, quantity: 1 },
              { variantId: two.variantA, quantity: 1 },
            ])
          : placeB([
              { variantId: two.variantB, quantity: 1 },
              { variantId: one.variantB, quantity: 1 },
            ]),
      ),
    );
    expect(results).toHaveLength(8);
    expect((await level(one.item, EU)).available).toBe(12);
    expect((await level(two.item, EU)).available).toBe(12);
  });
});
