// #905: cancelling an order whose payment is CAPTURED refunds what is still captured, in the cancel's transaction
// (manager decision 2026-11-18). Through the Admin API `cancelOrder` route, with window 7's real Stripe provider over
// FakeStripe (a real capture, real refund rows and events), and the refund wired exactly as registerModuleSeams()
// wires it (`paymentsCancelRefunder`). EUR and JPY (zero-decimal), a partly refunded payment, a provider refusal
// (nothing commits), a lost provider answer (nothing commits; the retry's key makes the PSP return the same refund),
// a pending PSP refund, re-cancel, and the fail-closed default.
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DevTokenVerifier, moduleAdminRouters } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { addLineItem, createCart, updateCart } from '../src/modules/cart';
import { completeCart, createPaymentSession, setPaymentProvider } from '../src/modules/checkout';
import { setCancelRefunder } from '../src/modules/orders';
import {
  capturePayment,
  createRefund,
  createStripePaymentProvider,
  FakeStripe,
  StripeError,
  type StripeParams,
  type StripeRefund,
  type StripeRequestOptions,
} from '../src/modules/payments';
import { mountCoreMiddleware } from '../src/server';
import { paymentsCancelRefunder } from '../src/wiring';
import { specValidator } from './helpers/openapi';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const D = SEED_IDS.stores.brandD;
const spec = specValidator('admin-api.yaml');
const customer = { id: null, type: 'customer' as const, requestId: 'req-905' };
const staff = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-905' };
// a fixture value no secret scanner rule matches; FakeStripe never checks it
const env = { STRIPE_SECRET_KEY: 'fixture-not-a-key' } as NodeJS.ProcessEnv;

/** FakeStripe whose next refund HAPPENS at the PSP but whose answer is lost (a retryable 500 after the fact). */
class LossyStripe extends FakeStripe {
  loseNextRefundAnswer = false;
  override async createRefund(
    params: StripeParams,
    opts: StripeRequestOptions = {},
  ): Promise<StripeRefund> {
    const refund = await super.createRefund(params, opts);
    if (this.loseNextRefundAnswer) {
      this.loseNextRefundAnswer = false;
      throw new StripeError(500, 'connection reset after the refund was made', 'api_error');
    }
    return refund;
  }
}

let db: TestDatabase;
let owner: ReturnType<typeof createOrganizationClient>;
let app: express.Express;
let fake: LossyStripe;
const NL = {
  first_name: 'Jane',
  last_name: 'Doe',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};
const JP = {
  first_name: 'Jane',
  last_name: 'Doe',
  line1: '1-1 Marunouchi',
  city: 'Tokyo',
  postal_code: '100-0005',
  country: 'JP',
};

const as = (subject: string) => ({
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
});
const ownerApi = as('seed-owner');
const storeAdminApi = as('seed-store-admin');

beforeAll(async () => {
  db = await createTestDatabase('core_cancel_refund');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), { moduleRouters: moduleAdminRouters() });
}, 180_000);

afterAll(async () => {
  setCancelRefunder(null);
  await closePool();
  await db?.drop();
});

beforeEach(() => {
  fake = new LossyStripe();
  setPaymentProvider(createStripePaymentProvider({ apiFactory: () => fake, env }));
  setCancelRefunder(paymentsCancelRefunder);
});

/** A placed and CAPTURED Stripe order (window 7's capture) with two units of one variant. */
async function capturedOrder(storeId: string, currency: string, address: typeof NL) {
  const client = createTenantClient(db.app, { organizationId: ORG, storeIds: [storeId] });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [storeId],
  );
  const variant = await owner.query<{ id: string; stock_item_id: string }>(
    `SELECT v.id, v.stock_item_id FROM product_variant v
     JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = $2 AND pr.min_quantity = 1
     WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder
       AND (SELECT sum(il.available) FROM inventory_level il WHERE il.stock_item_id = v.stock_item_id) >= 10
     ORDER BY v.sku LIMIT 1`,
    [storeId, currency],
  );
  const cart = await createCart(client, {
    organizationId: ORG,
    storeId,
    salesChannelId: channel.rows[0]!.id,
  });
  await addLineItem(client, cart.id, { variant_id: variant.rows[0]!.id, quantity: 2 });
  const option = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [storeId],
  );
  await updateCart(client, cart.id, {
    email: `cancel-905+${randomUUID().slice(0, 8)}@example.com`,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: option.rows[0]!.id,
  });
  const session = await createPaymentSession(client, cart.id, { provider: 'stripe' });
  fake.clientConfirm(session.session_id);
  const { order } = await completeCart(client, {
    cartId: cart.id,
    idempotencyKey: `place-${randomUUID()}`,
    actor: customer,
  });
  const p = await owner.query<{ id: string; amount_minor: string; idempotency_key: string }>(
    `SELECT id, amount_minor::text, idempotency_key FROM payment WHERE order_id = $1`,
    [order.id],
  );
  await capturePayment(client, p.rows[0]!.id, { actor: staff, apiFactory: () => fake, env });
  return {
    orderId: order.id,
    paymentId: p.rows[0]!.id,
    paymentKey: p.rows[0]!.idempotency_key,
    captured: Number(p.rows[0]!.amount_minor),
    variantId: variant.rows[0]!.id,
    stockItemId: variant.rows[0]!.stock_item_id,
    client,
  };
}

