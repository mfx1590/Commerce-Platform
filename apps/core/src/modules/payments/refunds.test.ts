// Refunds (issue #126) on FakeStripe + a seeded throwaway database: partial and full refunds (rows, events,
// order payment_status), the ceiling (409 with the contract body), Idempotency-Key replay (same refund, one
// provider call; other refund → 409), a Stripe failure (refund.failed + 402, order consistent, a new key may
// retry), the support limit, return-driven refunds through the returns module's seam, webhook settlement of
// pending / failed refunds, and the Admin API route with dev tokens (permission, limit, validation).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DevTokenVerifier } from '../../http';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import { addLineItem, createCart, updateCart } from '../cart';
import { completeCart, createPaymentSession, setPaymentProvider } from '../checkout';
import { getAdminOrder } from '../orders';
import { getReturn, receiveReturn, requestReturn, setRefundRequester } from '../returns';
import {
  capturePayment,
  createRefund,
  createStripePaymentProvider,
  FakeStripe,
  getWebhookEvent,
  handleStripeWebhook,
  paymentsAdminRouter,
  paymentsRefundRequester,
  signStripePayload,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const customer = { id: null, type: 'customer' as const, requestId: 'req-refunds' };
const staff = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-refunds' };
const SECRET_A = 'whsec_test_brand_a_secret';
const env = {
  STRIPE_SECRET_KEY: 'sk_test_fake_global',
  STRIPE_WEBHOOK_SECRET_BRAND_A: SECRET_A,
} as NodeJS.ProcessEnv;
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
let owner: ReturnType<typeof createOrganizationClient>;
let codeA: string;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let variants: { id: string }[];
let standardOptionId: string;
let warehouseId: string;
let fake: FakeStripe;

beforeAll(async () => {
  db = await createTestDatabase('core_refunds');
  await seed(db.owner, { log: () => {} });
  await db.owner.query(readFileSync(join(__dirname, 'proposed', '0140_webhook_event.sql'), 'utf8'));
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  codeA = (await owner.query<{ code: string }>(`SELECT code FROM store WHERE id = $1`, [A]))
    .rows[0]!.code;
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
  const vs = await owner.query<{ id: string }>(
    `SELECT v.id
     FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder
       AND coalesce((SELECT sum(il.available) FROM inventory_level il WHERE il.variant_id = v.id), 0) >= 10
     ORDER BY v.sku`,
    [A],
  );
  variants = vs.rows;
  const opt = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  standardOptionId = opt.rows[0]!.id;
  const wh = await owner.query<{ id: string }>(`SELECT id FROM warehouse ORDER BY code LIMIT 1`);
  warehouseId = wh.rows[0]!.id;
  // Dev tokens for the Admin API route tests (explicit opt-in, as src/server.ts requires).
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

beforeEach(() => {
  fake = new FakeStripe();
  setPaymentProvider(createStripePaymentProvider({ apiFactory: () => fake, env }));
  setRefundRequester(paymentsRefundRequester);
});

let counter = 0;
async function capturedOrder(): Promise<{
  orderId: string;
  paymentId: string;
  intentId: string;
  amount: number;
}> {
  const n = counter++;
  const cart = await createCart(a, scopeA, {});
  await addLineItem(a, cart.id, { variant_id: variants[n % variants.length]!.id, quantity: 2 });
  await updateCart(a, cart.id, {
    email: `jane.doe+${n}@example.com`,
    shipping_address: address,
    billing_address: { ...address, country: 'NL' },
    shipping_option_id: standardOptionId,
  });
  const session = await createPaymentSession(a, cart.id, { provider: 'stripe' });
  fake.clientConfirm(session.session_id);
  const { order } = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `place-${randomUUID()}`,
    actor: customer,
  });
  const p = await owner.query<{ id: string; provider_payment_id: string; amount_minor: string }>(
    `SELECT id, provider_payment_id, amount_minor::text FROM payment WHERE order_id = $1`,
    [order.id],
  );
  const paymentId = p.rows[0]!.id;
  await capturePayment(a, paymentId, { actor: staff, apiFactory: () => fake, env });
  return {
    orderId: order.id,
    paymentId,
    intentId: p.rows[0]!.provider_payment_id,
    amount: Number(p.rows[0]!.amount_minor),
  };
}

async function orderStatus(orderId: string): Promise<{ status: string; payment_status: string }> {
  const r = await owner.query<{ status: string; payment_status: string }>(
    `SELECT status, payment_status FROM "order" WHERE id = $1`,
    [orderId],
  );
  return r.rows[0]!;
}

async function eventsFor(
  aggregateId: string,
): Promise<{ topic: string; payload: Record<string, unknown> }[]> {
  const r = await owner.query<{ topic: string; payload: Record<string, unknown> }>(
    `SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY occurred_at, seq`,
    [aggregateId],
  );
  return r.rows;
}

const refundInput = (orderId: string, amountMinor: number, key = `k-${randomUUID()}`) => ({
  orderId,
  amountMinor,
  reason: 'goodwill' as const,
  idempotencyKey: key,
  actor: staff,
  requestedBy: SEED_IDS.users.storeAdmin,
});

// ---------------------------------------------------------------------------------------------- use case

describe('createRefund', () => {
  it('partial then full: rows, refund.issued with legal entity, order partially_refunded → refunded', async () => {
    const { orderId, paymentId, amount } = await capturedOrder();
    const part = Math.floor(amount / 3);
    const key = `first-${randomUUID()}`;

    const first = await createRefund(a, refundInput(orderId, part, key));
    expect(first.replayed).toBe(false);
    expect(first.refund).toMatchObject({
      order_id: orderId,
      payment_id: paymentId,
      return_id: null,
      amount: { amount_minor: part, currency: 'EUR' },
      reason: 'goodwill',
      status: 'succeeded',
      provider_refund_id: expect.stringMatching(/^re_/),
    });
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'partially_refunded' });
    const issued = await eventsFor(first.refund.id);
    expect(issued.map((e) => e.topic)).toEqual(['refund.issued']);
    expect(issued[0]!.payload).toMatchObject({
      refund_id: first.refund.id,
      payment_id: paymentId,
      order_id: orderId,
      return_id: null,
      legal_entity_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      amount_minor: part,
      currency: 'EUR',
      reason: 'goodwill',
      provider_refund_id: first.refund.provider_refund_id,
    });
    // The provider got the store-scoped key, the intent and the amount — never a card or an email.
    const call = fake.callsOf('createRefund')[0]!;
    expect(call.params).toMatchObject({ amount: part });
    expect(call.idempotencyKey).toBe(`refund_${A}:${key}`); // store-scoped key, passed through to Stripe
    expect(JSON.stringify(call.params)).not.toMatch(/@|card/);

    const rest = await createRefund(a, refundInput(orderId, amount - part));
    expect(rest.refund.status).toBe('succeeded');
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'refunded' });
    // The Admin order read model shows both.
    const admin = await getAdminOrder(a, orderId);
    expect(admin!.refunds.map((r) => r.amount.amount_minor).sort((x, y) => x - y)).toEqual(
      [part, amount - part].sort((x, y) => x - y),
    );
    // Written by whom: the requesting staff user.
    const row = await owner.query<{ requested_by: string }>(
      `SELECT requested_by FROM refund WHERE id = $1`,
      [first.refund.id],
    );
    expect(row.rows[0]!.requested_by).toBe(SEED_IDS.users.storeAdmin);
  });

  it('ceiling: a refund above captured minus refunded is 409 with the contract body; exactly the rest is fine', async () => {
    const { orderId, amount } = await capturedOrder();
    await createRefund(a, refundInput(orderId, 100));
    await expect(createRefund(a, refundInput(orderId, amount - 99))).rejects.toMatchObject({
      code: 'conflict',
      details: {
        field: 'amount_minor',
        captured_minor: amount,
        refunded_minor: 100,
        available_minor: amount - 100,
        requested_minor: amount - 99,
      },
    });
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'partially_refunded' });
    const rest = await createRefund(a, refundInput(orderId, amount - 100));
    expect(rest.refund.status).toBe('succeeded');
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'refunded' });
    await expect(createRefund(a, refundInput(orderId, 1))).rejects.toMatchObject({
      code: 'conflict',
      details: { available_minor: 0 },
    });
  });

  it('Idempotency-Key replay returns the same refund with ONE provider call; the key on another refund is 409', async () => {
    const { orderId } = await capturedOrder();
    const key = `replay-${randomUUID()}`;
    const first = await createRefund(a, refundInput(orderId, 250, key));
    const again = await createRefund(a, refundInput(orderId, 250, key));
    expect(again.replayed).toBe(true);
    expect(again.refund).toEqual(first.refund);
    expect(fake.callsOf('createRefund')).toHaveLength(1);
    expect((await eventsFor(first.refund.id)).map((e) => e.topic)).toEqual(['refund.issued']);
    await expect(createRefund(a, refundInput(orderId, 300, key))).rejects.toMatchObject({
      code: 'conflict',
      details: { refund_id: first.refund.id },
    });
    const { orderId: other } = await capturedOrder();
    await expect(createRefund(a, refundInput(other, 250, key))).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('a Stripe failure: row failed + refund.failed, 402, order untouched; the same key replays the 402, a new key may retry', async () => {
    const { orderId, amount } = await capturedOrder();
    const key = `fail-${randomUUID()}`;
    fake.failNextRefund = 'charge_already_refunded';
    await expect(createRefund(a, refundInput(orderId, 400, key))).rejects.toMatchObject({
      code: 'payment_failed',
      details: { refund_id: expect.any(String), replayed: false },
    });
    const failedRow = await owner.query<{ id: string; status: string }>(
      `SELECT id, status FROM refund WHERE order_id = $1`,
      [orderId],
    );
    expect(failedRow.rows).toHaveLength(1);
    expect(failedRow.rows[0]!.status).toBe('failed');
    const ev = await eventsFor(failedRow.rows[0]!.id);
    expect(ev.map((e) => e.topic)).toEqual(['refund.failed']);
    expect(ev[0]!.payload).toMatchObject({
      failure_reason: 'charge_already_refunded',
      amount_minor: 400,
    });
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'captured' });
    // Same key → the same failed refund, no second provider call.
    await expect(createRefund(a, refundInput(orderId, 400, key))).rejects.toMatchObject({
      code: 'payment_failed',
      details: { refund_id: failedRow.rows[0]!.id, replayed: true },
    });
    expect(fake.callsOf('createRefund')).toHaveLength(1);
    // A failed row does not hold money: a new key can refund the full amount.
    const retry = await createRefund(a, refundInput(orderId, amount));
    expect(retry.refund.status).toBe('succeeded');
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'refunded' });
  });

  it('support limit: above the limit is 403 and nothing is written; no limit for admins', async () => {
    const { orderId } = await capturedOrder();
    await expect(
      createRefund(a, { ...refundInput(orderId, 300), limitMinor: 200 }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { limit_minor: 200, requested_minor: 300 },
    });
    const rows = await owner.query(`SELECT 1 FROM refund WHERE order_id = $1`, [orderId]);
    expect(rows.rows).toHaveLength(0);
    expect(fake.callsOf('createRefund')).toHaveLength(0);
    const ok = await createRefund(a, { ...refundInput(orderId, 300), limitMinor: null });
    expect(ok.refund.status).toBe('succeeded');
  });

  it('refuses an uncaptured payment (409), an unknown order (404) and an unknown payment id (404)', async () => {
    // authorized, not captured
    const n = counter++;
    const cart = await createCart(a, scopeA, {});
    await addLineItem(a, cart.id, { variant_id: variants[n % variants.length]!.id, quantity: 1 });
    await updateCart(a, cart.id, {
      email: `jane.doe+${n}@example.com`,
      shipping_address: address,
      billing_address: address,
      shipping_option_id: standardOptionId,
    });
    const session = await createPaymentSession(a, cart.id, { provider: 'stripe' });
    fake.clientConfirm(session.session_id);
    const { order } = await completeCart(a, {
      cartId: cart.id,
      idempotencyKey: `place-${randomUUID()}`,
      actor: customer,
    });
    await expect(createRefund(a, refundInput(order.id, 1))).rejects.toMatchObject({
      code: 'conflict',
      details: { field: 'payment_status', from: 'authorized', to: 'captured' },
    });
    await expect(createRefund(a, refundInput(randomUUID(), 1))).rejects.toMatchObject({
      code: 'not_found',
    });
    const { orderId } = await capturedOrder();
    await expect(
      createRefund(a, { ...refundInput(orderId, 1), paymentId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ---------------------------------------------------------------------------------------------- returns seam

describe('return-driven refunds through the returns module', () => {
  it('receiveReturn → the requester writes the refund row + refund.issued, the return stores the id, the order moves', async () => {
    const { orderId, paymentId, amount } = await capturedOrder();
    const line = await owner.query<{ id: string; quantity: number }>(
      `SELECT id, quantity FROM order_line_item WHERE order_id = $1`,
      [orderId],
    );
    // A return needs a shipped order (the orders module refuses otherwise: "cancel the order instead"). The
    // shipping path is window 8's; put the order in the shipped state directly for this test.
    await owner.query(
      `UPDATE "order" SET status = 'processing', fulfillment_status = 'fulfilled' WHERE id = $1`,
      [orderId],
    );
    await owner.query(
      `UPDATE order_line_item SET fulfilled_quantity = quantity WHERE order_id = $1`,
      [orderId],
    );
    const ret = await requestReturn(a, orderId, {
      items: [{ order_line_item_id: line.rows[0]!.id, quantity: 1 }],
      reason: 'wrong size',
      actor: staff,
    });
    const received = await receiveReturn(a, ret.id, {
      warehouseId,
      items: [{ order_line_item_id: line.rows[0]!.id, quantity: 1, condition: 'resellable' }],
      actor: staff,
    });
    expect(received.status).toBe('refunded');
    expect(received.refund_id).toEqual(expect.any(String));
    const row = await owner.query<{
      id: string;
      status: string;
      reason: string;
      return_id: string;
      amount_minor: string;
      idempotency_key: string;
    }>(
      `SELECT id, status, reason, return_id, amount_minor::text, idempotency_key FROM refund WHERE order_id = $1`,
      [orderId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      id: received.refund_id,
      status: 'succeeded',
      reason: 'return',
      return_id: ret.id,
      idempotency_key: `${A}:return:${ret.id}`,
    });
    const refunded = Number(row.rows[0]!.amount_minor);
    expect(refunded).toBeGreaterThan(0);
    expect(refunded).toBeLessThan(amount); // one of two units
    const ev = await eventsFor(received.refund_id!);
    expect(ev.map((e) => e.topic)).toEqual(['refund.issued']);
    expect(ev[0]!.payload).toMatchObject({
      return_id: ret.id,
      reason: 'return',
      payment_id: paymentId,
    });
    // The returns module moved the order (one writer of payment_status in that transaction).
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'partially_refunded' });
    expect((await getReturn(a, ret.id))!.refund_id).toBe(received.refund_id);
  });
});

// ---------------------------------------------------------------------------------------------- webhooks

describe('refund settlement through the webhook receiver', () => {
  function refundEvent(
    type: string,
    refund: { id: string; amount: number; status: string; intent: string; failure_reason?: string },
  ): { id: string; raw: Buffer } {
    const id = `evt_${randomUUID().replace(/-/g, '')}`;
    const body = {
      id,
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type,
      data: {
        object: {
          id: refund.id,
          object: 'refund',
          amount: refund.amount,
          currency: 'eur',
          status: refund.status,
          payment_intent: refund.intent,
          failure_reason: refund.failure_reason ?? null,
          receipt_number: '1234-5678',
          metadata: { reason: 'goodwill' },
        },
      },
    };
    return { id, raw: Buffer.from(JSON.stringify(body), 'utf8') };
  }
  const deliver = (raw: Buffer) =>
    handleStripeWebhook({
      client: a,
      storeCode: codeA,
      rawBody: raw,
      signatureHeader: signStripePayload(raw, SECRET_A),
      env,
      log: () => {},
    });

  it('refund.updated failed on a succeeded refund → row failed + refund.failed (order stays, manual action)', async () => {
    const { orderId, intentId } = await capturedOrder();
    const { refund } = await createRefund(a, refundInput(orderId, 200));
    const r = await deliver(
      refundEvent('refund.updated', {
        id: refund.provider_refund_id!,
        amount: 200,
        status: 'failed',
        intent: intentId,
        failure_reason: 'lost_or_stolen_card',
      }).raw,
    );
    expect(r).toMatchObject({ kind: 'processed' });
    const row = await owner.query<{ status: string }>(`SELECT status FROM refund WHERE id = $1`, [
      refund.id,
    ]);
    expect(row.rows[0]!.status).toBe('failed');
    const ev = await eventsFor(refund.id);
    expect(ev.map((e) => e.topic)).toEqual(['refund.issued', 'refund.failed']);
    expect(ev[1]!.payload).toMatchObject({ failure_reason: 'lost_or_stolen_card' });
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'partially_refunded' });
    // Again → skipped; a later "succeeded" for a failed row is a conflict for a human.
    expect(
      await deliver(
        refundEvent('refund.updated', {
          id: refund.provider_refund_id!,
          amount: 200,
          status: 'failed',
          intent: intentId,
        }).raw,
      ),
    ).toMatchObject({ kind: 'skipped', reason: 'already failed' });
    const conflict = await deliver(
      refundEvent('refund.updated', {
        id: refund.provider_refund_id!,
        amount: 200,
        status: 'succeeded',
        intent: intentId,
      }).raw,
    );
    expect(conflict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('state_conflict'),
    });
    expect((await getWebhookEvent(a, conflict.eventId))!.status).toBe('failed');
  });

  it('refund.updated succeeded on a pending refund → row succeeded + refund.issued + order transition; then a duplicate is skipped', async () => {
    const { orderId, intentId, amount } = await capturedOrder();
    const { refund } = await createRefund(a, refundInput(orderId, amount));
    // Simulate a provider that answered "pending" (a future provider; Stripe's pending maps to succeeded here).
    await owner.query(`UPDATE refund SET status = 'pending' WHERE id = $1`, [refund.id]);
    await owner.query(`DELETE FROM outbox WHERE aggregate_id = $1`, [refund.id]);
    await owner.query(`UPDATE "order" SET payment_status = 'captured' WHERE id = $1`, [orderId]);
    const r = await deliver(
      refundEvent('refund.updated', {
        id: refund.provider_refund_id!,
        amount,
        status: 'succeeded',
        intent: intentId,
      }).raw,
    );
    expect(r).toMatchObject({ kind: 'processed' });
    const row = await owner.query<{ status: string }>(`SELECT status FROM refund WHERE id = $1`, [
      refund.id,
    ]);
    expect(row.rows[0]!.status).toBe('succeeded');
    expect((await eventsFor(refund.id)).map((e) => e.topic)).toEqual(['refund.issued']);
    expect(await orderStatus(orderId)).toMatchObject({ payment_status: 'refunded' });
    expect(
      await deliver(
        refundEvent('refund.updated', {
          id: refund.provider_refund_id!,
          amount,
          status: 'succeeded',
          intent: intentId,
        }).raw,
      ),
    ).toMatchObject({ kind: 'skipped', reason: 'already succeeded' });
    // Unknown refund id and the informational charge.refunded are skipped, never errors.
    expect(
      await deliver(
        refundEvent('refund.updated', {
          id: 're_unknown',
          amount: 1,
          status: 'succeeded',
          intent: intentId,
        }).raw,
      ),
    ).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('no refund row') });
  });
});

