// The shared pool end to end (#435), on a seeded throwaway database with 0190 (main) and the proposed 0191:
// two brands map variants to one stock item, and the allocation policy decides under the pool rows' locks.
//
// `reserveThroughSeam` below is a LOCAL FAKE of the one hook asked of the inventory module in REQUEST #454 — what
// `reserveForOrder` will do around `setAllocationPolicy` once window 1's rekey lands: lock the pool rows in
// (stock_item_id, warehouse_id) order, build the candidates from the locked rows, call the policy, validate the
// decision, write the reservations. It lives in this test file on purpose: only the inventory module may write
// `inventory_level` in application code (test/guards.test.ts), and this is not application code.
import {
  createOrganizationClient,
  createTenantClient,
  SEED_IDS,
  type ScopedClient,
} from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stockAwareAllocationPolicy, type AllocationDecision, type AllocationLine } from './index';
import { createPoolDatabase } from './testing/pool-database';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const EU = SEED_IDS.warehouses.eu;
const US = SEED_IDS.warehouses.us;

class OutOfStock extends Error {
  constructor(
    readonly variantId: string,
    readonly shortfall: number,
  ) {
    super(`out_of_stock ${variantId}`);
  }
}

interface Placement {
  storeId: string;
  cartId: string;
  destinationCountry: string | null;
  routingSettings?: unknown;
  lines: { variantId: string; quantity: number }[];
}

