// Payments module (issue #124) on FakeStripe + a fully seeded throwaway database: credential precedence and
// fail-closed behaviour, the fetch client's encoding/headers/error mapping, session create/reuse/replace,
// authorize (confirm idempotency, declines, amount mismatch), full placement with the `stripe` provider,
// capture (row + fee + events + order transition, replay convergence, definitive failure, outage), refunds,
// and a PII scan over everything that left the process.
import { randomUUID } from 'node:crypto';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import {
  completeCart,
  createPaymentSession,
  setPaymentProvider,
  type PaymentCartRef,
  type StorePaymentSession,
} from '../checkout';
import {
  capturePayment,
  confirmIdempotencyKey,
  createStripePaymentProvider,
  envSuffix,
  FakeStripe,
  formEncode,
  STRIPE_API_VERSION,
  StripeClient,
  StripeError,
  stripeCredentialsFor,
  voidIdempotencyKey,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const actor = { id: null, type: 'customer' as const, requestId: 'req-payments' };
const staffActor = { id: null, type: 'system' as const, requestId: 'req-payments-capture' };
const env = { STRIPE_SECRET_KEY: 'sk_test_fake_global' } as NodeJS.ProcessEnv;
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
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let variants: { id: string }[];
let standardOptionId: string;
let fake: FakeStripe;

beforeAll(async () => {
  db = await createTestDatabase('core_payments');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
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
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

beforeEach(() => {
  fake = new FakeStripe();
  setPaymentProvider(createStripePaymentProvider({ apiFactory: () => fake, env }));
});

let counter = 0;
/** A brand-a cart with one line, email, addresses, the standard option and a STRIPE payment session. */
async function readyCart(): Promise<{ id: string; session: StorePaymentSession }> {
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
  return { id: cart.id, session };
}

/** Places an order paid with stripe and returns ids. */
async function placedOrder(): Promise<{ orderId: string; paymentId: string; intentId: string }> {
  const cart = await readyCart();
  fake.clientConfirm(cart.session.session_id);
  const { order } = await completeCart(a, {
    cartId: cart.id,
    idempotencyKey: `place-${randomUUID()}`,
    actor,
  });
  const p = await owner.query<{ id: string; provider_payment_id: string }>(
    `SELECT id, provider_payment_id FROM payment WHERE order_id = $1`,
    [order.id],
  );
  return { orderId: order.id, paymentId: p.rows[0]!.id, intentId: p.rows[0]!.provider_payment_id };
}

/** The stored `payment.idempotency_key` (window 1 prefixes it with the store id since core 2.3). */
async function idempotencyKeyOf(paymentId: string): Promise<string> {
  const r = await owner.query<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM payment WHERE id = $1`,
    [paymentId],
  );
  return r.rows[0]!.idempotency_key;
}

const cartRef = (amountMinor: number): PaymentCartRef => ({
  cartId: randomUUID(),
  organizationId: ORG,
  storeId: A,
  currency: 'EUR',
  amountMinor,
  email: null,
});

const sessionFor = (intentId: string, amountMinor: number): StorePaymentSession => ({
  provider: 'stripe',
  session_id: intentId,
  client_secret: `${intentId}_secret_fake`,
  status: 'pending',
  amount: { amount_minor: amountMinor, currency: 'EUR' },
});

describe('credentials', () => {
  it('store-suffixed variables win over the global pair; suffix derives from the code', () => {
    expect(envSuffix('brand-a')).toBe('BRAND_A');
    const e = {
      STRIPE_SECRET_KEY: 'sk_test_global',
      STRIPE_SECRET_KEY_BRAND_A: 'sk_test_store',
      STRIPE_WEBHOOK_SECRET: 'whsec_global',
    } as NodeJS.ProcessEnv;
    expect(stripeCredentialsFor('brand-a', e)).toEqual({
      secretKey: 'sk_test_store',
      webhookSecret: 'whsec_global',
      source: 'store',
    });
    expect(stripeCredentialsFor('brand-b', e)).toMatchObject({
      secretKey: 'sk_test_global',
      source: 'global',
    });
  });

  it('fails closed when no key is set: the error names the variables and never a value', () => {
    const e = { STRIPE_WEBHOOK_SECRET: 'whsec_only' } as NodeJS.ProcessEnv;
    expect(() => stripeCredentialsFor('brand-a', e)).toThrowError(
      /STRIPE_SECRET_KEY_BRAND_A or STRIPE_SECRET_KEY/,
    );
    try {
      stripeCredentialsFor('brand-a', e);
    } catch (err) {
      expect((err as Error).message).not.toContain('whsec_only');
    }
  });

  it('refuses live-mode keys (Phase 2 is test mode only)', () => {
    expect(() =>
      stripeCredentialsFor('brand-a', { STRIPE_SECRET_KEY: 'sk_live_oops' } as NodeJS.ProcessEnv),
    ).toThrowError(/test mode only/);
  });

  it('reads the environment on every call: rotation needs no restart', () => {
    const e = { STRIPE_SECRET_KEY: 'sk_test_one' } as NodeJS.ProcessEnv;
    expect(stripeCredentialsFor('brand-a', e).secretKey).toBe('sk_test_one');
    e.STRIPE_SECRET_KEY = 'sk_test_two';
    expect(stripeCredentialsFor('brand-a', e).secretKey).toBe('sk_test_two');
  });
});

describe('StripeClient', () => {
  it('form-encodes nested params Stripe-style', () => {
    expect(
      formEncode({
        amount: 100,
        metadata: { cart_id: 'c 1' },
        automatic_payment_methods: { enabled: true },
        expand: ['latest_charge.balance_transaction'],
        skipped: undefined,
      }),
    ).toBe(
      'amount=100&metadata%5Bcart_id%5D=c%201&automatic_payment_methods%5Benabled%5D=true' +
        '&expand%5B0%5D=latest_charge.balance_transaction',
    );
  });

  it('sends auth, pinned version, idempotency key; GET puts expand in the query', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: unknown, init: unknown) => {
      seen.push({ url: String(url), init: init as RequestInit });
      return new Response(JSON.stringify({ id: 'pi_x', object: 'payment_intent' }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = new StripeClient({ secretKey: 'sk_test_abc', fetch: fetchFn });
    await client.createPaymentIntent({ amount: 5, currency: 'eur' }, { idempotencyKey: 'ik_1' });
    await client.retrievePaymentIntent('pi_x', { expand: ['latest_charge'] });
    const post = seen[0]!;
    const headers = post.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_test_abc');
    expect(headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
    expect(headers['Idempotency-Key']).toBe('ik_1');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(post.init.body).toBe('amount=5&currency=eur');
    expect(post.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(seen[1]!.url).toBe(
      'https://api.stripe.com/v1/payment_intents/pi_x?expand%5B0%5D=latest_charge',
    );
    expect(seen[1]!.init.body).toBeUndefined();
  });

  it('maps non-2xx to StripeError with Stripe fields, never the raw body; definitive = 4xx minus 429', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          error: {
            type: 'card_error',
            code: 'card_declined',
            decline_code: 'insufficient_funds',
            message: 'Your card was declined.',
            secret_leak: 'should never surface',
          },
        }),
        { status: 402, headers: { 'request-id': 'req_123' } },
      )) as typeof fetch;
    const client = new StripeClient({ secretKey: 'sk_test_abc', fetch: fetchFn });
    const err = await client
      .createRefund({ payment_intent: 'pi_x' })
      .catch((e) => e as StripeError);
    expect(err).toBeInstanceOf(StripeError);
    expect(err).toMatchObject({
      status: 402,
      type: 'card_error',
      code: 'card_declined',
      declineCode: 'insufficient_funds',
      message: 'Your card was declined.',
      requestId: 'req_123',
      definitive: true,
    });
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain('secret_leak');
    expect(new StripeError(500, 'boom').definitive).toBe(false);
    expect(new StripeError(429, 'slow down').definitive).toBe(false);
  });
});

describe('createSession', () => {
  it('creates a manual-capture intent with ids-only metadata and stores the contract session on the cart', async () => {
    const cart = await readyCart();
    expect(cart.session.provider).toBe('stripe');
    expect(cart.session.session_id).toMatch(/^pi_/);
    expect(cart.session.client_secret).toContain('_secret_');
    expect(cart.session.status).toBe('pending');
    const created = fake.callsOf('createPaymentIntent')[0]!;
    expect(created.params.capture_method).toBe('manual');
    expect(created.params.metadata).toEqual({
      cart_id: cart.id,
      store_id: A,
      organization_id: ORG,
    });
    const row = await owner.query<{ payment_session: StorePaymentSession; total_minor: string }>(
      `SELECT payment_session, total_minor::text FROM cart WHERE id = $1`,
      [cart.id],
    );
    expect(row.rows[0]!.payment_session).toEqual(cart.session);
    expect(cart.session.amount.amount_minor).toBe(Number(row.rows[0]!.total_minor));
    expect(fake.intents.get(cart.session.session_id)!.amount).toBe(
      cart.session.amount.amount_minor,
    );
  });

  it('reuses the intent on a second call (update, no second create) so the Payment Element stays mounted', async () => {
    const cart = await readyCart();
    const again = await createPaymentSession(a, cart.id, { provider: 'stripe' });
    expect(again.session_id).toBe(cart.session.session_id);
    expect(fake.callsOf('createPaymentIntent')).toHaveLength(1);
    expect(fake.callsOf('updatePaymentIntent')).toHaveLength(1);
  });

  it('replaces a confirmed intent whose amount no longer matches (best-effort cancel + new intent)', async () => {
    const cart = await readyCart();
    fake.clientConfirm(cart.session.session_id);
    await addLineItem(a, cart.id, { variant_id: variants[5 % variants.length]!.id, quantity: 1 });
    const replaced = await createPaymentSession(a, cart.id, { provider: 'stripe' });
    expect(replaced.session_id).not.toBe(cart.session.session_id);
    expect(fake.intents.get(cart.session.session_id)!.status).toBe('canceled');
    expect(replaced.status).toBe('pending');
  });

  it('fails closed as a 400 naming the variable when the store has no stripe credentials', async () => {
    setPaymentProvider(
      createStripePaymentProvider({ apiFactory: () => fake, env: {} as NodeJS.ProcessEnv }),
    );
    const n = counter++;
    const cart = await createCart(a, scopeA, {});
    await addLineItem(a, cart.id, { variant_id: variants[n % variants.length]!.id, quantity: 1 });
    await expect(createPaymentSession(a, cart.id, { provider: 'stripe' })).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringContaining('STRIPE_SECRET_KEY'),
    });
  });
});

describe('authorize', () => {
  const provider = () => createStripePaymentProvider({ apiFactory: () => fake, env });

  it('confirms server-side when the intent awaits confirmation, idempotently on the derived key', async () => {
    const intent = await fake.createPaymentIntent({
      amount: 500,
      currency: 'eur',
      capture_method: 'manual',
    });
    fake.attachPaymentMethod(intent.id);
    const key = 'placement-key-12345678';
    const p = provider();
    const run = () =>
      a.transaction((tx) =>
        p.authorize({
          tx,
          cart: cartRef(500),
          session: sessionFor(intent.id, 500),
          idempotencyKey: key,
        }),
      );
    const first = await run();
    expect(first).toEqual({ status: 'authorized', providerPaymentId: intent.id });
    const second = await run(); // retry after a crash: intent already requires_capture → no second confirm
    expect(second.status).toBe('authorized');
    const confirms = fake.callsOf('confirmPaymentIntent');
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.idempotencyKey).toBe(confirmIdempotencyKey(key));
    expect(confirms[0]!.idempotencyKey).not.toContain(key); // derived (hashed), not the raw key
    expect(fake.intents.size).toBe(1); // replay created no second intent
  });

  it('maps a decline to failed with the decline code; an unconfirmed intent to failed', async () => {
    const intent = await fake.createPaymentIntent({
      amount: 500,
      currency: 'eur',
      capture_method: 'manual',
    });
    fake.attachPaymentMethod(intent.id);
    fake.declineNextConfirm = 'insufficient_funds';
    const p = provider();
    const declined = await a.transaction((tx) =>
      p.authorize({
        tx,
        cart: cartRef(500),
        session: sessionFor(intent.id, 500),
        idempotencyKey: 'k1-12345678',
      }),
    );
    expect(declined).toMatchObject({ status: 'failed', failureReason: 'insufficient_funds' });
    const bare = await fake.createPaymentIntent({
      amount: 500,
      currency: 'eur',
      capture_method: 'manual',
    });
    const unconfirmed = await a.transaction((tx) =>
      p.authorize({
        tx,
        cart: cartRef(500),
        session: sessionFor(bare.id, 500),
        idempotencyKey: 'k2-12345678',
      }),
    );
    expect(unconfirmed.status).toBe('failed');
  });

  it('refuses an amount or currency mismatch BEFORE confirming: no hold is ever placed for the wrong total', async () => {
    const confirmed = await fake.createPaymentIntent({
      amount: 999,
      currency: 'eur',
      capture_method: 'manual',
    });
    fake.clientConfirm(confirmed.id);
    const p = provider();
    const r = await a.transaction((tx) =>
      p.authorize({
        tx,
        cart: cartRef(500),
        session: sessionFor(confirmed.id, 999),
        idempotencyKey: 'k3-12345678',
      }),
    );
    expect(r).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('amount mismatch'),
    });
    // Unconfirmed intent with a stale amount: authorize must fail WITHOUT calling confirm — otherwise the
    // customer's card would carry an authorization hold for a total the order does not have.
    const stale = await fake.createPaymentIntent({
      amount: 999,
      currency: 'eur',
      capture_method: 'manual',
    });
    fake.attachPaymentMethod(stale.id);
    const before = fake.callsOf('confirmPaymentIntent').length;
    const r2 = await a.transaction((tx) =>
      p.authorize({
        tx,
        cart: cartRef(500),
        session: sessionFor(stale.id, 999),
        idempotencyKey: 'k4-12345678',
      }),
    );
    expect(r2).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('amount mismatch'),
    });
    expect(fake.callsOf('confirmPaymentIntent')).toHaveLength(before);
    expect(fake.intents.get(stale.id)!.status).toBe('requires_confirmation'); // untouched, no hold
  });

  it('places a full order through completeCart with the stripe provider; a decline places nothing', async () => {
    const { orderId, paymentId, intentId } = await placedOrder();
    const p = await owner.query<{ provider: string; status: string; idempotency_key: string }>(
      `SELECT provider, status, idempotency_key FROM payment WHERE id = $1`,
      [paymentId],
    );
    expect(p.rows[0]).toMatchObject({ provider: 'stripe', status: 'authorized' });
    expect(intentId).toMatch(/^pi_/);
    expect(fake.intents.get(intentId)!.status).toBe('requires_capture'); // authorized, not yet captured
    const placed = await owner.query(
      `SELECT 1 FROM outbox WHERE topic = 'order.placed' AND aggregate_id = $1`,
      [orderId],
    );
    expect(placed.rows).toHaveLength(1);

    const cart = await readyCart();
    fake.attachPaymentMethod(cart.session.session_id);
    fake.declineNextConfirm = 'generic_decline';
    await expect(
      completeCart(a, { cartId: cart.id, idempotencyKey: `declined-${randomUUID()}`, actor }),
    ).rejects.toMatchObject({ code: 'payment_failed' });
    const orders = await owner.query(`SELECT 1 FROM "order" WHERE cart_id = $1`, [cart.id]);
    expect(orders.rows).toHaveLength(0);
    // A decline never authorised anything, so there is no hold to release: nothing cancels that intent.
    expect(fake.callsOf('cancelPaymentIntent').map((c) => c.id)).not.toContain(
      cart.session.session_id,
    );
  });

  it('releases the hold when placement fails AFTER authorising (checkout catch → provider.void)', async () => {
    const cart = await readyCart();
    fake.clientConfirm(cart.session.session_id);
    const key = `boom-${randomUUID()}`;
    await expect(
      completeCart(a, {
        cartId: cart.id,
        idempotencyKey: key,
        actor,
        hooks: {
          afterEvents: () => {
            throw new Error('injected failure after the outbox insert');
          },
        },
      }),
    ).rejects.toThrow('injected failure');
    // The authorisation was placed and then released: the intent is cancelled with the key the checkout
    // module derives (`<Idempotency-Key>:void`), and nothing of the order survives the rollback.
    const cancel = fake
      .callsOf('cancelPaymentIntent')
      .find((c) => c.id === cart.session.session_id);
    expect(cancel?.idempotencyKey).toBe(voidIdempotencyKey(`${key}:void`));
    expect(fake.intents.get(cart.session.session_id)!.status).toBe('canceled');
    const orders = await owner.query(`SELECT 1 FROM "order" WHERE cart_id = $1`, [cart.id]);
    expect(orders.rows).toHaveLength(0);
  });
});

describe('void (authorisation hold released on cancel)', () => {
  const provider = () => createStripePaymentProvider({ apiFactory: () => fake, env });

  it('cancels the intent with the derived key and is a no-op on replay and on an already-cancelled intent', async () => {
    const { paymentId, intentId } = await placedOrder();
    const key = await idempotencyKeyOf(paymentId);
    const p = provider();
    const first = await a.transaction((tx) =>
      p.void({ tx, providerPaymentId: intentId, idempotencyKey: `${key}:void`, reason: 'cancel' }),
    );
    expect(first).toEqual({ status: 'voided' });
    expect(fake.intents.get(intentId)!.status).toBe('canceled');
    const cancel = fake.callsOf('cancelPaymentIntent').at(-1)!;
    expect(cancel.idempotencyKey).toBe(voidIdempotencyKey(`${key}:void`));

    // Same key again → Stripe replays its recorded response: still voided, no error.
    const replay = await a.transaction((tx) =>
      p.void({ tx, providerPaymentId: intentId, idempotencyKey: `${key}:void`, reason: 'cancel' }),
    );
    expect(replay).toEqual({ status: 'voided' });

    // A *fresh* key on an already-cancelled intent hits payment_intent_unexpected_state → still voided:
    // the hold is gone, which is all the caller needs.
    const fresh = await a.transaction((tx) =>
      p.void({
        tx,
        providerPaymentId: intentId,
        idempotencyKey: `${key}:void:2`,
        reason: 'cancel',
      }),
    );
    expect(fresh).toEqual({ status: 'voided' });
  });

  it('refuses to void a captured payment: that money needs a refund, not a cancel', async () => {
    const { paymentId, intentId } = await placedOrder();
    await capturePayment(a, paymentId, { actor: staffActor, apiFactory: () => fake, env });
    expect(fake.intents.get(intentId)!.status).toBe('succeeded');
    const key = await idempotencyKeyOf(paymentId);
    const r = await a.transaction((tx) =>
      provider().void({
        tx,
        providerPaymentId: intentId,
        idempotencyKey: `${key}:void`,
        reason: 'customer changed their mind',
      }),
    );
    expect(r.status).toBe('failed');
    expect(r.failureReason).toContain('captured');
    expect(fake.intents.get(intentId)!.status).toBe('succeeded'); // untouched
  });

  it('fails on an unknown payment and rethrows an outage instead of reporting a void', async () => {
    const unknown = await a.transaction((tx) =>
      provider().void({
        tx,
        providerPaymentId: 'pi_not_ours',
        idempotencyKey: 'k:void',
        reason: 'cancel',
      }),
    );
    expect(unknown).toMatchObject({ status: 'failed', failureReason: 'unknown stripe payment' });

    const { paymentId, intentId } = await placedOrder();
    const key = await idempotencyKeyOf(paymentId);
    fake.outageNextCancel = true;
    await expect(
      a.transaction((tx) =>
        provider().void({
          tx,
          providerPaymentId: intentId,
          idempotencyKey: `${key}:void`,
          reason: 'cancel',
        }),
      ),
    ).rejects.toThrow(StripeError);
    expect(fake.intents.get(intentId)!.status).toBe('requires_capture'); // hold still there
  });
});

describe('capturePayment', () => {
  const opts = () => ({ actor: staffActor, apiFactory: () => fake, env });

  it('captures at Stripe and writes row + fee + payment.captured + the order transition', async () => {
    const { orderId, paymentId } = await placedOrder();
    const r = await capturePayment(a, paymentId, opts());
    expect(r.replayed).toBe(false);
    expect(r.payment).toMatchObject({ status: 'captured', fee_minor: '123' });
    expect(r.payment.captured_at).not.toBeNull();
    const capture = fake.callsOf('capturePaymentIntent')[0]!;
    expect(capture.idempotencyKey).toBe(`capture_${paymentId}`);
    expect(capture.expand).toEqual(['latest_charge.balance_transaction']);
    const events = await owner.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [paymentId],
    );
    // Placement emits `payment.authorized` (window 1's checkout, #176 part 2); capture adds `payment.captured`.
    // Asserting the whole ordered sequence documents that split and catches a duplicate from either side.
    expect(events.rows.map((e) => e.topic)).toEqual(['payment.authorized', 'payment.captured']);
    expect(events.rows.at(-1)!.payload).toMatchObject({
      payment_id: paymentId,
      order_id: orderId,
      provider: 'stripe',
      fee_minor: 123,
      currency: 'EUR',
    });
    expect(events.rows[0]!.payload.legal_entity_id).toBeTruthy();
    const order = await owner.query<{ payment_status: string }>(
      `SELECT payment_status FROM "order" WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]!.payment_status).toBe('captured');
    const updated = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = 'order.updated' AND aggregate_id = $1`,
      [orderId],
    );
    expect(updated.rows).toHaveLength(1);
    expect(updated.rows[0]!.payload.changed_fields).toEqual(['payment_status']);
  });

  it('replays as a no-op (no Stripe call, no new events) and converges a half-done capture', async () => {
    const { orderId, paymentId } = await placedOrder();
    await capturePayment(a, paymentId, opts());
    const replay = await capturePayment(a, paymentId, opts());
    expect(replay.replayed).toBe(true);
    expect(fake.callsOf('capturePaymentIntent')).toHaveLength(1);
    const captured = await owner.query(
      `SELECT 1 FROM outbox WHERE topic = 'payment.captured' AND aggregate_id = $1`,
      [paymentId],
    );
    expect(captured.rows).toHaveLength(1);
    // Simulated crash between the payment transaction and the order transition:
    await db.owner.query(`UPDATE "order" SET payment_status = 'authorized' WHERE id = $1`, [
      orderId,
    ]);
    const heal = await capturePayment(a, paymentId, opts());
    expect(heal.replayed).toBe(true);
    const order = await owner.query<{ payment_status: string }>(
      `SELECT payment_status FROM "order" WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]!.payment_status).toBe('captured');
  });

  it('definitive failure → row failed + payment.failed + order failed + 402; then 409 on retry', async () => {
    const { orderId, paymentId } = await placedOrder();
    fake.failNextCapture = 'expired_card';
    await expect(capturePayment(a, paymentId, opts())).rejects.toMatchObject({
      code: 'payment_failed',
    });
    const p = await owner.query<{ status: string; failure_reason: string }>(
      `SELECT status, failure_reason FROM payment WHERE id = $1`,
      [paymentId],
    );
    expect(p.rows[0]).toEqual({ status: 'failed', failure_reason: 'expired_card' });
    const failed = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = 'payment.failed' AND aggregate_id = $1`,
      [paymentId],
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]!.payload.failure_reason).toBe('expired_card');
    const order = await owner.query<{ payment_status: string }>(
      `SELECT payment_status FROM "order" WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]!.payment_status).toBe('failed');
    await expect(capturePayment(a, paymentId, opts())).rejects.toMatchObject({
      code: 'conflict',
      details: { from: 'failed', to: 'captured' },
    });
  });

  it('an outage writes nothing and rethrows; the retry then succeeds', async () => {
    const { paymentId } = await placedOrder();
    // Baseline: placement already wrote `payment.authorized` for this payment (window 1, #176 part 2).
    const before = await owner.query<{ topic: string }>(
      `SELECT topic FROM outbox WHERE aggregate_id = $1`,
      [paymentId],
    );
    fake.outageNextCapture = true;
    await expect(capturePayment(a, paymentId, opts())).rejects.toBeInstanceOf(StripeError);
    const p = await owner.query<{ status: string }>(`SELECT status FROM payment WHERE id = $1`, [
      paymentId,
    ]);
    expect(p.rows[0]!.status).toBe('authorized');
    const events = await owner.query<{ topic: string }>(
      `SELECT topic FROM outbox WHERE aggregate_id = $1`,
      [paymentId],
    );
    expect(events.rows.map((e) => e.topic)).toEqual(before.rows.map((e) => e.topic)); // the outage added none
    const retry = await capturePayment(a, paymentId, opts());
    expect(retry.payment.status).toBe('captured');
  });

  it('refuses a non-stripe payment with 400', async () => {
    const n = counter++;
    const cart = await createCart(a, scopeA, {});
    await addLineItem(a, cart.id, { variant_id: variants[n % variants.length]!.id, quantity: 1 });
    await updateCart(a, cart.id, {
      email: `jane.doe+${n}@example.com`,
      shipping_address: address,
      billing_address: { ...address, country: 'NL' },
      shipping_option_id: standardOptionId,
    });
    await createPaymentSession(a, cart.id, { provider: 'manual' });
    const { order } = await completeCart(a, {
      cartId: cart.id,
      idempotencyKey: `manual-${randomUUID()}`,
      actor,
    });
    const p = await owner.query<{ id: string }>(`SELECT id FROM payment WHERE order_id = $1`, [
      order.id,
    ]);
    await expect(capturePayment(a, p.rows[0]!.id, opts())).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});

