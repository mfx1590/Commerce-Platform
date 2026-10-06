// Admin API `capturePayment` (Integration 2a, #355) on FakeStripe + a seeded throwaway database: partial capture
// (Stripe `amount_to_capture`, the row's amount becomes the captured one, the refund ceiling follows), the
// 409s (over the authorisation, already captured, Stripe `idempotency_error`), the manual provider's 422
// `provider_unsupported`, the order scope (404), the audit row, the route itself through the HTTP layer with dev
// tokens (permission from `x-permission`, body validation, response = contract `Payment`), and the agreement
// between the route and the `payment_intent.succeeded` webhook (one state, one event).
import { randomUUID } from 'node:crypto';
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
import {
  capturePayment,
  createRefund,
  createStripePaymentProvider,
  FakeStripe,
  handleStripeWebhook,
  paymentsAdminRouter,
  PROVIDER_UNSUPPORTED,
  signStripePayload,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const customer = { id: null, type: 'customer' as const, requestId: 'req-capture' };
const staff = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-capture' };
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
let fake: FakeStripe;

beforeAll(async () => {
  db = await createTestDatabase('core_capture');
  await seed(db.owner, { log: () => {} });
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
});

let counter = 0;
/** A placed brand-a order paid with the given provider; `authorized` payment row. */
async function placedOrder(
  provider: 'stripe' | 'manual' = 'stripe',
): Promise<{ orderId: string; paymentId: string; intentId: string | null; amount: number }> {
  const n = counter++;
  const cart = await createCart(a, scopeA, {});
  await addLineItem(a, cart.id, { variant_id: variants[n % variants.length]!.id, quantity: 2 });
  await updateCart(a, cart.id, {
    email: `jane.doe+${n}@example.com`,
    shipping_address: address,
    billing_address: { ...address, country: 'NL' },
    shipping_option_id: standardOptionId,
  });
  const session = await createPaymentSession(a, cart.id, { provider });
  if (provider === 'stripe') fake.clientConfirm(session.session_id);
  const { order } = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `place-${randomUUID()}`,
    actor: customer,
  });
  const p = await owner.query<{
    id: string;
    provider_payment_id: string | null;
    amount_minor: string;
  }>(`SELECT id, provider_payment_id, amount_minor::text FROM payment WHERE order_id = $1`, [
    order.id,
  ]);
  return {
    orderId: order.id,
    paymentId: p.rows[0]!.id,
    intentId: p.rows[0]!.provider_payment_id,
    amount: Number(p.rows[0]!.amount_minor),
  };
}

async function paymentRow(id: string) {
  const r = await owner.query<{
    status: string;
    amount_minor: string;
    fee_minor: string | null;
    metadata: Record<string, unknown>;
  }>(`SELECT status, amount_minor::text, fee_minor::text, metadata FROM payment WHERE id = $1`, [
    id,
  ]);
  return r.rows[0]!;
}

async function topicsFor(aggregateId: string): Promise<string[]> {
  const r = await owner.query<{ topic: string }>(
    `SELECT topic FROM outbox WHERE aggregate_id = $1 ORDER BY occurred_at, seq`,
    [aggregateId],
  );
  return r.rows.map((x) => x.topic);
}

async function orderPaymentStatus(orderId: string): Promise<string> {
  const r = await owner.query<{ payment_status: string }>(
    `SELECT payment_status FROM "order" WHERE id = $1`,
    [orderId],
  );
  return r.rows[0]!.payment_status;
}

const opts = () => ({ actor: staff, apiFactory: () => fake, env });

// ------------------------------------------------------------------------------------------------ use case

