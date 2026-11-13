// Admin API order line-item edits (#855): `updateOrderLineItem` (PATCH) and `cancelOrderLineItem` (DELETE) on
// /admin/stores/{storeId}/orders/{orderId}/line-items/{lineItemId}, through the exact chain src/server.ts mounts,
// over a seeded throwaway database. Money is checked in minor units for a two-decimal (EUR, brand A) and a
// zero-decimal (JPY, brand D) order; the removed units' reservations are released; one `order.updated` per edit,
// in the same transaction as the change (a failure after the line update leaves nothing behind).
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier, moduleAdminRouters, moduleWebhookRouters } from '../src/http';
import { closePool, initDb, tenantClient } from '../src/lib/db';
import {
  addLineItem,
  createCart,
  currentTaxCalculator,
  setTaxCalculator,
  taxOn,
  updateCart,
} from '../src/modules/cart';
import { completeCart, createPaymentSession } from '../src/modules/checkout';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const A = SEED_IDS.stores.brandA;
const D = SEED_IDS.stores.brandD;
const spec = specValidator('admin-api.yaml');
const guest = { id: null, type: 'customer' as const, requestId: 'req-855' };

let db: TestDatabase;
let app: express.Express;

const as = (subject: string) => ({
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer dev:${subject}`),
});
const owner = as('seed-owner');
const storeAdmin = as('seed-store-admin');
const storeStaff = as('seed-store-staff');

interface Placed {
  orderId: string;
  lines: { id: string; variant_id: string; quantity: number; unit_price_minor: number }[];
}

/** Places one order in `storeId` with the given (variant, quantity) lines through the cart + checkout modules. */
async function place(
  storeId: string,
  lines: { variantId: string; quantity: number }[],
  address: Record<string, string>,
): Promise<Placed> {
  const client = tenantClient({ organizationId: SEED_IDS.organization, storeIds: [storeId] });
  const channel = await client.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [storeId],
  );
  const cart = await createCart(client, {
    organizationId: SEED_IDS.organization,
    storeId,
    salesChannelId: channel.rows[0]!.id,
  });
  for (const l of lines) {
    await addLineItem(client, cart.id, { variant_id: l.variantId, quantity: l.quantity });
  }
  const option = await client.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [storeId],
  );
  await updateCart(client, cart.id, {
    email: 'edits-855@example.com',
    shipping_address: address,
    billing_address: address,
    shipping_option_id: option.rows[0]!.id,
  });
  await createPaymentSession(client, cart.id, { provider: 'manual' });
  const { order } = await completeCart(client, {
    cartId: cart.id,
    idempotencyKey: `edits-855-${cart.id}`,
    actor: guest,
  });
  const rows = await db.owner.query<Placed['lines'][number]>(
    `SELECT id, variant_id, quantity, unit_price_minor::int AS unit_price_minor
     FROM order_line_item WHERE order_id = $1 ORDER BY created_at, id`,
    [order.id],
  );
  return { orderId: order.id, lines: rows.rows };
}

/** Published, priced, in-stock variants of a store in the currency, cheapest-sku order. */
async function variants(storeId: string, currency: string, n: number, price?: number) {
  const r = await db.owner.query<{ id: string; stock_item_id: string }>(
    `SELECT v.id, v.stock_item_id FROM product_variant v
     JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = $2 AND pr.min_quantity = 1
       AND ($4::bigint IS NULL OR pr.amount_minor = $4)
     WHERE v.store_id = $1
       AND (SELECT sum(il.available) FROM inventory_level il WHERE il.stock_item_id = v.stock_item_id) >= 10
     GROUP BY v.id, v.stock_item_id, v.sku
     ORDER BY v.sku LIMIT $3`,
    [storeId, currency, n, price ?? null],
  );
  expect(r.rows).toHaveLength(n);
  return r.rows;
}

/** The order and its lines as stored, money as numbers. */
async function stored(orderId: string) {
  const o = await db.owner.query<{
    subtotal_minor: string;
    discount_minor: string;
    shipping_minor: string;
    tax_minor: string;
    total_minor: string;
    currency: string;
  }>(
    `SELECT subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor, currency FROM "order"
     WHERE id = $1`,
    [orderId],
  );
  const l = await db.owner.query<{
    id: string;
    quantity: number;
    unit_price_minor: string;
    discount_minor: string;
    tax_rate_bp: number;
    tax_minor: string;
    total_minor: string;
  }>(
    `SELECT id, quantity, unit_price_minor, discount_minor, tax_rate_bp, tax_minor, total_minor
     FROM order_line_item WHERE order_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  const n = (v: string) => Number(v);
  return {
    order: {
      subtotal: n(o.rows[0]!.subtotal_minor),
      discount: n(o.rows[0]!.discount_minor),
      shipping: n(o.rows[0]!.shipping_minor),
      tax: n(o.rows[0]!.tax_minor),
      total: n(o.rows[0]!.total_minor),
      currency: o.rows[0]!.currency,
    },
    lines: l.rows.map((r) => ({
      id: r.id,
      quantity: r.quantity,
      unit: n(r.unit_price_minor),
      discount: n(r.discount_minor),
      bp: r.tax_rate_bp,
      tax: n(r.tax_minor),
      total: n(r.total_minor),
    })),
  };
}

/**
 * The totals an order MUST have, recomputed here from its stored lines with the one rounding rule (tax-exclusive
 * stores: tax on top, half up, per line and on shipping) — independent of the module's own arithmetic.
 */
function expectExactTotals(s: Awaited<ReturnType<typeof stored>>, shippingBp: number) {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  for (const l of s.lines) {
    const base = l.quantity * l.unit - l.discount;
    expect(l.tax).toBe(taxOn(base, l.bp));
    expect(l.total).toBe(base + l.tax);
    subtotal += l.quantity * l.unit;
    discount += l.discount;
    tax += l.tax;
  }
  tax += taxOn(s.order.shipping, shippingBp);
  expect(s.order).toMatchObject({ subtotal, discount, tax });
  expect(s.order.total).toBe(subtotal - discount + s.order.shipping + tax);
  for (const v of [subtotal, discount, tax, s.order.total, ...s.lines.map((l) => l.total)]) {
    expect(Number.isInteger(v)).toBe(true);
  }
}

/** Open reservation quantity for (order, variant), and the pool's `reserved` total for the stock item. */
async function reservedFor(orderId: string, variantId: string, stockItemId: string) {
  const open = await db.owner.query<{ q: number }>(
    `SELECT coalesce(sum(quantity), 0)::int AS q FROM reservation
     WHERE order_id = $1 AND variant_id = $2 AND released_at IS NULL`,
    [orderId, variantId],
  );
  const pool = await db.owner.query<{ q: number }>(
    `SELECT coalesce(sum(reserved), 0)::int AS q FROM inventory_level WHERE stock_item_id = $1`,
    [stockItemId],
  );
  return { open: open.rows[0]!.q, pool: pool.rows[0]!.q };
}

async function orderUpdatedRows(orderId: string) {
  const r = await db.owner.query<{ payload: { changed_fields: string[] }; version: number }>(
    `SELECT payload, version FROM outbox WHERE topic = 'order.updated' AND aggregate_id::text = $1
     ORDER BY occurred_at, id`,
    [orderId],
  );
  return r.rows;
}

const NL = {
  first_name: 'Edit',
  last_name: 'Line',
  line1: 'Dam 1',
  city: 'Amsterdam',
  postal_code: '1012 JS',
  country: 'NL',
};
const JP = {
  first_name: 'Edit',
  last_name: 'Line',
  line1: '1-1 Marunouchi',
  city: 'Tokyo',
  postal_code: '100-0005',
  country: 'JP',
};

beforeAll(async () => {
  db = await createTestDatabase('core_order_line_edits');
  await seed(db.owner, { productsPerStore: 12, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = SEED_IDS.organization;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    moduleRouters: moduleAdminRouters(),
    webhookRouters: moduleWebhookRouters(),
  });
});

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('updateOrderLineItem / cancelOrderLineItem (#855)', () => {
  it('EUR (two decimals): lower 3 → 1, then cancel the other line — exact totals, reservations released, one order.updated each', async () => {
    const [v1, v2] = await variants(A, 'EUR', 2);
    const placed = await place(
      A,
      [
        { variantId: v1!.id, quantity: 3 },
        { variantId: v2!.id, quantity: 2 },
      ],
      NL,
    );
    const line1 = placed.lines.find((l) => l.variant_id === v1!.id)!;
    const line2 = placed.lines.find((l) => l.variant_id === v2!.id)!;
    const before = await stored(placed.orderId);
    const shippingBp = 0; // the seed does not tax shipping (the table provider's default, settings.tax)
    expectExactTotals(before, shippingBp);
    const r1 = await reservedFor(placed.orderId, v1!.id, v1!.stock_item_id);
    expect(r1.open).toBe(3);
    const events0 = (await orderUpdatedRows(placed.orderId)).length;

    const lowered = await storeAdmin.patch(
      `/admin/stores/${A}/orders/${placed.orderId}/line-items/${line1.id}`,
      { quantity: 1 },
    );
    expect(lowered.status).toBe(200);
    spec.assertSchema('Order', lowered.body);
    const after = await stored(placed.orderId);
    expectExactTotals(after, shippingBp);
    expect(after.lines.find((l) => l.id === line1.id)!.quantity).toBe(1);
    // the answer is the stored order, to the minor unit
    expect(lowered.body.totals.total).toEqual({ amount_minor: after.order.total, currency: 'EUR' });
    expect(lowered.body.totals.tax.amount_minor).toBe(after.order.tax);
    // the difference is recorded for the refund flow, exactly
    expect(lowered.body.metadata.edits).toEqual([
      expect.objectContaining({
        line_item_id: line1.id,
        from_quantity: 3,
        to_quantity: 1,
        delta_minor: before.order.total - after.order.total,
      }),
    ]);
    expect(before.order.total - after.order.total).toBe(
      2 * line1.unit_price_minor + taxOn(2 * line1.unit_price_minor, before.lines[0]!.bp),
    );
    // 2 units released: the order's open reservation and the pool's reserved both drop by exactly 2
    const r1b = await reservedFor(placed.orderId, v1!.id, v1!.stock_item_id);
    expect(r1b).toEqual({ open: 1, pool: r1.pool - 2 });
    // one order.updated (events contract v1), in the edit's transaction
    const events1 = await orderUpdatedRows(placed.orderId);
    expect(events1).toHaveLength(events0 + 1);
    expect(events1.at(-1)!.payload.changed_fields).toEqual(
      expect.arrayContaining([
        'line_items',
        'subtotal_minor',
        'tax_minor',
        'total_minor',
        'metadata',
      ]),
    );

    const r2 = await reservedFor(placed.orderId, v2!.id, v2!.stock_item_id);
    expect(r2.open).toBe(2);
    const cancelled = await storeAdmin.delete(
      `/admin/stores/${A}/orders/${placed.orderId}/line-items/${line2.id}`,
    );
    expect(cancelled.status).toBe(200);
    spec.assertSchema('Order', cancelled.body);
    expect(cancelled.body.items.map((i: { id: string }) => i.id)).toEqual([line1.id]);
    const final = await stored(placed.orderId);
    expectExactTotals(final, shippingBp);
    expect(await reservedFor(placed.orderId, v2!.id, v2!.stock_item_id)).toEqual({
      open: 0,
      pool: r2.pool - 2,
    });
    expect(await orderUpdatedRows(placed.orderId)).toHaveLength(events0 + 2);
    expect(cancelled.body.metadata.edits).toHaveLength(2);

    // the last line cannot be cancelled: 409, nothing changes
    const last = await storeAdmin.delete(
      `/admin/stores/${A}/orders/${placed.orderId}/line-items/${line1.id}`,
    );
    expect(last.status).toBe(409);
    spec.assertSchema('Error', last.body);
    expect(await stored(placed.orderId)).toEqual(final);
    expect(await orderUpdatedRows(placed.orderId)).toHaveLength(events0 + 2);
  });

  it('JPY (zero decimals, brand D): ¥1,980 × 3 → 1 — whole yen everywhere, JCT 10% exact', async () => {
    const [yen] = await variants(D, 'JPY', 1, 1980);
    const [other] = (await variants(D, 'JPY', 3)).filter((v) => v.id !== yen!.id);
    const placed = await place(
      D,
      [
        { variantId: yen!.id, quantity: 3 },
        { variantId: other!.id, quantity: 1 },
      ],
      JP,
    );
    const line = placed.lines.find((l) => l.variant_id === yen!.id)!;
    expect(line.unit_price_minor).toBe(1980);
    const before = await stored(placed.orderId);
    expect(before.order.currency).toBe('JPY');
    expect(before.order.shipping).toBe(990); // standard, whole yen
    expectExactTotals(before, 0); // the seed does not tax shipping
    const pool0 = await reservedFor(placed.orderId, yen!.id, yen!.stock_item_id);

    const res = await owner.patch(
      `/admin/stores/${D}/orders/${placed.orderId}/line-items/${line.id}`,
      { quantity: 1 },
    );
    expect(res.status).toBe(200);
    spec.assertSchema('Order', res.body);
    const after = await stored(placed.orderId);
    expectExactTotals(after, 0);
    const edited = after.lines.find((l) => l.id === line.id)!;
    // ¥1,980 × 1, JCT 10% on top: ¥198 → ¥2,178; the order drops by ¥3,960 + ¥396 = ¥4,356
    expect(edited).toMatchObject({ quantity: 1, bp: 1000, tax: 198, total: 2178 });
    expect(before.order.total - after.order.total).toBe(4356);
    expect(res.body.metadata.edits).toEqual([
      expect.objectContaining({ from_quantity: 3, to_quantity: 1, delta_minor: 4356 }),
    ]);
    expect(res.body.totals.total).toEqual({ amount_minor: after.order.total, currency: 'JPY' });
    expect(await reservedFor(placed.orderId, yen!.id, yen!.stock_item_id)).toEqual({
      open: 1,
      pool: pool0.pool - 2,
    });
  });

  it('400 / 403 / 404 / 409 per the contract', async () => {
    const [v1, v2] = await variants(A, 'EUR', 2);
    const placed = await place(
      A,
      [
        { variantId: v1!.id, quantity: 2 },
        { variantId: v2!.id, quantity: 1 },
      ],
      NL,
    );
    const line = placed.lines.find((l) => l.variant_id === v1!.id)!;
    const path = `/admin/stores/${A}/orders/${placed.orderId}/line-items/${line.id}`;

    // 403: store_staff has viewer, not store_admin (checked before the body)
    expect((await storeStaff.patch(path, { quantity: 1 })).status).toBe(403);
    expect((await storeStaff.delete(path)).status).toBe(403);
    // 400: body validation against the spec, and the module's "only down" rule
    for (const bad of [{}, { quantity: 0 }, { quantity: 1.5 }, { quantity: '1' }]) {
      const r = await storeAdmin.patch(path, bad);
      expect(r.status).toBe(400);
      spec.assertSchema('Error', r.body);
    }
    expect((await storeAdmin.patch(path, { quantity: 2 })).status).toBe(400); // not lower
    expect((await storeAdmin.patch(path, { quantity: 5 })).status).toBe(400); // up
    expect(
      (
        await storeAdmin.patch(`/admin/stores/${A}/orders/${placed.orderId}/line-items/nope`, {
          quantity: 1,
        })
      ).status,
    ).toBe(400);
    // 404: an unknown line; the order through another store's path (brand B: store_admin's other store)
    const unknown = await storeAdmin.delete(
      `/admin/stores/${A}/orders/${placed.orderId}/line-items/00000000-0000-4000-8000-000000000855`,
    );
    expect(unknown.status).toBe(404);
    spec.assertSchema('Error', unknown.body);
    const viaB = await owner.patch(
      `/admin/stores/${SEED_IDS.stores.brandB}/orders/${placed.orderId}/line-items/${line.id}`,
      { quantity: 1 },
    );
    expect(viaB.status).toBe(404);
    // 409: a shipment is planned for the order (its lines are allocated to a parcel)
    const shipment = await db.owner.query<{ id: string }>(
      `INSERT INTO shipment (organization_id, store_id, order_id, warehouse_id, currency)
       VALUES ($1, $2, $3, $4, 'EUR') RETURNING id`,
      [SEED_IDS.organization, A, placed.orderId, SEED_IDS.warehouses.eu],
    );
    const planned = await storeAdmin.patch(path, { quantity: 1 });
    expect(planned.status).toBe(409);
    spec.assertSchema('Error', planned.body);
    expect(planned.body.details).toMatchObject({ field: 'shipments' });
    await db.owner.query(`UPDATE shipment SET status = 'cancelled' WHERE id = $1`, [
      shipment.rows[0]!.id,
    ]);
    // 409: fulfilled
    await db.owner.query(`UPDATE "order" SET fulfillment_status = 'fulfilled' WHERE id = $1`, [
      placed.orderId,
    ]);
    const fulfilled = await storeAdmin.delete(path);
    expect(fulfilled.status).toBe(409);
    expect(fulfilled.body.details).toMatchObject({ field: 'fulfillment_status' });
    await db.owner.query(`UPDATE "order" SET fulfillment_status = 'unfulfilled' WHERE id = $1`, [
      placed.orderId,
    ]);
    // a cancelled shipment does not block: the edit goes through
    expect((await storeAdmin.patch(path, { quantity: 1 })).status).toBe(200);
  });

  it('one transaction: a failure after the line update leaves the line, the reservations, the totals and the outbox untouched', async () => {
    const [v1, v2] = await variants(A, 'EUR', 2);
    const placed = await place(
      A,
      [
        { variantId: v1!.id, quantity: 3 },
        { variantId: v2!.id, quantity: 1 },
      ],
      NL,
    );
    const line = placed.lines.find((l) => l.variant_id === v1!.id)!;
    const before = await stored(placed.orderId);
    const res0 = await reservedFor(placed.orderId, v1!.id, v1!.stock_item_id);
    const events0 = await orderUpdatedRows(placed.orderId);
    const real = currentTaxCalculator();
    // the recompute runs AFTER the line update and the reservation release
    setTaxCalculator({
      calculate: async () => {
        throw new Error('tax provider down (#855 test)');
      },
    });
    try {
      const r = await storeAdmin.patch(
        `/admin/stores/${A}/orders/${placed.orderId}/line-items/${line.id}`,
        { quantity: 1 },
      );
      expect(r.status).toBe(500);
      const d = await storeAdmin.delete(
        `/admin/stores/${A}/orders/${placed.orderId}/line-items/${line.id}`,
      );
      expect(d.status).toBe(500);
    } finally {
      setTaxCalculator(real);
    }
    expect(await stored(placed.orderId)).toEqual(before);
    expect(await reservedFor(placed.orderId, v1!.id, v1!.stock_item_id)).toEqual(res0);
    expect(await orderUpdatedRows(placed.orderId)).toEqual(events0);
  });
});