describe('refund (provider seam for task 2.3)', () => {
  const provider = () => createStripePaymentProvider({ apiFactory: () => fake, env });

  it('refunds through Stripe with the refund idempotency key; replay returns the same refund', async () => {
    const { paymentId, intentId } = await placedOrder();
    await capturePayment(a, paymentId, { actor: staffActor, apiFactory: () => fake, env });
    const p = provider();
    const input = {
      providerPaymentId: intentId,
      amountMinor: 100,
      currency: 'EUR',
      idempotencyKey: 'refund-key-12345678',
      reason: 'goodwill',
    };
    const first = await a.transaction((tx) => p.refund({ tx, ...input }));
    expect(first.status).toBe('succeeded');
    expect(first.providerRefundId).toMatch(/^re_/);
    const second = await a.transaction((tx) => p.refund({ tx, ...input }));
    expect(second.providerRefundId).toBe(first.providerRefundId);
    expect(fake.refunds.size).toBe(1);
    expect(fake.callsOf('createRefund')[0]!.idempotencyKey).toBe('refund_refund-key-12345678');
  });

  it('maps a Stripe refund failure and an unknown payment to failed', async () => {
    const { paymentId, intentId } = await placedOrder();
    await capturePayment(a, paymentId, { actor: staffActor, apiFactory: () => fake, env });
    fake.failNextRefund = 'charge_already_refunded';
    const p = provider();
    const failed = await a.transaction((tx) =>
      p.refund({
        tx,
        providerPaymentId: intentId,
        amountMinor: 100,
        currency: 'EUR',
        idempotencyKey: 'refund-fail-12345678',
        reason: 'goodwill',
      }),
    );
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'charge_already_refunded' });
    const unknown = await a.transaction((tx) =>
      p.refund({
        tx,
        providerPaymentId: 'pi_never_seen',
        amountMinor: 100,
        currency: 'EUR',
        idempotencyKey: 'refund-unknown-12345678',
        reason: 'goodwill',
      }),
    );
    expect(unknown).toMatchObject({ status: 'failed', failureReason: 'unknown stripe payment' });
  });
});

describe('PII', () => {
  it('nothing that left the process contains an email, a name or an address', async () => {
    const { paymentId } = await placedOrder();
    await capturePayment(a, paymentId, { actor: staffActor, apiFactory: () => fake, env });
    const wire = JSON.stringify(fake.calls);
    expect(wire).not.toMatch(/@example\.com/i);
    expect(wire).not.toContain('Jane');
    expect(wire).not.toContain('Keizersgracht');
    expect(wire).not.toContain('Amsterdam');
  });
});
