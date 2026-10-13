// The SHARED stock pool (#456; db 0190 + 0191, CONTRACT CHANGE #453) on a seeded throwaway database: two brands
// whose variants map ONE stock item sell from one pool row. Everything a store does here runs as a STORE-SCOPED
// client of the application role (`a`, `b`) — row security is part of what is tested; `hq` is organization scope of
// the same role (the HQ admin); `owner` only arranges fixtures and reads what no session may see.
import { createValidator } from '@platform/events';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import { createVariant, getStoreProduct } from '../catalog';
import { completeCart, createPaymentSession } from '../checkout';
import {
  availableByVariant,
  consumeForShipment,
  consumeReservationsForShipment,
  createStockMovement,
  ensureLevel,
  listInventoryLevels,
  listStockItems,
  mapVariantToStockItem,
  moveStock,
  priorityGreedyPolicy,
  releaseReservationsForShipment,
  reserveForOrder,
  setAllocationPolicy,
  type AllocationPolicy,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const EU = SEED_IDS.warehouses.eu;
const US = SEED_IDS.warehouses.us;
const actor = { id: SEED_IDS.users.operations, type: 'staff' as const, requestId: 'req-pool' };
const customer = { id: null, type: 'customer' as const, requestId: 'req-pool' };

type Tenant = ReturnType<typeof createTenantClient>;
interface Shop {
  storeId: string;
  client: Tenant;
  scope: { organizationId: string; storeId: string; salesChannelId: string | null };
  optionId: string;
  currency: string;
  address: Record<string, string>;
}
interface V {
  id: string;
  sku: string;
  handle: string;
  item: string;
}

let db: TestDatabase;
let a: Tenant;
let b: Tenant;
let hq: ReturnType<typeof createOrganizationClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let shopA: Shop;
let shopB: Shop;
let va: V[];
let vb: V[];
let n = 0;

const variantsOf = async (storeId: string, currency: string): Promise<V[]> =>
  (
    await owner.query<V>(
      `SELECT v.id, v.sku, p.handle, v.stock_item_id AS item
       FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
       JOIN price pr ON pr.variant_id = v.id AND pr.currency = $2 AND pr.min_quantity = 1
       WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder ORDER BY v.sku`,
      [storeId, currency],
    )
  ).rows;

/** Fixture: the pool row numbers of one stock item (owner role; the module never does this). */
const setPool = (stockItemId: string, eu: number, us: number) =>
  owner.query(
    `UPDATE inventory_level SET on_hand = CASE warehouse_id WHEN $2::uuid THEN $3::int ELSE $4::int END, reserved = 0
     WHERE stock_item_id = $1`,
    [stockItemId, EU, eu, us],
  );

const pool = async (stockItemId: string, warehouseId: string) =>
  (
    await owner.query<{ on_hand: number; reserved: number; available: number }>(
      `SELECT on_hand, reserved, available FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`,
      [stockItemId, warehouseId],
    )
  ).rows[0] ?? { on_hand: 0, reserved: 0, available: 0 };

const itemOf = async (variantId: string) =>
  (
    await owner.query<{ stock_item_id: string }>(
      `SELECT stock_item_id FROM product_variant WHERE id = $1`,
      [variantId],
    )
  ).rows[0]!.stock_item_id;

const count = async (sql: string, params: unknown[] = []) =>
  Number(
    (await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!.n,
  );

async function shopOf(
  storeId: string,
  client: Tenant,
  currency: string,
  country: string,
): Promise<Shop> {
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [storeId],
  );
  const option = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [storeId],
  );
  return {
    storeId,
    client,
    scope: { organizationId: ORG, storeId, salesChannelId: channel.rows[0]!.id },
    optionId: option.rows[0]!.id,
    currency,
    address: {
      first_name: 'Jane',
      last_name: 'Doe',
      line1: 'Main Street 1',
      city: country === 'GB' ? 'London' : 'Amsterdam',
      postal_code: country === 'GB' ? 'N1 9GU' : '1015 CJ',
      country,
    },
  };
}

/** A cart in `shop` that only needs completing (through that store's own client). */
async function ready(
  shop: Shop,
  lines: { variantId: string; quantity: number }[],
): Promise<string> {
  const i = n++;
  const cart = await createCart(shop.client, shop.scope);
  for (const l of lines) {
    await addLineItem(shop.client, cart.id, { variant_id: l.variantId, quantity: l.quantity });
  }
  await updateCart(shop.client, cart.id, {
    email: `pool+${i}@example.com`,
    shipping_address: shop.address,
    billing_address: shop.address,
    shipping_option_id: shop.optionId,
  });
  await createPaymentSession(shop.client, cart.id, { provider: 'manual' });
  return cart.id;
}

const complete = (shop: Shop, cartId: string) =>
  completeCart(shop.client, { cartId, idempotencyKey: `pool-${cartId}`, actor: customer });

/** A ready cart in `shop` and its placement, all through that store's own client. */
const place = async (shop: Shop, lines: { variantId: string; quantity: number }[]) =>
  complete(shop, await ready(shop, lines));

