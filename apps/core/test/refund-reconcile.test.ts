// #918: cancel-refund reconciliation, with window 7's real Stripe provider over FakeStripe. Orphan refunds (the PSP
// refunded, no row of ours) are recorded from Stripe — amount and currency from Stripe, once; a PENDING row of ours
// is never duplicated; `charge.refunded` reconciles through the signed webhook; a refund that FAILS at the PSP on a
// cancelled order flags `refund_attention` (audited) and a later successful refund clears it (audited); the Stripe
// client's timeout is an UNKNOWN outcome, never a definitive failure.
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
  handleStripeWebhook,
  reconcilePaymentRefunds,
  signStripePayload,
  StripeClient,
  StripeError,
} from '../src/modules/payments';
import { mountCoreMiddleware } from '../src/server';
import { paymentsCancelRefunder } from '../src/wiring';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const customer = { id: null, type: 'customer' as const, requestId: 'req-918' };
const staff = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-918' };
const system = { id: null, type: 'system' as const, requestId: 'req-918' };
// fixture values no secret scanner rule matches; FakeStripe and the HMAC check never look at their shape
const WEBHOOK_SECRET = 'fixture-webhook-signing-value';
const env = {
  STRIPE_SECRET_KEY: 'fixture-not-a-key',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
} as NodeJS.ProcessEnv;
const NL = {
  first_name: 'Jane',
  last_name: 'Doe',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};

let db: TestDatabase;
let owner: ReturnType<typeof createOrganizationClient>;
let a: ReturnType<typeof createTenantClient>;
let app: express.Express;
let fake: FakeStripe;
let codeA: string;

beforeAll(async () => {
  db = await createTestDatabase('core_refund_reconcile');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  codeA = (await owner.query<{ code: string }>(`SELECT code FROM store WHERE id = $1`, [A]))
    .rows[0]!.code;
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
  fake = new FakeStripe();
  setPaymentProvider(createStripePaymentProvider({ apiFactory: () => fake, env }));
  setCancelRefunder(paymentsCancelRefunder);
});

async function capturedOrder() {
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  const variant = await owner.query<{ id: string }>(
    `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder
       AND (SELECT sum(il.available) FROM inventory_level il WHERE il.stock_item_id = v.stock_item_id) >= 10
     ORDER BY v.sku LIMIT 1`,
    [A],
  );
  const cart = await createCart(a, {
    organizationId: ORG,
    storeId: A,
    salesChannelId: channel.rows[0]!.id,
  });
  await addLineItem(a, cart.id, { variant_id: variant.rows[0]!.id, quantity: 2 });
  const option = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  await updateCart(a, cart.id, {
    email: `reconcile-918+${randomUUID().slice(0, 8)}@example.com`,
    shipping_address: NL,
    billing_address: NL,
    shipping_option_id: option.rows[0]!.id,
  });
  const session = await createPaymentSession(a, cart.id, { provider: 'stripe' });
  fake.clientConfirm(session.session_id);
  const { order } = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `place-${randomUUID()}`,
    actor: customer,
  });
  const p = await owner.query<{ id: string; amount_minor: string; provider_payment_id: string }>(
    `SELECT id, amount_minor::text, provider_payment_id FROM payment WHERE order_id = $1`,
    [order.id],
  );
  await capturePayment(a, p.rows[0]!.id, { actor: staff, apiFactory: () => fake, env });
  return {
    orderId: order.id,
    paymentId: p.rows[0]!.id,
    intentId: p.rows[0]!.provider_payment_id,
    captured: Number(p.rows[0]!.amount_minor),
  };
}

async function refundsOf(orderId: string) {
  const r = await owner.query<{
    amount_minor: string;
    currency: string;
    reason: string;
    status: string;
    provider_refund_id: string | null;
  }>(
    `SELECT amount_minor::text, currency, reason, status, provider_refund_id FROM refund
     WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  return r.rows.map((x) => ({ ...x, amount_minor: Number(x.amount_minor) }));
}

async function issuedCount(orderId: string) {
  const r = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox WHERE topic = 'refund.issued' AND payload->>'order_id' = $1`,
    [orderId],
  );
  return r.rows[0]!.n;
}

async function orderOf(orderId: string) {
  const r = await owner.query<{
    status: string;
    payment_status: string;
    metadata: Record<string, unknown>;
  }>(`SELECT status, payment_status, metadata FROM "order" WHERE id = $1`, [orderId]);
  return r.rows[0]!;
}

function signed(body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  return { raw, header: signStripePayload(raw, WEBHOOK_SECRET) };
}