// ---------------------------------------------------------------------------------------------- Admin API

describe('POST /admin/stores/:storeId/orders/:orderId/refunds', () => {
  function app() {
    const e = express();
    mountCoreMiddleware(e, new DevTokenVerifier(), { moduleRouters: [paymentsAdminRouter()] });
    return e;
  }
  const post = (
    subject: string,
    orderId: string,
    body: unknown,
    key: string | null = `k-${randomUUID()}`,
  ) => {
    let r = request(app())
      .post(`/admin/stores/${A}/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer dev:${subject}`);
    if (key) r = r.set('Idempotency-Key', key);
    return r.send(body);
  };

  it('201 for support within the store limit, 403 above it, 201 for a store admin above it, 403 for staff', async () => {
    const { orderId, amount } = await capturedOrder();
    expect(amount).toBeGreaterThan(5000); // the seeded support_refund_limit_minor
    const ok = await post('seed-support', orderId, { amount_minor: 500, reason: 'goodwill' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      order_id: orderId,
      amount: { amount_minor: 500, currency: 'EUR' },
      reason: 'goodwill',
      status: 'succeeded',
      provider_refund_id: expect.stringMatching(/^re_/),
    });
    const tooMuch = await post('seed-support', orderId, { amount_minor: 5001, reason: 'goodwill' });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body).toMatchObject({ code: 'forbidden', details: { limit_minor: 5000 } });
    const admin = await post('seed-store-admin', orderId, {
      amount_minor: 5001,
      reason: 'goodwill',
    });
    expect(admin.status).toBe(201);
    const staffRes = await post('seed-store-staff', orderId, {
      amount_minor: 1,
      reason: 'goodwill',
    });
    expect(staffRes.status).toBe(403);
    expect(staffRes.body).toMatchObject({ code: 'forbidden' });
  });

  it('400 without Idempotency-Key or with a body the spec rejects; 409 ceiling renders the contract error', async () => {
    const { orderId, amount } = await capturedOrder();
    const noKey = await post(
      'seed-store-admin',
      orderId,
      { amount_minor: 1, reason: 'goodwill' },
      null,
    );
    expect(noKey.status).toBe(400);
    expect(noKey.body).toMatchObject({ code: 'validation_error' });
    const badBody = await post('seed-store-admin', orderId, { amount_minor: 0, reason: 'because' });
    expect(badBody.status).toBe(400);
    const over = await post('seed-store-admin', orderId, {
      amount_minor: amount + 1,
      reason: 'goodwill',
    });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'conflict', details: { field: 'amount_minor' } });
    // Replay through HTTP: same key → same refund, 201.
    const key = `http-${randomUUID()}`;
    const one = await post(
      'seed-store-admin',
      orderId,
      { amount_minor: 10, reason: 'goodwill' },
      key,
    );
    const two = await post(
      'seed-store-admin',
      orderId,
      { amount_minor: 10, reason: 'goodwill' },
      key,
    );
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.body.id).toBe(one.body.id);
  });
});
