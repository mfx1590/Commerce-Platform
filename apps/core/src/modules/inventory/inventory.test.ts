// Inventory module (issue #106) on a fully seeded throwaway database: moveStock (locked level, append-only
// movement, one stock.moved), the app role cannot touch stock_movement rows, reservations at placement (greedy
// allocation by warehouse priority, 409 out_of_stock vs backorder, deterministic lock order under 8 parallel
// placements on shared variants, the last-unit race), release on cancel through the orders module, consumption on
// shipment, Store availability reflecting reservations, the Admin list/adjust services, RLS across stores that
// share a warehouse, and the void-on-failure path of placement (#174 review).
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import { getStoreProduct } from '../catalog';
import {
  completeCart,
  createPaymentSession,
  manualPaymentProvider,
  setPaymentProvider,
  type PaymentProvider,
} from '../checkout';
import { cancelOrder, confirmOrder } from '../orders';
import {
  consumeForShipment,
  consumeReservationsForShipment,
  createStockMovement,
  releaseReservationsForShipment,
  listInventoryLevels,
  moveStock,
  releaseForOrder,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const EU = SEED_IDS.warehouses.eu;
const US = SEED_IDS.warehouses.us;
const actor = { id: null, type: 'system' as const, requestId: 'req-inventory' };
const customer = { id: null, type: 'customer' as const, requestId: 'req-inventory' };
const address = {
  first_name: 'Jane',
  last_name: 'Doe',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let org: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let standardOptionId: string;
let n = 0;

interface V {
  id: string;
  sku: string;
  handle: string;
  eu: number;
  us: number;
}

async function variantsA(): Promise<V[]> {
  const r = await owner.query<V>(
    `SELECT v.id, v.sku, p.handle,
            coalesce((SELECT on_hand FROM inventory_level WHERE variant_id = v.id AND warehouse_id = $2), 0)::int AS eu,
            coalesce((SELECT on_hand FROM inventory_level WHERE variant_id = v.id AND warehouse_id = $3), 0)::int AS us
     FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder ORDER BY v.sku`,
    [A, EU, US],
  );
  return r.rows;
}

const level = async (variantId: string, warehouseId: string) =>
  (
    await owner.query<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_level WHERE variant_id = $1 AND warehouse_id = $2`,
      [variantId, warehouseId],
    )
  ).rows[0] ?? { on_hand: 0, reserved: 0, available: 0 };

const setStock = (variantId: string, eu: number, us: number) =>
  owner.query(
    `UPDATE inventory_level SET on_hand = CASE warehouse_id WHEN $2::uuid THEN $3::int ELSE $4::int END, reserved = 0
     WHERE variant_id = $1`,
    [variantId, EU, eu, us],
  );

beforeAll(async () => {
  db = await createTestDatabase('core_inventory');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  org = createTenantClient(db.app, {
    organizationId: ORG,
    storeIds: [A, B, SEED_IDS.stores.brandC],
  });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
  const opt = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  standardOptionId = opt.rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

afterEach(() => {
  setPaymentProvider(manualPaymentProvider);
});

/** A ready brand-a cart for the given variants/quantities; returns the cart id. */
async function readyCart(lines: { variantId: string; quantity: number }[]) {
  const i = n++;
  const cart = await createCart(a, scopeA);
  for (const l of lines)
    await addLineItem(a, cart.id, { variant_id: l.variantId, quantity: l.quantity });
  await updateCart(a, cart.id, {
    email: `inv+${i}@example.com`,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: standardOptionId,
  });
  await createPaymentSession(a, cart.id, { provider: 'manual' });
  return cart.id;
}

const place = (cartId: string) =>
  completeCart(a, { cartId, idempotencyKey: `inv-${cartId}`, actor: customer });

describe('moveStock', () => {
  it('locks the level, appends the movement, emits one stock.moved; refuses negative on_hand except for sales', async () => {
    const [v] = await variantsA();
    await setStock(v!.id, 5, 0);
    const before = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox WHERE topic = 'stock.moved'`,
    );
    const r = await a.transaction((tx) =>
      moveStock(tx, {
        organizationId: ORG,
        storeId: A,
        variantId: v!.id,
        warehouseId: EU,
        delta: 7,
        reason: 'receipt',
        note: 'PO-1',
        actor,
      }),
    );
    expect(r.level).toMatchObject({ on_hand: 12, reserved: 0, available: 12, sku: v!.sku });
    const after = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox WHERE topic = 'stock.moved'`,
    );
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(1);
    const ev = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = 'stock.moved' AND aggregate_id::text = $1::text`,
      [r.movementId],
    );
    expect(ev.rows[0]!.payload).toMatchObject({
      stock_movement_id: r.movementId,
      variant_id: v!.id,
      sku: v!.sku,
      warehouse_id: EU,
      delta: 7,
      reason: 'receipt',
      reference_type: null,
      on_hand_after: 12,
      reserved_after: 0,
    });
    const mv = await owner.query<{ delta: number; reason: string; note: string }>(
      `SELECT delta, reason, note FROM stock_movement WHERE id = $1`,
      [r.movementId],
    );
    expect(mv.rows[0]).toEqual({ delta: 7, reason: 'receipt', note: 'PO-1' });
    await expect(
      a.transaction((tx) =>
        moveStock(tx, {
          organizationId: ORG,
          storeId: A,
          variantId: v!.id,
          warehouseId: EU,
          delta: -13,
          reason: 'adjustment',
          actor,
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { on_hand: 12, delta: -13 } });
    await expect(
      a.transaction((tx) =>
        moveStock(tx, {
          organizationId: ORG,
          storeId: A,
          variantId: v!.id,
          warehouseId: EU,
          delta: 0,
          reason: 'adjustment',
          actor,
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_error' });
    // the app role may append but never update or delete a movement (0009)
    await expect(
      a.query(`UPDATE stock_movement SET note = 'x' WHERE id = $1`, [r.movementId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      a.query(`DELETE FROM stock_movement WHERE id = $1`, [r.movementId]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('reservations at placement', () => {
  it('allocates greedily by warehouse priority across warehouses; a reservation is not a movement', async () => {
    const vs = await variantsA();
    const v = vs[1]!;
    await setStock(v.id, 3, 10); // eu (priority/code first) has 3, us has 10
    const movementsBefore = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movement`,
    );
    const cartId = await readyCart([{ variantId: v.id, quantity: 5 }]);
    const { order } = await place(cartId);
    expect(await level(v.id, EU)).toMatchObject({ on_hand: 3, reserved: 3, available: 0 });
    expect(await level(v.id, US)).toMatchObject({ on_hand: 10, reserved: 2, available: 8 });
    const res = await owner.query<{ warehouse_id: string; quantity: number }>(
      `SELECT warehouse_id, quantity FROM reservation WHERE order_id = $1 AND released_at IS NULL ORDER BY quantity DESC`,
      [order.id],
    );
    expect(res.rows).toEqual([
      { warehouse_id: EU, quantity: 3 },
      { warehouse_id: US, quantity: 2 },
    ]);
    const movementsAfter = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movement`,
    );
    expect(movementsAfter.rows[0]!.n).toBe(movementsBefore.rows[0]!.n);
    // the Store API availability reflects the reservation
    const product = await getStoreProduct(a, A, 'EUR', v.handle);
    expect(product.variants.find((x) => x.id === v.id)).toMatchObject({
      in_stock: true,
      available_quantity: 8,
    });
  });

  it('non-backorderable shortfall → 409 out_of_stock and the whole placement rolls back (and the authorisation is voided)', async () => {
    const vs = await variantsA();
    const v = vs[2]!;
    await setStock(v.id, 5, 5); // enough at add time: the cart check passes …
    const calls: string[] = [];
    const logging: PaymentProvider = {
      ...manualPaymentProvider,
      async authorize(input) {
        calls.push('authorize');
        return manualPaymentProvider.authorize(input);
      },
      async void(input) {
        calls.push(
          `void:${input.providerPaymentId.startsWith('manpay_') ? 'ok' : 'bad'}:${input.reason}:${input.storeId === A && input.organizationId === ORG && !!input.cartId ? 'store' : 'nostore'}`,
        );
        return { status: 'voided' };
      },
    };
    setPaymentProvider(logging);
    const cartId = await readyCart([{ variantId: v.id, quantity: 3 }]);
    await setStock(v.id, 1, 1); // … then the stock vanishes before placement: the reservation is the real check
    await expect(place(cartId)).rejects.toMatchObject({
      code: 'out_of_stock',
      details: { variant_id: v.id, available: 2 },
    });
    // the void carries the store (window 7 resolves per-store credentials from it; the tx is being rolled back)
    expect(calls).toEqual(['authorize', 'void:ok:placement failed:store']);
    expect(
      (await owner.query(`SELECT 1 FROM "order" WHERE cart_id = $1`, [cartId])).rows,
    ).toHaveLength(0);
    expect(
      (await owner.query(`SELECT 1 FROM reservation WHERE variant_id = $1`, [v.id])).rows,
    ).toHaveLength(0);
    expect(await level(v.id, EU)).toMatchObject({ reserved: 0 });
    const cart = await owner.query<{ status: string }>(`SELECT status FROM cart WHERE id = $1`, [
      cartId,
    ]);
    expect(cart.rows[0]!.status).toBe('active');
    // a successful placement never voids
    calls.length = 0;
    await setStock(v.id, 5, 5);
    const ok = await readyCart([{ variantId: v.id, quantity: 3 }]);
    await place(ok);
    expect(calls).toEqual(['authorize']);
  });

  it('backorderable variant reserves anyway and available goes negative; available_quantity 0 but in_stock', async () => {
    const vs = await variantsA();
    const v = vs[3]!;
    await setStock(v.id, 1, 0);
    await owner.query(`UPDATE product_variant SET allow_backorder = true WHERE id = $1`, [v.id]);
    try {
      const cartId = await readyCart([{ variantId: v.id, quantity: 4 }]);
      await place(cartId);
      expect(await level(v.id, EU)).toMatchObject({ on_hand: 1, reserved: 4, available: -3 });
      expect(await level(v.id, US)).toMatchObject({ reserved: 0 });
      const product = await getStoreProduct(a, A, 'EUR', v.handle);
      expect(product.variants.find((x) => x.id === v.id)).toMatchObject({
        in_stock: true,
        available_quantity: 0,
        allow_backorder: true,
      });
    } finally {
      await owner.query(`UPDATE product_variant SET allow_backorder = false WHERE id = $1`, [v.id]);
    }
  });

  it('8 parallel placements on overlapping variants in shuffled order: no deadlock, every reservation accounted for', async () => {
    const vs = (await variantsA()).slice(4, 7);
    for (const v of vs) await setStock(v.id, 50, 50);
    const carts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        readyCart(
          [...vs]
            .sort(() => (i % 2 ? 1 : -1)) // alternate line order between carts → overlapping, differently ordered locks
            .map((v) => ({ variantId: v.id, quantity: 1 + (i % 3) })),
        ),
      ),
    );
    const results = await Promise.all(carts.map((c) => place(c)));
    expect(results).toHaveLength(8);
    for (const v of vs) {
      const reserved = (await level(v.id, EU)).reserved + (await level(v.id, US)).reserved;
      const expected = Array.from({ length: 8 }, (_, i) => 1 + (i % 3)).reduce((x, y) => x + y, 0);
      expect(reserved).toBe(expected);
    }
  });

  it('two placements racing for the last unit: exactly one succeeds, the other gets 409 out_of_stock', async () => {
    const v = (await variantsA())[7]!;
    await setStock(v.id, 1, 0);
    const [c1, c2] = await Promise.all([
      readyCart([{ variantId: v.id, quantity: 1 }]),
      readyCart([{ variantId: v.id, quantity: 1 }]),
    ]);
    const settled = await Promise.allSettled([place(c1!), place(c2!)]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const failed = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: 'out_of_stock', details: { available: 0 } });
    expect(await level(v.id, EU)).toMatchObject({ reserved: 1, available: 0 });
  });
});

describe('release and consume', () => {
  it('cancel through the orders module releases the reservation (idempotent); shipment consumes it with a sale movement', async () => {
    const vs = await variantsA();
    const v = vs[8]!;
    await setStock(v.id, 4, 4);
    const cartId = await readyCart([{ variantId: v.id, quantity: 6 }]);
    const { order } = await place(cartId);
    expect(await level(v.id, EU)).toMatchObject({ reserved: 4 });
    expect(await level(v.id, US)).toMatchObject({ reserved: 2 });
    await confirmOrder(a, order.id, actor);
    await cancelOrder(a, order.id, { reason: 'changed mind', actor });
    expect(await level(v.id, EU)).toMatchObject({ on_hand: 4, reserved: 0, available: 4 });
    expect(await level(v.id, US)).toMatchObject({ on_hand: 4, reserved: 0, available: 4 });
    expect(await a.transaction((tx) => releaseForOrder(tx, order.id))).toBe(0); // idempotent

    const w = vs[9]!;
    await setStock(w.id, 4, 4);
    const cart2 = await readyCart([{ variantId: w.id, quantity: 6 }]);
    const placed = await place(cart2);
    await expect(
      a.transaction((tx) =>
        consumeForShipment(tx, {
          organizationId: ORG,
          storeId: A,
          orderId: placed.order.id,
          lines: [{ variantId: w.id, quantity: 7 }],
          actor,
        }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { reserved: 6, requested: 7 } });
    const consumed = await a.transaction((tx) =>
      consumeForShipment(tx, {
        organizationId: ORG,
        storeId: A,
        orderId: placed.order.id,
        shipmentId: null,
        lines: [{ variantId: w.id, quantity: 5 }],
        actor,
      }),
    );
    expect(consumed.map((c) => ({ warehouseId: c.warehouseId, quantity: c.quantity }))).toEqual([
      { warehouseId: EU, quantity: 4 },
      { warehouseId: US, quantity: 1 },
    ]);
    expect(await level(w.id, EU)).toMatchObject({ on_hand: 0, reserved: 0, available: 0 });
    expect(await level(w.id, US)).toMatchObject({ on_hand: 3, reserved: 1, available: 2 });
    const sales = await owner.query<{
      delta: number;
      reason: string;
      reference_type: string;
      reference_id: string;
    }>(
      `SELECT delta, reason, reference_type, reference_id FROM stock_movement WHERE variant_id = $1 ORDER BY delta`,
      [w.id],
    );
    expect(sales.rows).toEqual([
      { delta: -4, reason: 'sale', reference_type: 'order', reference_id: placed.order.id },
      { delta: -1, reason: 'sale', reference_type: 'order', reference_id: placed.order.id },
    ]);
    const open = await owner.query<{ warehouse_id: string; quantity: number }>(
      `SELECT warehouse_id, quantity FROM reservation WHERE order_id = $1 AND released_at IS NULL`,
      [placed.order.id],
    );
    expect(open.rows).toEqual([{ warehouse_id: US, quantity: 1 }]);
  });
});

describe('admin services and RLS', () => {
  it('lists levels with filters, sort, pagination; a store client sees only its rows of the shared warehouses', async () => {
    const all = await listInventoryLevels(org, { limit: 5, sort: 'available', order: 'asc' });
    expect(all.total).toBeGreaterThan(5);
    expect(all.items).toHaveLength(5);
    const avail = all.items.map((i) => i.available);
    expect([...avail].sort((x, y) => x - y)).toEqual(avail);
    const onlyA = await listInventoryLevels(a, { limit: 100, warehouse_id: EU, sort: 'sku' });
    for (const i of onlyA.items) {
      expect(i.store_id).toBe(A);
      expect(i.warehouse_id).toBe(EU);
    }
    const onlyB = await listInventoryLevels(b, { limit: 100, warehouse_id: EU });
    for (const i of onlyB.items) expect(i.store_id).toBe(B);
    expect(onlyA.total + onlyB.total).toBeLessThanOrEqual(
      (await listInventoryLevels(org, { limit: 1, warehouse_id: EU })).total,
    );
    const [v] = await variantsA();
    const bySku = await listInventoryLevels(org, { sku: v!.sku });
    expect(bySku.items.every((i) => i.sku === v!.sku)).toBe(true);
    expect(bySku.items.map((i) => i.warehouse_id).sort()).toEqual([EU, US].sort());
    const low = await listInventoryLevels(org, { below_available: 1, limit: 100 });
    expect(low.items.every((i) => i.available < 1)).toBe(true);
    // store A's client cannot filter its way into store B's rows
    const cross = await listInventoryLevels(a, { store_id: B, limit: 100 });
    expect(cross.total).toBe(0);
  });

  it('createStockMovement (operations) adjusts on_hand and returns the InventoryLevel shape', async () => {
    const [v] = await variantsA();
    const before = await level(v!.id, US);
    const out = await createStockMovement(org, {
      organizationId: ORG,
      variantId: v!.id,
      warehouseId: US,
      delta: 3,
      reason: 'cycle_count',
      actor,
    });
    expect(out).toMatchObject({
      store_id: A,
      variant_id: v!.id,
      sku: v!.sku,
      warehouse_id: US,
      on_hand: before.on_hand + 3,
    });
    expect(out.available).toBe(out.on_hand - out.reserved);
  });
});

describe("window 8's port shapes (#191): consume / release per shipment, by order line item, idempotent", () => {
  it('consumeReservationsForShipment moves once per shipment; releaseReservationsForShipment reverses once', async () => {
    const vs = await variantsA();
    const v = vs[10]!;
    await setStock(v.id, 6, 6);
    const cartId = await readyCart([{ variantId: v.id, quantity: 4 }]);
    const { order } = await place(cartId);
    const line = order.items[0]!;
    const shipmentId = '80000000-0000-4000-8000-000000000042';
    const input = {
      organizationId: ORG,
      storeId: A,
      orderId: order.id,
      shipmentId,
      items: [{ orderLineItemId: line.id, quantity: 4 }],
      actor,
    };
    const first = await a.transaction((tx) => consumeReservationsForShipment(tx, input));
    expect(first.reduce((n, c) => n + c.quantity, 0)).toBe(4);
    expect(await level(v.id, EU)).toMatchObject({ on_hand: 2, reserved: 0 });
    const retry = await a.transaction((tx) => consumeReservationsForShipment(tx, input));
    expect(retry).toEqual([]);
    expect(await level(v.id, EU)).toMatchObject({ on_hand: 2, reserved: 0 });
    const sales = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movement WHERE reference_type = 'shipment' AND reference_id = $1`,
      [shipmentId],
    );
    expect(sales.rows[0]!.n).toBe('1');
    await expect(
      a.transaction((tx) =>
        consumeReservationsForShipment(tx, {
          ...input,
          items: [{ orderLineItemId: order.id, quantity: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // the planned shipment is cancelled before picking: goods back on hand, reservation re-opened, once
    const released = await a.transaction((tx) => releaseReservationsForShipment(tx, input));
    expect(released).toBe(4);
    expect(await level(v.id, EU)).toMatchObject({ on_hand: 6, reserved: 4, available: 2 });
    const again = await a.transaction((tx) => releaseReservationsForShipment(tx, input));
    expect(again).toBe(0);
    expect(await level(v.id, EU)).toMatchObject({ on_hand: 6, reserved: 4 });
    const open = await owner.query<{ quantity: number }>(
      `SELECT quantity FROM reservation WHERE order_id = $1 AND released_at IS NULL`,
      [order.id],
    );
    expect(open.rows.reduce((n, r) => n + r.quantity, 0)).toBe(4);
  });
});