describe('capturePayment — partial capture (#355)', () => {
  it('captures part of the authorisation: amount_to_capture at Stripe, the row and the event carry the captured amount, the refund ceiling follows', async () => {
    const { orderId, paymentId, intentId, amount } = await placedOrder();
    expect(amount).toBeGreaterThan(100);
    const part = amount - 100;
    const r = await capturePayment(a, paymentId, { ...opts(), amountMinor: part });
    expect(r.replayed).toBe(false);
    expect(r.payment).toMatchObject({
      status: 'captured',
      amount_minor: String(part),
      fee_minor: '123',
    });
    const call = fake.callsOf('capturePaymentIntent')[0]!;
    expect(call.params).toEqual({ amount_to_capture: part });
    expect(call.idempotencyKey).toBe(`capture_${paymentId}`);
    expect(fake.intents.get(intentId!)!.amount_received).toBe(part);

    const row = await paymentRow(paymentId);
    expect(row.amount_minor).toBe(String(part));
    expect(row.metadata.capture).toEqual({
      authorized_minor: amount,
      captured_minor: part,
      partial: true,
    });
    const captured = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = 'payment.captured' AND aggregate_id = $1`,
      [paymentId],
    );
    expect(captured.rows).toHaveLength(1);
    expect(captured.rows[0]!.payload).toMatchObject({ amount_minor: part, fee_minor: 123 });
    expect(await orderPaymentStatus(orderId)).toBe('captured');

    // Audit row in the same transaction: ids and amounts, no PII.
    const audit = await owner.query<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM audit_log WHERE entity_type = 'payment' AND entity_id = $1`,
      [paymentId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'payment.capture',
        after: expect.objectContaining({
          amount_minor: part,
          authorized_minor: amount,
          partial: true,
        }),
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain('jane.doe');

    // The refund ceiling is what was captured, not what was authorised.
    await expect(
      createRefund(a, {
        orderId,
        paymentId,
        amountMinor: part + 1,
        reason: 'goodwill',
        idempotencyKey: `too-much-${paymentId}`,
        actor: staff,
      }),
    ).rejects.toMatchObject({ code: 'conflict', details: { captured_minor: part } });
    const ok = await createRefund(a, {
      orderId,
      paymentId,
      amountMinor: part,
      reason: 'goodwill',
      idempotencyKey: `all-${paymentId}`,
      actor: staff,
    });
    expect(ok.refund.status).toBe('succeeded');
  });

  it('a full capture (no amount, or the authorised amount) sends no amount_to_capture and records partial: false', async () => {
    const one = await placedOrder();
    await capturePayment(a, one.paymentId, opts());
    expect(fake.callsOf('capturePaymentIntent')[0]!.params).toEqual({});
    expect((await paymentRow(one.paymentId)).metadata.capture).toEqual({
      authorized_minor: one.amount,
      captured_minor: one.amount,
      partial: false,
    });
    const two = await placedOrder();
    await capturePayment(a, two.paymentId, { ...opts(), amountMinor: two.amount });
    expect(fake.callsOf('capturePaymentIntent')[1]!.params).toEqual({});
  });

  it('409 above the authorised amount and 400 below one minor unit — nothing sent to Stripe, row untouched', async () => {
    const { paymentId, amount } = await placedOrder();
    await expect(
      capturePayment(a, paymentId, { ...opts(), amountMinor: amount + 1 }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { field: 'amount_minor', requested_minor: amount + 1, authorized_minor: amount },
    });
    await expect(capturePayment(a, paymentId, { ...opts(), amountMinor: 0 })).rejects.toMatchObject(
      {
        code: 'validation_error',
      },
    );
    await expect(
      capturePayment(a, paymentId, { ...opts(), amountMinor: 1.5 }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(fake.callsOf('capturePaymentIntent')).toHaveLength(0);
    expect((await paymentRow(paymentId)).status).toBe('authorized');
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized']);
  });

  it('the manual provider has nothing to capture: 422 provider_unsupported', async () => {
    const { paymentId } = await placedOrder('manual');
    const err = await capturePayment(a, paymentId, opts()).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: PROVIDER_UNSUPPORTED,
      status: 422,
      details: { provider: 'manual' },
    });
    expect((await paymentRow(paymentId)).status).toBe('authorized');
    expect(fake.calls).toHaveLength(0);
  });

  it('scoped to the order: a payment of another order is 404; the right order captures', async () => {
    const one = await placedOrder();
    const two = await placedOrder();
    await expect(
      capturePayment(a, one.paymentId, { ...opts(), orderId: two.orderId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(fake.callsOf('capturePaymentIntent')).toHaveLength(0);
    const r = await capturePayment(a, one.paymentId, { ...opts(), orderId: one.orderId });
    expect(r.payment.status).toBe('captured');
  });

  it('a retry with ANOTHER amount after a lost response is a 409 (Stripe idempotency_error), nothing written; the same amount converges', async () => {
    const { orderId, paymentId, amount } = await placedOrder();
    const part = amount - 50;
    await capturePayment(a, paymentId, { ...opts(), amountMinor: part });
    // Simulated lost response: Stripe recorded the capture, our transaction never committed.
    await db.owner.query(
      `UPDATE payment SET status = 'authorized', amount_minor = $2, captured_at = NULL, fee_minor = NULL,
         metadata = metadata - 'capture' WHERE id = $1`,
      [paymentId, amount],
    );
    await db.owner.query(
      `DELETE FROM outbox WHERE topic = 'payment.captured' AND aggregate_id = $1`,
      [paymentId],
    );
    await db.owner.query(`UPDATE "order" SET payment_status = 'authorized' WHERE id = $1`, [
      orderId,
    ]);

    await expect(
      capturePayment(a, paymentId, { ...opts(), amountMinor: part + 10 }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { field: 'amount_minor', requested_minor: part + 10 },
    });
    expect((await paymentRow(paymentId)).status).toBe('authorized');
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized']);

    const again = await capturePayment(a, paymentId, { ...opts(), amountMinor: part });
    expect(again.replayed).toBe(false);
    expect(again.payment.amount_minor).toBe(String(part));
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
    expect(await orderPaymentStatus(orderId)).toBe('captured');
  });
});

// ------------------------------------------------------------------------------------------------- webhook

describe('route and webhook agree', () => {
  function succeededEvent(intentId: string, amount: number, amountReceived: number): Buffer {
    const body = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: 'payment_intent.succeeded',
      request: { id: `req_${randomUUID().slice(0, 8)}`, idempotency_key: null },
      data: {
        object: {
          id: intentId,
          object: 'payment_intent',
          amount,
          amount_received: amountReceived,
          amount_capturable: 0,
          currency: 'eur',
          status: 'succeeded',
          capture_method: 'manual',
          latest_charge: `ch_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          receipt_email: 'jane.doe@example.com',
          metadata: { store_id: A, organization_id: ORG },
        },
      },
    };
    return Buffer.from(JSON.stringify(body), 'utf8');
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

  it('payment_intent.succeeded after a partial capture by the route is skipped: one state, one payment.captured', async () => {
    const { orderId, paymentId, intentId, amount } = await placedOrder();
    const part = amount - 100;
    await capturePayment(a, paymentId, { ...opts(), amountMinor: part });
    const outcome = await deliver(succeededEvent(intentId!, amount, part));
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'already captured' });
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
    expect((await paymentRow(paymentId)).amount_minor).toBe(String(part));
    expect(await orderPaymentStatus(orderId)).toBe('captured');
  });

  it('a partial capture made at Stripe without us stays a visible discrepancy (failed amount_conflict)', async () => {
    const { paymentId, intentId, amount } = await placedOrder();
    const outcome = await deliver(succeededEvent(intentId!, amount, amount - 100));
    expect(outcome).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('amount_conflict'),
    });
    expect((await paymentRow(paymentId)).status).toBe('authorized');
  });
});

// ------------------------------------------------------------------------------------------------ Admin API

describe('POST /admin/stores/:storeId/orders/:orderId/payments/:paymentId/capture', () => {
  function app() {
    const e = express();
    mountCoreMiddleware(e, new DevTokenVerifier(), {
      moduleRouters: [paymentsAdminRouter({ stripe: { apiFactory: () => fake, env } })],
    });
    return e;
  }
  const post = (subject: string, orderId: string, paymentId: string, body?: unknown) => {
    const r = request(app())
      .post(`/admin/stores/${A}/orders/${orderId}/payments/${paymentId}/capture`)
      .set('Authorization', `Bearer dev:${subject}`);
    return body === undefined ? r.send() : r.send(body);
  };

  it('200 for a store admin without a body: the contract Payment, captured; a second call is 409, not a second charge', async () => {
    const { orderId, paymentId, intentId, amount } = await placedOrder();
    const res = await post('seed-store-admin', orderId, paymentId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: paymentId,
      provider: 'stripe',
      provider_payment_id: intentId,
      amount: { amount_minor: amount, currency: 'EUR' },
      status: 'captured',
      fee_minor: 123,
      captured_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(await orderPaymentStatus(orderId)).toBe('captured');

    const again = await post('seed-store-admin', orderId, paymentId);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'conflict',
      details: { field: 'status', from: 'captured', to: 'captured' },
    });
    expect(fake.callsOf('capturePaymentIntent')).toHaveLength(1);
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
  });

  it('partial capture through the body; over the authorisation is 409; a bad body is 400', async () => {
    const { orderId, paymentId, amount } = await placedOrder();
    const tooMuch = await post('seed-store-admin', orderId, paymentId, {
      amount_minor: amount + 1,
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body).toMatchObject({
      code: 'conflict',
      details: { field: 'amount_minor', authorized_minor: amount },
    });
    const bad = await post('seed-store-admin', orderId, paymentId, { amount_minor: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'validation_error' });
    const part = await post('seed-store-admin', orderId, paymentId, { amount_minor: amount - 100 });
    expect(part.status).toBe(200);
    expect(part.body.amount).toEqual({ amount_minor: amount - 100, currency: 'EUR' });
    expect(fake.callsOf('capturePaymentIntent')).toHaveLength(1);
  });

  it('permission is the spec x-permission (store_admin): support and store staff are 403, owner is 200', async () => {
    const { orderId, paymentId } = await placedOrder();
    const support = await post('seed-support', orderId, paymentId);
    expect(support.status).toBe(403);
    expect(support.body).toMatchObject({ code: 'forbidden' });
    const staffRes = await post('seed-store-staff', orderId, paymentId);
    expect(staffRes.status).toBe(403);
    expect(fake.callsOf('capturePaymentIntent')).toHaveLength(0);
    const ownerRes = await post('seed-owner', orderId, paymentId);
    expect(ownerRes.status).toBe(200);
  });

  it('422 provider_unsupported for the manual provider, with the provider in details', async () => {
    const { orderId, paymentId } = await placedOrder('manual');
    const res = await post('seed-store-admin', orderId, paymentId);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      code: 'provider_unsupported',
      message: 'the manual provider cannot capture payments',
      details: { provider: 'manual' },
    });
  });

  it('404 for a payment that is not on the order (same store), and for an unknown payment', async () => {
    const one = await placedOrder();
    const two = await placedOrder();
    const other = await post('seed-store-admin', two.orderId, one.paymentId);
    expect(other.status).toBe(404);
    const unknown = await post('seed-store-admin', one.orderId, randomUUID());
    expect(unknown.status).toBe(404);
    expect(fake.callsOf('capturePaymentIntent')).toHaveLength(0);
  });
});