async function deliver(body: Record<string, unknown>) {
  const { raw, header } = signed({
    id: `evt_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    request: { id: null, idempotency_key: null },
    ...body,
  });
  return handleStripeWebhook({
    client: a,
    storeCode: codeA,
    rawBody: raw,
    signatureHeader: header,
    env,
    apiFactory: () => fake,
    log: () => {},
  });
}

describe('orphan PSP refunds are reconciled from Stripe (#918)', () => {
  it('a refund made at Stripe without us: one row + one refund.issued, amount and currency FROM STRIPE; a second run adds nothing', async () => {
    const o = await capturedOrder();
    const outside = fake.refundOutsideUs(o.intentId, 123); // a Dashboard refund: no metadata of ours
    const created = await reconcilePaymentRefunds(a, {
      paymentId: o.paymentId,
      api: fake,
      actor: system,
    });
    expect(created).toHaveLength(1);
    expect(await refundsOf(o.orderId)).toEqual([
      {
        amount_minor: 123,
        currency: 'EUR',
        reason: 'goodwill',
        status: 'succeeded',
        provider_refund_id: outside.id,
      },
    ]);
    expect(await issuedCount(o.orderId)).toBe(1);
    expect((await orderOf(o.orderId)).payment_status).toBe('partially_refunded');
    expect(
      await reconcilePaymentRefunds(a, { paymentId: o.paymentId, api: fake, actor: system }),
    ).toEqual([]);
    expect(await issuedCount(o.orderId)).toBe(1);
  });

  it('our own refund whose answer was lost: reconciled with ITS reason from the metadata (cancellation)', async () => {
    const o = await capturedOrder();
    fake.refundOutsideUs(o.intentId, o.captured, { reason: 'cancellation', order_id: o.orderId });
    await reconcilePaymentRefunds(a, { paymentId: o.paymentId, api: fake, actor: system });
    expect(await refundsOf(o.orderId)).toEqual([
      expect.objectContaining({
        amount_minor: o.captured,
        reason: 'cancellation',
        status: 'succeeded',
      }),
    ]);
    expect((await orderOf(o.orderId)).payment_status).toBe('refunded');
  });

  it('a PENDING row of ours is never duplicated, even when Stripe already settled it', async () => {
    const o = await capturedOrder();
    fake.pendingNextRefund = true;
    expect(
      (
        await request(app)
          .post(`/admin/stores/${A}/orders/${o.orderId}/cancel`)
          .set('Authorization', 'Bearer dev:seed-store-admin')
          .send({ reason: 'customer request' })
      ).status,
    ).toBe(200);
    const [row] = await refundsOf(o.orderId);
    expect(row).toMatchObject({ status: 'pending' });
    // Stripe settles it, our webhook has not arrived yet
    const stripeRefund = fake.refunds.get(row!.provider_refund_id!)!;
    stripeRefund.status = 'succeeded';
    expect(
      await reconcilePaymentRefunds(a, { paymentId: o.paymentId, api: fake, actor: system }),
    ).toEqual([]);
    expect(await refundsOf(o.orderId)).toHaveLength(1);
    expect(await issuedCount(o.orderId)).toBe(0);
  });

  it('charge.refunded through the signed webhook reconciles after its commit', async () => {
    const o = await capturedOrder();
    fake.refundOutsideUs(o.intentId, 77);
    const out = await deliver({
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_${randomUUID().slice(0, 8)}`,
          object: 'charge',
          payment_intent: o.intentId,
        },
      },
    });
    expect(out).toMatchObject({ kind: 'processed' });
    expect(await refundsOf(o.orderId)).toEqual([
      expect.objectContaining({ amount_minor: 77, reason: 'goodwill', status: 'succeeded' }),
    ]);
    expect(await issuedCount(o.orderId)).toBe(1);
  });
});

describe('a refund that fails at the PSP on a cancelled order (#918)', () => {
  it('flags refund_attention (order.updated + audit); a later successful refund clears it (audited)', async () => {
    const o = await capturedOrder();
    fake.pendingNextRefund = true;
    await request(app)
      .post(`/admin/stores/${A}/orders/${o.orderId}/cancel`)
      .set('Authorization', 'Bearer dev:seed-store-admin')
      .send({ reason: 'customer request' });
    const [pending] = await refundsOf(o.orderId);
    const failed = fake.failRefund(pending!.provider_refund_id!);
    const out = await deliver({
      type: 'refund.updated',
      data: {
        object: {
          id: failed.id,
          object: 'refund',
          status: 'failed',
          failure_reason: 'expired_or_canceled_card',
          amount: failed.amount,
          currency: 'eur',
          payment_intent: o.intentId,
        },
      },
    });
    expect(out).toMatchObject({ kind: 'processed' });
    const flagged = await orderOf(o.orderId);
    expect(flagged).toMatchObject({ status: 'cancelled', payment_status: 'captured' });
    expect(flagged.metadata.refund_attention).toMatchObject({ reason: 'expired_or_canceled_card' });
    const audit = async () =>
      (
        await owner.query<{ action: string }>(
          `SELECT action FROM audit_log WHERE entity_type = 'order' AND entity_id = $1
             AND action LIKE 'order.refund_attention%' ORDER BY created_at`,
          [o.orderId],
        )
      ).rows.map((r) => r.action);
    expect(await audit()).toEqual(['order.refund_attention']);

    // a human re-issues the refund (Admin createRefund, a fresh key): it succeeds → the flag goes
    await createRefund(a, {
      orderId: o.orderId,
      amountMinor: o.captured,
      reason: 'cancellation',
      idempotencyKey: `reissue-${randomUUID()}`,
      actor: staff,
      requestedBy: SEED_IDS.users.storeAdmin,
    });
    const cleared = await orderOf(o.orderId);
    expect(cleared.metadata.refund_attention).toBeUndefined();
    expect(cleared.payment_status).toBe('refunded');
    expect(await audit()).toEqual(['order.refund_attention', 'order.refund_attention_cleared']);
  });
});

describe('the Stripe client timeout (#918)', () => {
  it('a request that does not answer in time is aborted with a TimeoutError — never a (definitive) StripeError', async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const client = new StripeClient({
      secretKey: 'fixture-not-a-key',
      fetch: hanging,
      timeoutMs: 30,
    });
    const err = await client.retrievePaymentIntent('pi_x').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StripeError);
    expect((err as Error).name).toBe('TimeoutError');
  });
});
