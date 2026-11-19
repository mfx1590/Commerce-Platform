// #887: audit rows for order mutations (entity_type 'order'), written in the mutation's own transaction by the one
// mutation path (`transition()`) and by placement. Each mutation writes exactly one row with its actor — a staff user
// by id, a customer or the system named as such — ids, statuses and quantities only (no email, no address); a
// mutation that rolls back or is refused writes none.
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier, moduleAdminRouters } from '../src/http';
import { closePool, initDb, tenantClient } from '../src/lib/db';
import {
  addLineItem,
  createCart,
  currentTaxCalculator,
  setTaxCalculator,
  updateCart,
} from '../src/modules/cart';
import { completeCart, createPaymentSession } from '../src/modules/checkout';
import { markPaymentCaptured, markReturned, markShipped, transition } from '../src/modules/orders';
import { mountCoreMiddleware } from '../src/server';

const A = SEED_IDS.stores.brandA;
const customer = { id: null, type: 'customer' as const, requestId: 'req-887' };
const system = { id: null, type: 'system' as const, requestId: 'req-887' };
const EMAIL = `audit-887-${randomUUID().slice(0, 8)}@example.com`;
const ADDRESS = {
  first_name: 'Auditha',
  last_name: 'Rowland',
  line1: 'Herengracht 887',
  city: 'Amsterdam',
  postal_code: '1017 BZ',
  country: 'NL',
};

let db: TestDatabase;
let app: express.Express;
let storeAdminId: string;