/** Maps brand B's variant onto brand A's variant's item (HQ, organization scope), emptying B's own item first. */
async function share(vA: V, vB: V): Promise<string> {
  await setPool(vB.item, 0, 0);
  await mapVariantToStockItem(hq, { stockItemId: vA.item, variantId: vB.id, actor });
  return vA.item;
}

beforeAll(async () => {
  db = await createTestDatabase('core_shared_pool');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  shopA = await shopOf(A, a, 'EUR', 'NL');
  shopB = await shopOf(B, b, 'GBP', 'GB');
  // index 0 is left alone: a seed may already share the brands' first variants
  va = (await variantsOf(A, 'EUR')).slice(1);
  vb = (await variantsOf(B, 'GBP')).slice(1);
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

afterEach(() => {
  setAllocationPolicy(priorityGreedyPolicy);
});

describe('mapVariantToStockItem (HQ, organization scope)', () => {
  it('409 while the variant’s current item holds stock; organization scope only; unknown ids are 404', async () => {
    const vA = va[0]!;
    const vB = vb[0]!;
    await setPool(vB.item, 4, 3);
    await expect(
      mapVariantToStockItem(hq, { stockItemId: vA.item, variantId: vB.id, actor }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { stock_item_id: vB.item, on_hand: 7, open_reservations: 0 },
    });
    expect(await itemOf(vB.id)).toBe(vB.item);
    // a store session may not map — not even its own variant (the module refuses; the database guard would too)
    await expect(
      mapVariantToStockItem(b, { stockItemId: vA.item, variantId: vB.id, actor }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      b.query(`UPDATE product_variant SET stock_item_id = $1 WHERE id = $2`, [vA.item, vB.id]),
    ).rejects.toMatchObject({ code: '42501' });
    const unknown = '00000000-0000-4000-8000-00000000ffff';
    await expect(
      mapVariantToStockItem(hq, { stockItemId: unknown, variantId: vB.id, actor }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      mapVariantToStockItem(hq, { stockItemId: vA.item, variantId: unknown, actor }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps once: the item lists both variants; audit + stock_item.mapped v1; the repeat writes nothing; one availability', async () => {
    const vA = va[0]!;
    const vB = vb[0]!;
    await setPool(vA.item, 6, 2);
    await setPool(vB.item, 0, 0);
    const item = await mapVariantToStockItem(hq, { stockItemId: vA.item, variantId: vB.id, actor });
    expect(item).toMatchObject({ id: vA.item, sku: vA.sku });
    expect(item.variants).toEqual(
      expect.arrayContaining([
        { variant_id: vA.id, store_id: A, sku: vA.sku },
        { variant_id: vB.id, store_id: B, sku: vB.sku },
      ]),
    );
    expect(item.levels.map((l) => [l.warehouse_id, l.on_hand, l.available])).toEqual([
      [EU, 6, 6],
      [US, 2, 2],
    ]);
    expect(await itemOf(vB.id)).toBe(vA.item);

    const audit = await owner.query<{
      action: string;
      store_id: string;
      before: unknown;
      after: unknown;
    }>(
      `SELECT action, store_id, before, after FROM audit_log WHERE entity_id = $1 AND action = 'variant.stock_item_mapped'`,
      [vB.id],
    );
    expect(audit.rows).toEqual([
      {
        action: 'variant.stock_item_mapped',
        store_id: B,
        before: { stock_item_id: vB.item },
        after: { stock_item_id: vA.item },
      },
    ]);
    const ev = await owner.query<{
      store_id: string;
      version: number;
      aggregate_type: string;
      aggregate_id: string;
      payload: unknown;
    }>(
      `SELECT store_id, version, aggregate_type, aggregate_id, payload FROM outbox
       WHERE topic = 'stock_item.mapped' AND payload->>'variant_id' = $1`,
      [vB.id],
    );
    expect(ev.rows).toEqual([
      {
        store_id: B,
        version: 1,
        aggregate_type: 'stock_item',
        aggregate_id: vA.item,
        payload: {
          stock_item_id: vA.item,
          previous_stock_item_id: vB.item,
          variant_id: vB.id,
          store_id: B,
        },
      },
    ]);
    expect(createValidator().validatePayload('stock_item.mapped', 1, ev.rows[0]!.payload).ok).toBe(
      true,
    );

    // idempotent: already mapped → the item again, nothing written
    const audits = await count('audit_log');
    const events = await count('outbox');
    const again = await mapVariantToStockItem(hq, {
      stockItemId: vA.item,
      variantId: vB.id,
      actor,
    });
    expect(again.id).toBe(vA.item);
    expect(await count('audit_log')).toBe(audits);
    expect(await count('outbox')).toBe(events);

    // both stores now see ONE availability — each through its own client and its own variant
    const seenByA = await a.transaction((tx) => availableByVariant(tx, [vA.id]));
    const seenByB = await b.transaction((tx) => availableByVariant(tx, [vB.id]));
    expect(seenByA.get(vA.id)).toBe(8);
    expect(seenByB.get(vB.id)).toBe(8);
    const shared = await listStockItems(hq, { shared: true, limit: 100 });
    expect(shared.items.map((i) => i.id)).toContain(vA.item);
    expect((await listStockItems(hq, { sku: vA.sku })).items.map((i) => i.id)).toEqual([vA.item]);
    expect(
      (await listStockItems(hq, { store_id: B, shared: true, limit: 100 })).items.map((i) => i.id),
    ).toContain(vA.item);
    await expect(listStockItems(a)).rejects.toMatchObject({ code: 'forbidden' });
    // the Admin level list: one row per (variant, warehouse); the two variants repeat the pool row's id
    const levels = await listInventoryLevels(hq, { warehouse_id: EU, sku: vA.sku });
    const rowA = levels.items.find((l) => l.variant_id === vA.id)!;
    const rowB = (await listInventoryLevels(hq, { warehouse_id: EU, variant_id: vB.id })).items[0]!;
    expect(rowB).toMatchObject({
      id: rowA.id,
      stock_item_id: vA.item,
      store_id: B,
      sku: vB.sku,
      on_hand: 6,
    });
  });

  it('409 while the current item has an open reservation, even with nothing on hand', async () => {
    const vB = vb[1]!;
    const target = va[1]!;
    await setPool(vB.item, 2, 0);
    const { order } = await place(shopB, [{ variantId: vB.id, quantity: 1 }]);
    await owner.query(`UPDATE inventory_level SET on_hand = 0 WHERE stock_item_id = $1`, [vB.item]);
    await expect(
      mapVariantToStockItem(hq, { stockItemId: target.item, variantId: vB.id, actor }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { stock_item_id: vB.item, on_hand: 0, open_reservations: 1 },
    });
    // the reservation names the item its variant mapped WHEN it was reserved, and still maps
    const r = await owner.query<{ stock_item_id: string; allocation_rule: string }>(
      `SELECT stock_item_id, allocation_rule FROM reservation WHERE order_id = $1`,
      [order.id],
    );
    expect(r.rows).toEqual([{ stock_item_id: vB.item, allocation_rule: 'priority' }]);
  });
});

describe('two stores, one pool row (store-scoped clients)', () => {
  it('store A reserves N and store B’s availability drops by N — in the availability read and in the Store API product', async () => {
    const vA = va[2]!;
    const vB = vb[2]!;
    const shared = await share(vA, vB);
    await setPool(shared, 5, 0);
    const before = await getStoreProduct(b, B, 'GBP', vB.handle);
    expect(before.variants.find((x) => x.id === vB.id)).toMatchObject({
      in_stock: true,
      available_quantity: 5,
    });

    const { order } = await place(shopA, [{ variantId: vA.id, quantity: 3 }]);

    expect(await pool(shared, EU)).toEqual({ on_hand: 5, reserved: 3, available: 2 });
    expect((await b.transaction((tx) => availableByVariant(tx, [vB.id]))).get(vB.id)).toBe(2);
    const after = await getStoreProduct(b, B, 'GBP', vB.handle);
    expect(after.variants.find((x) => x.id === vB.id)).toMatchObject({
      in_stock: true,
      available_quantity: 2,
    });
    // B sees the pool's `reserved` total on its own level row — never WHO reserved
    const levelB = (await listInventoryLevels(b, { variant_id: vB.id, warehouse_id: EU }))
      .items[0]!;
    expect(levelB).toMatchObject({ store_id: B, reserved: 3, available: 2 });
    expect(
      (await b.query(`SELECT 1 FROM reservation WHERE order_id = $1`, [order.id])).rowCount,
    ).toBe(0);
    expect(
      (await b.query(`SELECT 1 FROM reservation WHERE stock_item_id = $1`, [shared])).rowCount,
    ).toBe(0);
    expect(
      (await a.query(`SELECT 1 FROM reservation WHERE order_id = $1`, [order.id])).rowCount,
    ).toBe(1);
    // the reservation: who (store A + its variant), which pool row, and why that warehouse
    const r = await owner.query(
      `SELECT store_id, variant_id, stock_item_id, warehouse_id, quantity, allocation_rule FROM reservation WHERE order_id = $1`,
      [order.id],
    );
    expect(r.rows).toEqual([
      {
        store_id: A,
        variant_id: vA.id,
        stock_item_id: shared,
        warehouse_id: EU,
        quantity: 3,
        allocation_rule: 'priority',
      },
    ]);
  });

  it('neither store reads the other’s movements, nor a movement no store caused; HQ sees all', async () => {
    const vA = va[3]!;
    const vB = vb[3]!;
    const shared = await share(vA, vB);
    await setPool(shared, 6, 0);
    const placedA = await place(shopA, [{ variantId: vA.id, quantity: 2 }]);
    const placedB = await place(shopB, [{ variantId: vB.id, quantity: 1 }]);
    // each store ships its own order: a `sale` movement attributed to that store, written in its own scope
    const [soldA] = await a.transaction((tx) =>
      consumeForShipment(tx, {
        organizationId: ORG,
        storeId: A,
        orderId: placedA.order.id,
        lines: [{ variantId: vA.id, quantity: 2 }],
        actor,
      }),
    );
    const [soldB] = await b.transaction((tx) =>
      consumeForShipment(tx, {
        organizationId: ORG,
        storeId: B,
        orderId: placedB.order.id,
        lines: [{ variantId: vB.id, quantity: 1 }],
        actor,
      }),
    );
    // HQ receives goods: a pool movement no store caused
    await createStockMovement(hq, {
      organizationId: ORG,
      variantId: vA.id,
      warehouseId: EU,
      delta: 10,
      reason: 'receipt',
      actor,
    });
    expect(await pool(shared, EU)).toEqual({ on_hand: 13, reserved: 0, available: 13 });

    const seen = async (client: Tenant | typeof hq) =>
      (
        await client.query<{ id: string; store_id: string | null; delta: number }>(
          `SELECT id, store_id, delta FROM stock_movement WHERE stock_item_id = $1 ORDER BY created_at, id`,
          [shared],
        )
      ).rows;
    expect(await seen(a)).toEqual([{ id: soldA!.movementId, store_id: A, delta: -2 }]);
    expect(await seen(b)).toEqual([{ id: soldB!.movementId, store_id: B, delta: -1 }]);
    expect((await seen(hq)).map((m) => [m.store_id, m.delta])).toEqual([
      [A, -2],
      [B, -1],
      [null, 10],
    ]);
    // the outbox rows follow the same rule: a store never reads another store's event, nor a store-less one
    const events = async (client: Tenant | typeof hq) =>
      (
        await client.query<{ store_id: string | null }>(
          `SELECT store_id FROM outbox WHERE topic = 'stock.moved' AND payload->>'stock_item_id' = $1 ORDER BY seq`,
          [shared],
        )
      ).rows.map((r) => r.store_id);
    expect(await events(a)).toEqual([A]);
    expect(await events(b)).toEqual([B]);
    expect(await events(hq)).toEqual([A, B, null]);
  });

  it('the last unit goes to exactly one of two placements racing from the two stores', async () => {
    const vA = va[4]!;
    const vB = vb[4]!;
    const shared = await share(vA, vB);
    for (let round = 0; round < 3; round++) {
      await setPool(shared, 1, 0);
      const results = await Promise.allSettled([
        place(shopA, [{ variantId: vA.id, quantity: 1 }]),
        place(shopB, [{ variantId: vB.id, quantity: 1 }]),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]!.reason).toMatchObject({ code: 'out_of_stock', details: { available: 0 } });
      expect(await pool(shared, EU)).toEqual({ on_hand: 1, reserved: 1, available: 0 });
    }
  });

  it('placements from two stores on two shared items in opposite orders: no deadlock, every unit accounted for', async () => {
    const x = await share(va[5]!, vb[5]!);
    const y = await share(va[6]!, vb[6]!);
    await setPool(x, 40, 0);
    await setPool(y, 40, 0);
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      jobs.push(
        place(shopA, [
          { variantId: va[5]!.id, quantity: 1 },
          { variantId: va[6]!.id, quantity: 2 },
        ]),
        place(shopB, [
          { variantId: vb[6]!.id, quantity: 1 },
          { variantId: vb[5]!.id, quantity: 2 },
        ]),
      );
    }
    const results = await Promise.allSettled(jobs);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await pool(x, EU)).toEqual({ on_hand: 40, reserved: 12, available: 28 });
    expect(await pool(y, EU)).toEqual({ on_hand: 40, reserved: 12, available: 28 });
    // every open reservation holds the item its variant maps (the module's invariant; no constraint says it)
    expect(
      await count(
        `reservation r JOIN product_variant v ON v.id = r.variant_id
         WHERE r.released_at IS NULL AND r.stock_item_id <> v.stock_item_id`,
      ),
    ).toBe(0);
  }, 60_000);
});

describe('fail closed: what a store session cannot do', () => {
  it('a placement on a variant that is not the store’s — an item it does not map — writes nothing', async () => {
    const foreign = vb[7]!; // brand B only: brand A maps nothing on this item
    const reservations = await count('reservation');
    const movements = await count('stock_movement');
    const before = await pool(foreign.item, EU);
    await expect(
      a.transaction((tx) =>
        reserveForOrder(tx, {
          organizationId: ORG,
          storeId: A,
          orderId: '00000000-0000-4000-8000-00000000aaaa',
          lines: [{ variantId: foreign.id, quantity: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_error', details: { variant_id: foreign.id } });
    // naming the pool row directly does not help either: the item is invisible, nothing is created
    await expect(
      a.transaction((tx) =>
        ensureLevel(tx, { organizationId: ORG, stockItemId: foreign.item, warehouseId: EU }, true),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      a.transaction((tx) =>
        moveStock(tx, {
          organizationId: ORG,
          storeId: B,
          variantId: foreign.id,
          warehouseId: EU,
          delta: -1,
          reason: 'sale',
          actor,
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      (await a.query(`SELECT 1 FROM inventory_level WHERE stock_item_id = $1`, [foreign.item]))
        .rowCount,
    ).toBe(0);
    expect(await count('reservation')).toBe(reservations);
    expect(await count('stock_movement')).toBe(movements);
    expect(await pool(foreign.item, EU)).toEqual(before);
  });

  it('a movement no store caused is refused in store scope by the database — on an item the store maps, too', async () => {
    const vA = va[8]!;
    await setPool(vA.item, 5, 0);
    const movements = await count('stock_movement');
    const events = await count(`outbox WHERE topic = 'stock.moved'`);
    await expect(
      a.transaction((tx) =>
        moveStock(tx, {
          organizationId: ORG,
          stockItemId: vA.item,
          warehouseId: EU,
          delta: 4,
          reason: 'receipt',
          actor,
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    // the raw statement is refused by the ledger policy itself (this is what the 403 above translates)
    await expect(
      a.query(
        `INSERT INTO stock_movement (organization_id, stock_item_id, warehouse_id, delta, reason)
         VALUES ($1, $2, $3, 4, 'receipt')`,
        [ORG, vA.item, EU],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // and so is a movement attributed to ANOTHER store, on a row the session can otherwise reach
    await expect(
      a.query(
        `INSERT INTO stock_movement (organization_id, store_id, variant_id, stock_item_id, warehouse_id, delta, reason)
         VALUES ($1, $2, $3, $4, $5, -1, 'sale')`,
        [ORG, B, vb[8]!.id, vA.item, EU],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      moveStock(a as never, {
        organizationId: ORG,
        storeId: A,
        variantId: null,
        stockItemId: vA.item,
        warehouseId: EU,
        delta: 1,
        reason: 'receipt',
        actor,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' }); // attribution is a store AND its variant, or neither
    expect(await pool(vA.item, EU)).toEqual({ on_hand: 5, reserved: 0, available: 5 });
    expect(await count('stock_movement')).toBe(movements);
    expect(await count(`outbox WHERE topic = 'stock.moved'`)).toBe(events);
  });

  it('the module never writes a store-less movement from a store’s flows: every sale and release is attributed', async () => {
    expect(
      await count(
        `stock_movement WHERE (store_id IS NULL OR variant_id IS NULL) AND reason IN ('sale', 'return')`,
      ),
    ).toBe(0);
    expect(
      await count(`stock_movement WHERE reference_type = 'shipment_release' AND store_id IS NULL`),
    ).toBe(0);
  });
});

describe('stock.moved v2', () => {
  it('validates for a sale (attributed) and for an organization-scope receipt (store-less): one outbox row per movement, same transaction', async () => {
    const vA = va[9]!;
    await setPool(vA.item, 5, 0);
    const validator = createValidator();
    const placed = await place(shopA, [{ variantId: vA.id, quantity: 2 }]);
    const [sold] = await a.transaction((tx) =>
      consumeForShipment(tx, {
        organizationId: ORG,
        storeId: A,
        orderId: placed.order.id,
        lines: [{ variantId: vA.id, quantity: 2 }],
        actor,
      }),
    );
    const received = await hq.transaction((tx) =>
      moveStock(tx, {
        organizationId: ORG,
        stockItemId: vA.item,
        warehouseId: EU,
        delta: 7,
        reason: 'receipt',
        referenceType: 'purchase_order',
        actor,
      }),
    );
    const eventOf = async (movementId: string) =>
      (
        await owner.query<{
          store_id: string | null;
          version: number;
          payload: Record<string, unknown>;
        }>(
          `SELECT store_id, version, payload FROM outbox WHERE topic = 'stock.moved' AND aggregate_id = $1`,
          [movementId],
        )
      ).rows;

    const sale = await eventOf(sold!.movementId);
    expect(sale).toHaveLength(1);
    expect(sale[0]).toMatchObject({ store_id: A, version: 2 });
    expect(sale[0]!.payload).toEqual({
      stock_movement_id: sold!.movementId,
      stock_item_id: vA.item,
      sku: vA.sku,
      variant_id: vA.id,
      store_id: A,
      warehouse_id: EU,
      delta: -2,
      reason: 'sale',
      reference_type: 'order',
      reference_id: placed.order.id,
      on_hand_after: 3,
      reserved_after: 0,
    });
    expect(validator.validatePayload('stock.moved', 2, sale[0]!.payload)).toEqual({
      ok: true,
      errors: [],
    });

    const receipt = await eventOf(received.movementId);
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ store_id: null, version: 2 });
    expect(receipt[0]!.payload).toEqual({
      stock_movement_id: received.movementId,
      stock_item_id: vA.item,
      sku: vA.sku,
      warehouse_id: EU,
      delta: 7,
      reason: 'receipt',
      reference_type: 'purchase_order',
      reference_id: null,
      on_hand_after: 10,
      reserved_after: 0,
    });
    expect(validator.validatePayload('stock.moved', 2, receipt[0]!.payload)).toEqual({
      ok: true,
      errors: [],
    });
    // half an attribution is not a v2 payload
    expect(
      validator.validatePayload('stock.moved', 2, { ...receipt[0]!.payload, variant_id: vA.id }).ok,
    ).toBe(false);

    // same transaction: a movement whose transaction rolls back leaves no event and no ledger row
    const movements = await count('stock_movement');
    const events = await count(`outbox WHERE topic = 'stock.moved'`);
    await expect(
      hq.transaction(async (tx) => {
        await moveStock(tx, {
          organizationId: ORG,
          stockItemId: vA.item,
          warehouseId: EU,
          delta: 1,
          reason: 'receipt',
          actor,
        });
        throw new Error('rolled back on purpose');
      }),
    ).rejects.toThrow('rolled back on purpose');
    expect(await count('stock_movement')).toBe(movements);
    expect(await count(`outbox WHERE topic = 'stock.moved'`)).toBe(events);
    expect(await pool(vA.item, EU)).toMatchObject({ on_hand: 10 });
  });
});

describe('the allocation seam on the pool (#454)', () => {
  it('a policy that splits a line across two warehouses → two reservations with their rules', async () => {
    const vA = va[10]!;
    await setPool(vA.item, 5, 5);
    const split: AllocationPolicy = (_context, lines) =>
      lines.map((line) => ({
        variantId: line.variantId,
        allocations: [
          { warehouseId: US, quantity: 1, rule: 'same_country' },
          { warehouseId: EU, quantity: line.quantity - 1, rule: 'split:same_country' },
        ],
        shortfall: 0,
      }));
    setAllocationPolicy(split);
    const { order } = await place(shopA, [{ variantId: vA.id, quantity: 3 }]);
    const r = await owner.query(
      `SELECT warehouse_id, quantity, allocation_rule FROM reservation WHERE order_id = $1 ORDER BY quantity`,
      [order.id],
    );
    expect(r.rows).toEqual([
      { warehouse_id: US, quantity: 1, allocation_rule: 'same_country' },
      { warehouse_id: EU, quantity: 2, allocation_rule: 'split:same_country' },
    ]);
    expect(await pool(vA.item, US)).toMatchObject({ reserved: 1 });
    expect(await pool(vA.item, EU)).toMatchObject({ reserved: 2 });
  });

  it('the policy is told the truth: locked numbers, every active warehouse, the destination and the store’s routing', async () => {
    const vA = va[11]!;
    await setPool(vA.item, 4, 0);
    await owner.query(
      `DELETE FROM inventory_level WHERE stock_item_id = $1 AND warehouse_id = $2`,
      [vA.item, US],
    );
    let seen: Parameters<AllocationPolicy> | undefined;
    setAllocationPolicy((context, lines) => {
      seen = [context, lines];
      return priorityGreedyPolicy(context, lines);
    });
    const { order } = await place(shopA, [{ variantId: vA.id, quantity: 1 }]);
    const [context, lines] = seen!;
    expect(context).toMatchObject({
      organizationId: ORG,
      storeId: A,
      orderId: order.id,
      destinationCountry: 'NL',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      variantId: vA.id,
      stockItemId: vA.item,
      quantity: 1,
      allowBackorder: false,
    });
    // wh-us has no pool row for this item: offered anyway, with nothing available
    expect(lines[0]!.candidates.map((c) => [c.warehouseId, c.available])).toEqual([
      [EU, 4],
      [US, 0],
    ]);
  });

  it('an over-allocation or a warehouse that was not offered is a 500 and the placement rolls back', async () => {
    const vA = va[12]!;
    await setPool(vA.item, 2, 0);
    const reservations = await count('reservation');
    const orders = await count('"order"');
    setAllocationPolicy((_context, lines) =>
      lines.map((line) => ({
        variantId: line.variantId,
        allocations: [{ warehouseId: EU, quantity: line.quantity, rule: 'greedy-beyond-stock' }],
        shortfall: 0,
      })),
    );
    await expect(place(shopA, [{ variantId: vA.id, quantity: 2 }])).resolves.toBeDefined(); // honest: 2 of 2
    await setPool(vA.item, 2, 5);
    // the cart check passes (7 available in total); the policy then puts all 3 on a warehouse that has 2
    await expect(place(shopA, [{ variantId: vA.id, quantity: 3 }])).rejects.toMatchObject({
      code: 'internal',
      status: 500,
      details: { available: 2, allocated: 3 },
    });
    setAllocationPolicy((_context, lines) =>
      lines.map((line) => ({
        variantId: line.variantId,
        allocations: [
          {
            warehouseId: '00000000-0000-4000-8000-0000000000ee',
            quantity: line.quantity,
            rule: 'x',
          },
        ],
        shortfall: 0,
      })),
    );
    await expect(place(shopA, [{ variantId: vA.id, quantity: 1 }])).rejects.toMatchObject({
      code: 'internal',
      status: 500,
    });
    expect(await count('reservation')).toBe(reservations + 1);
    expect(await count('"order"')).toBe(orders + 1);
    expect(await pool(vA.item, EU)).toMatchObject({ reserved: 0 }); // setPool reset it; nothing reserved since
  });
});

describe('variant creation (the catalog, in store scope)', () => {
  it('a new variant gets its own stock item from the database; the same sku in another brand gets a prefixed item; a store cannot arrive mapped', async () => {
    const productOf = async (storeId: string) =>
      (
        await owner.query<{ id: string }>(
          `SELECT id FROM product WHERE store_id = $1 ORDER BY handle LIMIT 1`,
          [storeId],
        )
      ).rows[0]!.id;
    // the catalog inserts with stock_item_id unset, as a store session; 0191's trigger gives the variant its item
    const mine = await createVariant(
      a,
      A,
      await productOf(A),
      { sku: 'POOL-NEW-1', title: 'Pool new' },
      actor,
    );
    const item = await a.query<{ id: string; sku: string }>(
      `SELECT si.id, si.sku FROM stock_item si JOIN product_variant v ON v.stock_item_id = si.id WHERE v.id = $1`,
      [mine.id],
    );
    expect(item.rows).toEqual([{ id: expect.any(String), sku: 'POOL-NEW-1' }]); // visible to its own store
    expect(
      (await b.query(`SELECT 1 FROM stock_item WHERE id = $1`, [item.rows[0]!.id])).rowCount,
    ).toBe(0);
    // one item per variant, never an automatic merge: brand B's variant with the same sku gets `<store>:<sku>`
    const theirs = await createVariant(
      b,
      B,
      await productOf(B),
      { sku: 'POOL-NEW-1', title: 'Pool new' },
      actor,
    );
    const other = await owner.query<{ id: string; sku: string }>(
      `SELECT si.id, si.sku FROM stock_item si JOIN product_variant v ON v.stock_item_id = si.id WHERE v.id = $1`,
      [theirs.id],
    );
    expect(other.rows[0]!.sku).toBe('brand-b:POOL-NEW-1');
    expect(other.rows[0]!.id).not.toBe(item.rows[0]!.id);

    // nothing in stock yet; HQ receives, the store sells from its own new pool row
    expect((await a.transaction((tx) => availableByVariant(tx, [mine.id]))).get(mine.id)).toBe(0);
    await createStockMovement(hq, {
      organizationId: ORG,
      variantId: mine.id,
      warehouseId: EU,
      delta: 5,
      reason: 'receipt',
      actor,
    });
    expect((await a.transaction((tx) => availableByVariant(tx, [mine.id]))).get(mine.id)).toBe(5);
    expect((await b.transaction((tx) => availableByVariant(tx, [theirs.id]))).get(theirs.id)).toBe(
      0,
    );

    // a store session cannot insert a variant that already points at an item — its own or anybody's (0190's guard)
    await expect(
      a.query(
        `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title, stock_item_id)
         SELECT organization_id, store_id, product_id, 'POOL-NEW-2', 'x', $2 FROM product_variant WHERE id = $1`,
        [mine.id, other.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('one lock order for every path that touches more than one pool row (#459 review)', () => {
  it('a shipment release and a placement that would take two shared pool rows in OPPOSITE order: no deadlock, every unit accounted for', async () => {
    // Two brand A variants whose VARIANT ids and STOCK ITEM ids sort in opposite directions: a path that locks in
    // variant order and one that locks in stock-item order would take the two pool rows in opposite order.
    const candidates = va.slice(13, 40);
    let p: V | undefined;
    let q: V | undefined;
    for (let i = 0; i < candidates.length && !p; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const first = candidates[i]!;
        const second = candidates[j]!;
        if (first.id < second.id && first.item > second.item) {
          p = first;
          q = second;
          break;
        }
      }
    }
    expect(p, 'a pair of variants with opposite id / item order').toBeDefined();
    const bp = vb[13]!;
    const bq = vb[14]!;
    await share(p!, bp);
    await share(q!, bq);
    await setPool(p!.item, 50, 0);
    await setPool(q!.item, 50, 0);

    // store A: one order of both variants, planned as a shipment (its reservations consumed)
    const { order } = await place(shopA, [
      { variantId: p!.id, quantity: 1 },
      { variantId: q!.id, quantity: 1 },
    ]);
    const shipment = {
      organizationId: ORG,
      storeId: A,
      orderId: order.id,
      shipmentId: '80000000-0000-4000-8000-000000000199',
      items: order.items.map((i) => ({ orderLineItemId: i.id, quantity: i.quantity })),
      actor,
    };
    await a.transaction((tx) => consumeReservationsForShipment(tx, shipment));
    // store B: a cart on the same two items, ready to be placed
    const cartB = await ready(shopB, [
      { variantId: bq.id, quantity: 1 },
      { variantId: bp.id, quantity: 1 },
    ]);

    const waiting = async () =>
      Number(
        (
          await db.owner.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          )
        ).rows[0]!.n,
      );
    const until = async (done: () => Promise<boolean>, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !(await done())) await new Promise((r) => setTimeout(r, 25));
    };

    // The gate: a third session holds the SECOND variant's row. A release that worked variant by variant would
    // stop right here — AFTER taking the first pool row, BEFORE the second. That is the moment the placement runs.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const holder = owner.transaction(async (tx) => {
      await tx.query(`SELECT id FROM product_variant WHERE id = $1 FOR UPDATE`, [q!.id]);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 100)); // the holder has its lock
    const release = a.transaction((tx) => releaseReservationsForShipment(tx, shipment));
    await until(async () => (await waiting()) >= 1, 5_000); // the release is parked behind the gate
    let placed = false;
    const placement = complete(shopB, cartB).finally(() => (placed = true));
    // one order for everybody: the placement is not behind the release — it finishes while the release still waits
    await until(async () => placed || (await waiting()) >= 2, 5_000);
    open();
    await holder;

    const results = await Promise.allSettled([release, placement]);
    const failed = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => `${(r.reason as { code?: string }).code}: ${(r.reason as Error).message}`);
    expect(failed).toEqual([]); // opposite lock orders end here as 40P01 "deadlock detected"
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 2 });
    // every unit accounted for: the released units are back on hand and reserved again by A's order; B holds one
    expect(await pool(p!.item, EU)).toEqual({ on_hand: 50, reserved: 2, available: 48 });
    expect(await pool(q!.item, EU)).toEqual({ on_hand: 50, reserved: 2, available: 48 });
  }, 60_000);

  it('a backorder never creates a pool row in the middle of a placement: two backorderable lines, parallel placements, no deadlock', async () => {
    const x = va[41]!;
    const y = va[42]!;
    await owner.query(`UPDATE product_variant SET allow_backorder = true WHERE id = ANY($1)`, [
      [x.id, y.id],
    ]);
    // nothing in stock anywhere and no pool rows at all: every placement is a backorder on the priority warehouse
    await owner.query(`DELETE FROM inventory_level WHERE stock_item_id = ANY($1)`, [
      [x.item, y.item],
    ]);
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(
        place(shopA, [
          { variantId: i % 2 ? x.id : y.id, quantity: 1 },
          { variantId: i % 2 ? y.id : x.id, quantity: 1 },
        ]),
      );
    }
    const results = await Promise.allSettled(jobs);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await pool(x.item, EU)).toEqual({ on_hand: 0, reserved: 6, available: -6 });
    expect(await pool(y.item, EU)).toEqual({ on_hand: 0, reserved: 6, available: -6 });
    const rules = await owner.query<{ allocation_rule: string }>(
      `SELECT DISTINCT allocation_rule FROM reservation WHERE stock_item_id = ANY($1)`,
      [[x.item, y.item]],
    );
    expect(rules.rows).toEqual([{ allocation_rule: 'backorder' }]);
  }, 60_000);
});

describe('a shipment release after the variant was re-mapped (#459 review)', () => {
  it('is refused with 409 in the store’s own scope — before the ledger is read — and writes nothing', async () => {
    const v = va[43]!;
    const target = va[44]!;
    await setPool(v.item, 2, 0);
    const { order } = await place(shopA, [{ variantId: v.id, quantity: 2 }]);
    const shipmentId = '80000000-0000-4000-8000-000000000299';
    const input = {
      organizationId: ORG,
      storeId: A,
      orderId: order.id,
      shipmentId,
      items: order.items.map((i) => ({ orderLineItemId: i.id, quantity: i.quantity })),
      actor,
    };
    await a.transaction((tx) => consumeReservationsForShipment(tx, input));
    expect(await pool(v.item, EU)).toEqual({ on_hand: 0, reserved: 0, available: 0 });
    // HQ re-maps the variant: allowed, its item is empty and holds no open reservation
    await mapVariantToStockItem(hq, { stockItemId: target.item, variantId: v.id, actor });
    // the store no longer maps the old item: its own sale movement there is invisible to it (pool_ledger) …
    expect(
      (await a.query(`SELECT 1 FROM stock_movement WHERE reference_id = $1`, [shipmentId]))
        .rowCount,
    ).toBe(0);
    expect(await count(`stock_movement WHERE reference_id = $1`, [shipmentId])).toBe(1);

    const movements = await count('stock_movement');
    const reservations = await count('reservation');
    // … so the release must not answer "nothing to release": it is a conflict, said explicitly
    await expect(
      a.transaction((tx) => releaseReservationsForShipment(tx, input)),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { variant_id: v.id, stock_item_id: v.item, current_stock_item_id: target.item },
    });
    expect(await count('stock_movement')).toBe(movements);
    expect(await count('reservation')).toBe(reservations);
    expect(await pool(v.item, EU)).toEqual({ on_hand: 0, reserved: 0, available: 0 });
  });
});