async function state(orderId: string) {
  const o = await owner.query<{ status: string; payment_status: string }>(
    `SELECT status, payment_status FROM "order" WHERE id = $1`,
    [orderId],
  );
  const refunds = await owner.query<{
    amount_minor: string;
    reason: string;
    status: string;
    idempotency_key: string;
  }>(
    `SELECT amount_minor::text, reason, status, idempotency_key FROM refund WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  const events = await owner.query<{ topic: string; payload: Record<string, unknown> }>(
    `SELECT topic, payload FROM outbox
     WHERE (aggregate_id::text = $1::text AND topic LIKE 'order.%') OR payload->>'order_id' = $1::text
     ORDER BY occurred_at, seq`,
    [orderId],
  );
  const reserved = await owner.query<{ n: number }>(
    `SELECT coalesce(sum(quantity), 0)::int AS n FROM reservation WHERE order_id = $1 AND released_at IS NULL`,
    [orderId],
  );
  return {
    ...o.rows[0]!,
    refunds: refunds.rows.map((r) => ({ ...r, amount_minor: Number(r.amount_minor) })),
    topics: events.rows.map((e) => e.topic),
    refundIssued: events.rows.filter((e) => e.topic === 'refund.issued').map((e) => e.payload),
    reserved: reserved.rows[0]!.n,
  };
}

const cancelPath = (storeId: string, orderId: string) =>
  `/admin/stores/${storeId}/orders/${orderId}/cancel`;

describe('cancelOrder on a captured payment refunds what is still captured (#905)', () => {
  it('EUR: one refund of the full capture, refund.issued (cancellation) before order.cancelled, payment_status refunded; re-cancel refunds nothing', async () => {
    const o = await capturedOrder(A, 'EUR', NL);
    expect((await state(o.orderId)).payment_status).toBe('captured');
    const res = await storeAdminApi.post(cancelPath(A, o.orderId), { reason: 'customer request' });
    expect(res.status).toBe(200);
    spec.assertSchema('Order', res.body);
    expect(res.body).toMatchObject({ status: 'cancelled', payment_status: 'refunded' });
    expect(res.body.refunds).toEqual([
      expect.objectContaining({
        amount: { amount_minor: o.captured, currency: 'EUR' },
        reason: 'cancellation',
      }),
    ]);
    const s = await state(o.orderId);
    expect(s.refunds).toEqual([
      expect.objectContaining({
        amount_minor: o.captured,
        reason: 'cancellation',
        status: 'succeeded',
        idempotency_key: `${A}:${o.paymentKey}:cancel-refund`,
      }),
    ]);
    expect(s.refundIssued).toEqual([
      expect.objectContaining({
        order_id: o.orderId,
        payment_id: o.paymentId,
        amount_minor: o.captured,
        currency: 'EUR',
        reason: 'cancellation',
      }),
    ]);
    // the refund is part of the cancel: refund.issued, then the order's moves, order.cancelled last
    expect(s.topics.indexOf('refund.issued')).toBeLessThan(s.topics.indexOf('order.cancelled'));
    expect(s.reserved).toBe(0);
    expect([...fake.refunds.values()].map((r) => r.amount)).toEqual([o.captured]);

    // re-cancel: 200, same order, no second refund anywhere
    const again = await storeAdminApi.post(cancelPath(A, o.orderId), { reason: 'again' });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('cancelled');
    const s2 = await state(o.orderId);
    expect(s2.refunds).toHaveLength(1);
    expect(s2.refundIssued).toHaveLength(1);
    expect(fake.refunds.size).toBe(1);
  });

  it('JPY (brand D, zero-decimal): the whole-yen capture is refunded exactly', async () => {
    const o = await capturedOrder(D, 'JPY', JP);
    const res = await ownerApi.post(cancelPath(D, o.orderId), { reason: 'customer request' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', payment_status: 'refunded' });
    const s = await state(o.orderId);
    expect(Number.isInteger(o.captured)).toBe(true);
    expect(s.refundIssued).toEqual([
      expect.objectContaining({
        amount_minor: o.captured,
        currency: 'JPY',
        reason: 'cancellation',
      }),
    ]);
    expect([...fake.refunds.values()]).toEqual([
      expect.objectContaining({ amount: o.captured, currency: 'jpy' }),
    ]);
  });

  it('partly refunded first: the cancel refunds only the remainder (captured − refunded); together they equal the capture', async () => {
    const o = await capturedOrder(A, 'EUR', NL);
    const part = Math.floor(o.captured / 3);
    await createRefund(o.client, {
      orderId: o.orderId,
      amountMinor: part,
      reason: 'goodwill',
      idempotencyKey: `goodwill-${randomUUID()}`,
      actor: staff,
      requestedBy: SEED_IDS.users.storeAdmin,
    });
    expect((await state(o.orderId)).payment_status).toBe('partially_refunded');
    const res = await storeAdminApi.post(cancelPath(A, o.orderId), { reason: 'customer request' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', payment_status: 'refunded' });
    const s = await state(o.orderId);
    expect(s.refunds.map((r) => [r.reason, r.amount_minor])).toEqual([
      ['goodwill', part],
      ['cancellation', o.captured - part],
    ]);
    expect(s.refundIssued.map((p) => p.amount_minor)).toEqual([part, o.captured - part]);
  });

  it('a provider refusal leaves the order uncancelled: 402, no refund row or event, reservations held; a later cancel succeeds', async () => {
    const o = await capturedOrder(A, 'EUR', NL);
    const before = await state(o.orderId);
    fake.failNextRefund = 'charge_disputed';
    const res = await storeAdminApi.post(cancelPath(A, o.orderId), { reason: 'customer request' });
    expect(res.status).toBe(402);
    spec.assertSchema('Error', res.body);
    expect(res.body.code).toBe('payment_failed');
    const after = await state(o.orderId);
    expect(after).toEqual(before); // status, payment_status, refunds, every event, reservations
    expect(after.topics).not.toContain('refund.failed');
    // the next attempt (the PSP no longer refuses) cancels and refunds once
    const retry = await storeAdminApi.post(cancelPath(A, o.orderId), {
      reason: 'customer request',
    });
    expect(retry.status).toBe(200);
    expect((await state(o.orderId)).refundIssued).toHaveLength(1);
  });

  it('a lost provider answer commits nothing; the retry sends the same key and the PSP returns the SAME refund (one refund in all)', async () => {
    const o = await capturedOrder(A, 'EUR', NL);
    const before = await state(o.orderId);
    fake.loseNextRefundAnswer = true;
    const res = await storeAdminApi.post(cancelPath(A, o.orderId), { reason: 'customer request' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await state(o.orderId)).toEqual(before);
    expect(fake.refunds.size).toBe(1); // the PSP did refund
    const keys = fake.calls.filter((c) => c.method === 'createRefund').map((c) => c.idempotencyKey);
    const retry = await storeAdminApi.post(cancelPath(A, o.orderId), {
      reason: 'customer request',
    });
    expect(retry.status).toBe(200);
    const after = fake.calls
      .filter((c) => c.method === 'createRefund')
      .map((c) => c.idempotencyKey);
    expect(after).toEqual([...keys, keys[0]]); // the same provider key, twice
    expect(fake.refunds.size).toBe(1); // ... and still ONE refund at the PSP
    const s = await state(o.orderId);
    expect(s.refunds).toHaveLength(1);
    expect(s.refundIssued).toEqual([expect.objectContaining({ amount_minor: o.captured })]);
    expect(s).toMatchObject({ status: 'cancelled', payment_status: 'refunded' });
  });

  it('a refund the PSP has only accepted (pending): the order is cancelled, the row pending, refund.issued waits for the webhook', async () => {
    const o = await capturedOrder(A, 'EUR', NL);
    fake.pendingNextRefund = true;
    const res = await storeAdminApi.post(cancelPath(A, o.orderId), { reason: 'customer request' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    const s = await state(o.orderId);
    expect(s.refunds).toEqual([
      expect.objectContaining({
        amount_minor: o.captured,
        status: 'pending',
        reason: 'cancellation',
      }),
    ]);
    expect(s.refundIssued).toEqual([]);
    expect(s.payment_status).toBe('captured'); // settled money only (window 7's rule)
  });

  it('fail closed: with no CancelRefunder registered a captured order is not cancelled (503), nothing changes', async () => {
    const o = await capturedOrder(A, 'EUR', NL);
    const before = await state(o.orderId);
    setCancelRefunder(null);
    const res = await storeAdminApi.post(cancelPath(A, o.orderId), { reason: 'customer request' });
    expect(res.status).toBe(503);
    expect(await state(o.orderId)).toEqual(before);
    expect(fake.refunds.size).toBe(0);
  });
});