const staff = (subject: string) => ({
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer dev:${subject}`),
});
const storeAdmin = staff('seed-store-admin');

interface AuditRow {
  action: string;
  actor_type: string;
  actor_id: string | null;
  entity_type: string;
  entity_id: string;
  store_id: string | null;
  request_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

async function auditOf(orderId: string): Promise<AuditRow[]> {
  const r = await db.owner.query<AuditRow>(
    `SELECT action, actor_type, actor_id, entity_type, entity_id, store_id, request_id, before, after
     FROM audit_log WHERE entity_type = 'order' AND entity_id = $1 ORDER BY created_at, id`,
    [orderId],
  );
  return r.rows;
}

/** One placed brand-A order (manual provider: authorised at placement) with two lines of 2. */
async function place(
  actor: { id: string | null; type: 'customer'; requestId: string } = customer,
): Promise<{ orderId: string; lines: { id: string; quantity: number }[] }> {
  const client = tenantClient({ organizationId: SEED_IDS.organization, storeIds: [A] });
  const channel = await db.owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  const variants = await db.owner.query<{ id: string }>(
    `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder
       AND (SELECT sum(il.available) FROM inventory_level il WHERE il.stock_item_id = v.stock_item_id) >= 10
     GROUP BY v.id, v.sku ORDER BY v.sku LIMIT 2`,
    [A],
  );
  const cart = await createCart(client, {
    organizationId: SEED_IDS.organization,
    storeId: A,
    salesChannelId: channel.rows[0]!.id,
  });
  for (const v of variants.rows)
    await addLineItem(client, cart.id, { variant_id: v.id, quantity: 2 });
  const option = await db.owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  await updateCart(client, cart.id, {
    email: EMAIL,
    shipping_address: ADDRESS,
    billing_address: ADDRESS,
    shipping_option_id: option.rows[0]!.id,
  });
  await createPaymentSession(client, cart.id, { provider: 'manual' });
  const { order } = await completeCart(client, {
    cartId: cart.id,
    idempotencyKey: `audit-887-${cart.id}`,
    actor,
  });
  const lines = await db.owner.query<{ id: string; quantity: number }>(
    `SELECT id, quantity FROM order_line_item WHERE order_id = $1 ORDER BY created_at, id`,
    [order.id],
  );
  return { orderId: order.id, lines: lines.rows };
}

/** No row of the order carries the customer's email or any part of the address. */
function expectNoPii(rows: AuditRow[]) {
  const text = JSON.stringify(rows.map((r) => [r.before, r.after]));
  for (const pii of [
    EMAIL,
    ADDRESS.first_name,
    ADDRESS.last_name,
    ADDRESS.line1,
    ADDRESS.postal_code,
  ]) {
    expect(text).not.toContain(pii);
  }
}

beforeAll(async () => {
  db = await createTestDatabase('core_order_audit');
  await seed(db.owner, { productsPerStore: 12, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = SEED_IDS.organization;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), { moduleRouters: moduleAdminRouters() });
  storeAdminId = (
    await db.owner.query<{ id: string }>(
      `SELECT id FROM staff_user WHERE keycloak_subject = 'seed-store-admin'`,
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('order audit rows (#887)', () => {
  it('placement: one order.place row by the CUSTOMER (named as such, no id), then the automatic confirm by the same actor', async () => {
    const { orderId } = await place();
    const rows = await auditOf(orderId);
    expect(rows.map((r) => r.action)).toEqual(['order.place', 'order.status_change']);
    expect(rows[0]).toMatchObject({
      actor_type: 'customer',
      actor_id: null,
      entity_type: 'order',
      entity_id: orderId,
      store_id: A,
      request_id: 'req-887',
    });
    expect(Object.keys(rows[0]!.after!).sort()).toEqual(
      ['cart_id', 'currency', 'display_id', 'line_count', 'payment_provider', 'total_minor'].sort(),
    );
    expect(rows[0]!.after).toMatchObject({
      currency: 'EUR',
      line_count: 2,
      payment_provider: 'manual',
    });
    expect(rows[1]).toMatchObject({
      actor_type: 'customer',
      before: { status: 'pending' },
      after: { status: 'confirmed', changed_fields: ['status'] },
    });
    expectNoPii(rows);
  });

  it('a signed-in customer places it: actor_id is the CUSTOMER id (only a guest has NULL)', async () => {
    const customerId = randomUUID();
    const { orderId } = await place({ id: customerId, type: 'customer', requestId: 'req-887' });
    const rows = await auditOf(orderId);
    expect(rows.map((r) => [r.action, r.actor_type, r.actor_id])).toEqual([
      ['order.place', 'customer', customerId],
      ['order.status_change', 'customer', customerId],
    ]);
  });

  it('shipments and returns write one row each, also when no status moves (a second partial shipment / return)', async () => {
    const { orderId, lines } = await place();
    const client = tenantClient({ organizationId: SEED_IDS.organization, storeIds: [A] });
    const [l1, l2] = lines;
    const n = (await auditOf(orderId)).length;
    // 1st: confirmed → processing, unfulfilled → partially_fulfilled (a transition)
    await markShipped(client, orderId, [{ lineItemId: l1!.id, quantity: 1 }], system);
    // 2nd: still processing / partially_fulfilled — only the line's fulfilled quantity moves (no transition)
    await markShipped(client, orderId, [{ lineItemId: l1!.id, quantity: 1 }], system);
    // 3rd: → fulfilled
    await markShipped(client, orderId, [{ lineItemId: l2!.id, quantity: 2 }], system);
    // returns: 1 unit (→ partially_returned), then 1 more of another line (stays partially_returned)
    await markReturned(client, orderId, [{ lineItemId: l1!.id, quantity: 1 }], system);
    await markReturned(client, orderId, [{ lineItemId: l2!.id, quantity: 1 }], system);
    const rows = (await auditOf(orderId)).slice(n);
    expect(rows.map((r) => r.action)).toEqual([
      'order.ship',
      'order.ship',
      'order.ship',
      'order.return',
      'order.return',
    ]);
    expect(rows[0]).toMatchObject({
      actor_type: 'system',
      before: { status: 'confirmed', fulfillment_status: 'unfulfilled' },
      after: { status: 'processing', fulfillment_status: 'partially_fulfilled' },
    });
    expect(rows[1]).toMatchObject({
      before: {},
      after: { lines: [{ line_item_id: l1!.id, quantity: 1 }], changed_fields: ['line_items'] },
    });
    expect(rows[4]).toMatchObject({
      before: {},
      after: { lines: [{ line_item_id: l2!.id, quantity: 1 }], changed_fields: ['line_items'] },
    });
    expectNoPii(rows);
  });

  it('a transition that throws AFTER its audit row was written (hooks.afterEvents) leaves no row', async () => {
    const { orderId } = await place();
    const n = (await auditOf(orderId)).length;
    const client = tenantClient({ organizationId: SEED_IDS.organization, storeIds: [A] });
    await expect(
      client.transaction((tx) =>
        transition(tx, orderId, {
          payment_status: 'captured',
          actor: system,
          hooks: {
            afterEvents: async () => {
              throw new Error('boom after the audit write (#887 test)');
            },
          },
        }),
      ),
    ).rejects.toThrow(/boom after the audit write/);
    expect((await auditOf(orderId)).length).toBe(n);
  });

  it('a capture (window 7 calls markPaymentCaptured): one order.status_change row, payment_status authorized → captured, by the SYSTEM', async () => {
    const { orderId } = await place();
    const n = (await auditOf(orderId)).length;
    await markPaymentCaptured(
      tenantClient({ organizationId: SEED_IDS.organization, storeIds: [A] }),
      orderId,
      system,
    );
    const rows = (await auditOf(orderId)).slice(n);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'order.status_change',
        actor_type: 'system',
        actor_id: null,
        before: { payment_status: 'authorized' },
        after: { payment_status: 'captured', changed_fields: ['payment_status'] },
      }),
    ]);
  });

  it('cancel by a store admin: one order.cancel row (staff id, previous status, reason) after the void’s own payment_status row', async () => {
    const { orderId } = await place();
    const n = (await auditOf(orderId)).length;
    const res = await storeAdmin.post(`/admin/stores/${A}/orders/${orderId}/cancel`, {
      reason: 'customer asked by phone',
    });
    expect(res.status).toBe(200);
    const rows = (await auditOf(orderId)).slice(n);
    expect(rows.map((r) => r.action)).toEqual(['order.status_change', 'order.cancel']);
    expect(rows[0]).toMatchObject({
      actor_type: 'staff',
      actor_id: storeAdminId,
      before: { payment_status: 'authorized' },
      after: { payment_status: 'voided' },
    });
    expect(rows[1]).toMatchObject({
      actor_type: 'staff',
      actor_id: storeAdminId,
      before: { status: 'confirmed' },
      after: {
        status: 'cancelled',
        reason: 'customer asked by phone',
        changed_fields: ['cancel_reason', 'cancelled_at', 'status'],
      },
    });
    expect(rows.filter((r) => r.action === 'order.cancel')).toHaveLength(1);
    // re-cancel changes nothing and writes nothing
    expect(
      (await storeAdmin.post(`/admin/stores/${A}/orders/${orderId}/cancel`, { reason: 'x' }))
        .status,
    ).toBe(200);
    expect((await auditOf(orderId)).length).toBe(n + 2);
    expectNoPii(await auditOf(orderId));
  });

  it('line edits (switch on, payment awaiting): one order.line_item_update and one order.line_item_cancel, with the line and the quantities', async () => {
    process.env.ORDER_LINE_EDITS_ENABLED = '1';
    try {
      const { orderId, lines } = await place();
      // module-level state: no public flow leaves a placed order un-authorised (#855 review)
      await db.owner.query(`UPDATE "order" SET payment_status = 'awaiting' WHERE id = $1`, [
        orderId,
      ]);
      const n = (await auditOf(orderId)).length;
      const [l1, l2] = lines;
      expect(
        (
          await storeAdmin.patch(`/admin/stores/${A}/orders/${orderId}/line-items/${l1!.id}`, {
            quantity: 1,
          })
        ).status,
      ).toBe(200);
      expect(
        (await storeAdmin.delete(`/admin/stores/${A}/orders/${orderId}/line-items/${l2!.id}`))
          .status,
      ).toBe(200);
      const rows = (await auditOf(orderId)).slice(n);
      expect(rows).toEqual([
        expect.objectContaining({
          action: 'order.line_item_update',
          actor_type: 'staff',
          actor_id: storeAdminId,
          before: {},
          after: expect.objectContaining({
            line_item_id: l1!.id,
            from_quantity: 2,
            to_quantity: 1,
          }),
        }),
        expect.objectContaining({
          action: 'order.line_item_cancel',
          actor_id: storeAdminId,
          after: expect.objectContaining({
            line_item_id: l2!.id,
            from_quantity: 2,
            to_quantity: 0,
          }),
        }),
      ]);
      expect(rows[0]!.after!.changed_fields).toEqual(
        expect.arrayContaining(['line_items', 'metadata']),
      );
      expectNoPii(rows);
    } finally {
      delete process.env.ORDER_LINE_EDITS_ENABLED;
    }
  });

  it('a mutation that rolls back writes no row; a refused one neither', async () => {
    process.env.ORDER_LINE_EDITS_ENABLED = '1';
    const real = currentTaxCalculator();
    try {
      const { orderId, lines } = await place();
      await db.owner.query(`UPDATE "order" SET payment_status = 'awaiting' WHERE id = $1`, [
        orderId,
      ]);
      const n = (await auditOf(orderId)).length;
      // rolled back: the tax recompute throws after the line update
      setTaxCalculator({
        calculate: async () => {
          throw new Error('tax provider down (#887 test)');
        },
      });
      const failed = await storeAdmin.patch(
        `/admin/stores/${A}/orders/${orderId}/line-items/${lines[0]!.id}`,
        { quantity: 1 },
      );
      expect(failed.status).toBe(500);
      setTaxCalculator(real);
      expect((await auditOf(orderId)).length).toBe(n);
      // refused: a fulfilled order cannot be cancelled (409)
      await db.owner.query(`UPDATE "order" SET fulfillment_status = 'fulfilled' WHERE id = $1`, [
        orderId,
      ]);
      const refused = await storeAdmin.post(`/admin/stores/${A}/orders/${orderId}/cancel`, {
        reason: 'too late',
      });
      expect(refused.status).toBe(409);
      expect((await auditOf(orderId)).length).toBe(n);
    } finally {
      setTaxCalculator(real);
      delete process.env.ORDER_LINE_EDITS_ENABLED;
    }
  });
});