async function reserveThroughSeam(
  client: ScopedClient,
  input: Placement,
): Promise<AllocationDecision[]> {
  return client.transaction(async (tx) => {
    const variants = await tx.query<{
      id: string;
      stock_item_id: string;
      allow_backorder: boolean;
    }>(
      `SELECT id, stock_item_id, allow_backorder FROM product_variant WHERE id = ANY ($1::uuid[])`,
      [input.lines.map((l) => l.variantId)],
    );
    const variantById = new Map(variants.rows.map((v) => [v.id, v]));
    const warehouses = await tx.query<{
      id: string;
      code: string;
      country: string;
      priority: number;
    }>(`SELECT id, code, country, priority FROM warehouse WHERE is_active`);
    // The lock: every pool row the placement can touch, in one deterministic order.
    const levels = await tx.query<{
      stock_item_id: string;
      warehouse_id: string;
      available: number;
    }>(
      `SELECT stock_item_id, warehouse_id, available FROM inventory_level
       WHERE stock_item_id = ANY ($1::uuid[]) ORDER BY stock_item_id, warehouse_id FOR UPDATE`,
      [[...new Set(variants.rows.map((v) => v.stock_item_id))]],
    );
    const available = new Map(
      levels.rows.map((l) => [`${l.stock_item_id}:${l.warehouse_id}`, l.available]),
    );

    const lines: AllocationLine[] = input.lines.map((l) => {
      const variant = variantById.get(l.variantId);
      if (!variant) throw new Error(`variant ${l.variantId} is not this store's`);
      return {
        variantId: l.variantId,
        stockItemId: variant.stock_item_id,
        quantity: l.quantity,
        allowBackorder: variant.allow_backorder,
        candidates: warehouses.rows.map((w) => ({
          warehouseId: w.id,
          warehouseCode: w.code,
          country: w.country.trim(),
          priority: w.priority,
          available: available.get(`${variant.stock_item_id}:${w.id}`) ?? 0,
        })),
      };
    });

    const decisions = stockAwareAllocationPolicy(
      {
        organizationId: ORG,
        storeId: input.storeId,
        orderId: input.cartId,
        destinationCountry: input.destinationCountry,
        routingSettings: input.routingSettings ?? {},
      },
      lines,
    );

    // The module validates what the policy decided: a bad decision is a bug, never a customer error.
    const spent = new Map<string, number>();
    decisions.forEach((d, i) => {
      const sum = d.allocations.reduce((n, a) => n + a.quantity, 0);
      if (sum + d.shortfall !== lines[i]!.quantity)
        throw new Error('policy lost or invented units');
      for (const a of d.allocations) {
        const key = `${lines[i]!.stockItemId}:${a.warehouseId}`;
        spent.set(key, (spent.get(key) ?? 0) + a.quantity);
        if (spent.get(key)! > Math.max(0, available.get(key) ?? 0)) {
          throw new Error('policy over-allocated');
        }
      }
    });
    const short = decisions.find((d) => d.shortfall > 0);
    if (short) throw new OutOfStock(short.variantId, short.shortfall);

    for (const [i, d] of decisions.entries()) {
      for (const a of d.allocations) {
        await tx.query(
          `INSERT INTO reservation
             (organization_id, store_id, variant_id, stock_item_id, warehouse_id, cart_id, quantity, allocation_rule)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            ORG,
            input.storeId,
            d.variantId,
            lines[i]!.stockItemId,
            a.warehouseId,
            input.cartId,
            a.quantity,
            a.rule,
          ],
        );
        await tx.query(
          `UPDATE inventory_level SET reserved = reserved + $3 WHERE stock_item_id = $1 AND warehouse_id = $2`,
          [lines[i]!.stockItemId, a.warehouseId, a.quantity],
        );
      }
    }
    return decisions;
  });
}

let db: TestDatabase;
let a: ScopedClient;
let b: ScopedClient;
let hq: ScopedClient;
let cartA: string;
let cartB: string;
// Two shared items: brand A's variant and brand B's variant of each map to the same stock item.
let one: { item: string; variantA: string; variantB: string };
let two: { item: string; variantA: string; variantB: string };

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
    (e: unknown) => {
      if (e instanceof OutOfStock) return 'out_of_stock' as const;
      throw e;
    },
  );

beforeAll(async () => {
  db = await createPoolDatabase();
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  hq = createOrganizationClient(db.app, { organizationId: ORG });

  const variants = async (storeId: string) =>
    (
      await db.owner.query<{ id: string; stock_item_id: string }>(
        `SELECT id, stock_item_id FROM product_variant
         WHERE store_id = $1 AND manage_inventory AND NOT allow_backorder ORDER BY sku LIMIT 2`,
        [storeId],
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

  const cart = async (storeId: string) =>
    (
      await db.owner.query<{ id: string }>(
        `INSERT INTO cart (organization_id, store_id, sales_channel_id, currency, locale, country)
         SELECT organization_id, store_id, id, 'EUR', 'en', 'NL' FROM sales_channel
         WHERE store_id = $1 ORDER BY id LIMIT 1 RETURNING id`,
        [storeId],
      )
    ).rows[0]!.id;
  cartA = await cart(A);
  cartB = await cart(B);
}, 240_000);

afterAll(async () => {
  await db?.drop();
});

const placeA = (lines: Placement['lines'], destinationCountry: string | null = 'NL') =>
  reserveThroughSeam(a, { storeId: A, cartId: cartA, destinationCountry, lines });
const placeB = (lines: Placement['lines'], destinationCountry: string | null = 'NL') =>
  reserveThroughSeam(b, { storeId: B, cartId: cartB, destinationCountry, lines });

describe('one pool for two brands', () => {
  it("store A reserves N and store B's availability drops by N", async () => {
    await shelf(one.item, EU, 10);
    await shelf(one.item, US, 4);
    expect(await availableFor(b, one.variantB)).toBe(14);
    expect(await availableFor(a, one.variantA)).toBe(14);

    const [decision] = await placeA([{ variantId: one.variantA, quantity: 3 }]);
    expect(decision!.allocations).toEqual([{ warehouseId: EU, quantity: 3, rule: 'same_country' }]);

    expect(await availableFor(b, one.variantB)).toBe(11);
    expect(await availableFor(a, one.variantA)).toBe(11);
  });

  it("the second brand's order sees the first's reservation and splits around it", async () => {
    await shelf(one.item, EU, 5);
    await shelf(one.item, US, 2);
    await placeA([{ variantId: one.variantA, quantity: 3 }]); // EU now has 2 free
    const [decision] = await placeB([{ variantId: one.variantB, quantity: 4 }]);
    expect(decision).toEqual({
      variantId: one.variantB,
      allocations: [
        { warehouseId: EU, quantity: 2, rule: 'same_country' },
        { warehouseId: US, quantity: 2, rule: 'split:priority' },
      ],
      shortfall: 0,
    });
    expect((await level(one.item, EU)).available).toBe(0);
    expect((await level(one.item, US)).available).toBe(0);
  });

  it('records the rule of every allocation on the reservation, for the admin', async () => {
    const { rows } = await hq.query<{
      warehouse_id: string;
      quantity: number;
      allocation_rule: string;
    }>(
      `SELECT warehouse_id, quantity, allocation_rule FROM reservation
       WHERE store_id = $1 AND variant_id = $2 ORDER BY created_at DESC, allocation_rule LIMIT 2`,
      [B, one.variantB],
    );
    expect(rows).toEqual([
      { warehouse_id: EU, quantity: 2, allocation_rule: 'same_country' },
      { warehouse_id: US, quantity: 2, allocation_rule: 'split:priority' },
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

  it('refuses an order no warehouse can cover and reserves nothing of it', async () => {
    await shelf(one.item, EU, 1);
    await shelf(one.item, US, 1);
    const before = [await level(one.item, EU), await level(one.item, US)];
    await expect(placeB([{ variantId: one.variantB, quantity: 3 }])).rejects.toBeInstanceOf(
      OutOfStock,
    );
    expect([await level(one.item, EU), await level(one.item, US)]).toEqual(before);
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

  it('never over-allocates under 8 parallel placements from both brands', async () => {
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
