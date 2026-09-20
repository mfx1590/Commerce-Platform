// Fraud module (issue #128) on a seeded throwaway database + FakeStripe: the rules provider (velocity per email
// hash with store isolation and window, mismatched countries, settings), the Radar provider (risk levels, manual
// review, non-stripe payments), worst-outcome-wins, provider outage → review with a log line and a metric,
// a `review` outcome holding the order (pending, flagged, `order.updated` with the reason code and no PII,
// capture refused until cleared), a `block` answering exactly like a decline with the real reason in the audit
// log, Radar's `review.opened` / `review.closed` webhooks, and the shared per-store credential loader.
import { randomUUID } from 'node:crypto';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { addLineItem, createCart, updateCart } from '../cart';
import {
  completeCart,
  createPaymentSession,
  currentFraudCheck as currentCheckoutFraudCheck,
  emailHash,
  setPaymentProvider,
} from '../checkout';
import {
  capturePayment,
  createStripePaymentProvider,
  FakeStripe,
  getWebhookEvent,
  handleStripeWebhook,
  registerWebhookHandler,
  requireStoreSecret,
  signStripePayload,
  storeSecretFor,
} from '../payments';
import {
  createFraudCheck,
  currentFraudCheck,
  DEFAULT_FRAUD_SETTINGS,
  flagOrderForReview,
  fraudMetrics,
  fraudSettingsFrom,
  RADAR_WEBHOOK_HANDLERS,
  readOrderFraud,
  registerFraudCheck,
  resolveOrderReview,
  setFraudCheck,
  worse,
  type FraudContext,
  type FraudDecision,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const customer = { id: null, type: 'customer' as const, requestId: 'req-fraud' };
const staff = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-fraud' };
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
let b: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let codeA: string;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let variants: { id: string }[];
let standardOptionId: string;
let fake: FakeStripe;
let logged: string[];

beforeAll(async () => {
  db = await createTestDatabase('core_fraud');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
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
       AND coalesce((SELECT sum(il.available) FROM inventory_level il WHERE il.variant_id = v.id), 0) >= 20
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
  logged = [];
  fraudMetrics.reset();
  setPaymentProvider(createStripePaymentProvider({ apiFactory: () => fake, env }));
});

afterEach(async () => {
  setFraudCheck(null);
  for (const type of Object.keys(RADAR_WEBHOOK_HANDLERS)) registerWebhookHandler(type, null);
  await owner.query(`UPDATE store SET settings = settings - 'fraud'`);
});

async function setFraud(storeId: string, fraud: Record<string, unknown>): Promise<void> {
  await owner.query(
    `UPDATE store SET settings = jsonb_set(settings, '{fraud}', $2::jsonb) WHERE id = $1`,
    [storeId, JSON.stringify(fraud)],
  );
}

const check = (extra: Parameters<typeof createFraudCheck>[0] = {}) =>
  createFraudCheck({
    apiFactory: () => fake,
    env,
    log: (l) => logged.push(l),
    recordClient: () => a,
    deferredRecord: false, // tests record explicitly, AFTER the placement transaction has ended
    ...extra,
  });

let counter = 0;
/** A brand-a cart ready to place, paid with stripe and confirmed client-side. */
async function readyCart(opts: { email?: string; billingCountry?: string } = {}): Promise<{
  cartId: string;
  intentId: string;
  amount: number;
  email: string;
}> {
  const n = counter++;
  const email = opts.email ?? `fraud.test+${n}@example.com`;
  const cart = await createCart(a, scopeA, {});
  await addLineItem(a, cart.id, { variant_id: variants[n % variants.length]!.id, quantity: 1 });
  const priced = await updateCart(a, cart.id, {
    email,
    shipping_address: address,
    billing_address: { ...address, country: opts.billingCountry ?? 'NL' },
    shipping_option_id: standardOptionId,
  });
  const session = await createPaymentSession(a, cart.id, { provider: 'stripe' });
  fake.clientConfirm(session.session_id);
  return {
    cartId: cart.id,
    intentId: session.session_id,
    amount: priced.totals.total.amount_minor,
    email,
  };
}

async function place(cartId: string): Promise<{ orderId: string; paymentId: string }> {
  const { order } = await completeCart(a, {
    cartId,
    idempotencyKey: `place-${randomUUID()}`,
    actor: customer,
  });
  const p = await owner.query<{ id: string }>(`SELECT id FROM payment WHERE order_id = $1`, [
    order.id,
  ]);
  return { orderId: order.id, paymentId: p.rows[0]!.id };
}

function contextFor(
  tx: FraudContext['tx'],
  cart: { cartId: string; intentId: string; amount: number; email: string },
  over: Partial<FraudContext> = {},
): FraudContext {
  return {
    tx,
    organizationId: ORG,
    storeId: A,
    cartId: cart.cartId,
    amountMinor: cart.amount,
    currency: 'EUR',
    emailHash: emailHash(cart.email),
    shippingCountry: 'NL',
    billingCountry: 'NL',
    paymentProvider: 'stripe',
    providerSessionId: cart.intentId,
    actor: customer,
    ...over,
  };
}

const evaluate = (
  cart: Parameters<typeof contextFor>[1],
  over: Partial<FraudContext> = {},
  c = check(),
  client = a,
): Promise<FraudDecision> => client.transaction((tx) => c.evaluate(contextFor(tx, cart, over)));

// ---------------------------------------------------------------------------------------------- units

describe('settings and ranking', () => {
  it('store.settings.fraud: defaults, malformed input never throws, known values are read', () => {
    expect(fraudSettingsFrom(undefined)).toEqual(DEFAULT_FRAUD_SETTINGS);
    expect(fraudSettingsFrom({ fraud: 'on' })).toEqual(DEFAULT_FRAUD_SETTINGS);
    expect(
      fraudSettingsFrom({
        fraud: {
          providers: ['radar', 'sift', 'radar'],
          velocity: { max_orders: -1 },
          radar_highest: 'x',
        },
      }),
    ).toEqual({ ...DEFAULT_FRAUD_SETTINGS, providers: ['radar'] });
    expect(
      fraudSettingsFrom({
        fraud: {
          providers: ['rules'],
          velocity: { max_orders: 5, window_minutes: 10 },
          country_mismatch: 'allow',
          radar_highest: 'review',
        },
      }),
    ).toEqual({
      providers: ['rules'],
      velocity: { maxOrders: 5, windowMinutes: 10 },
      countryMismatch: 'allow',
      radarHighest: 'review',
    });
  });

  it('worst outcome wins; the first decision wins a tie', () => {
    const allow: FraudDecision = { outcome: 'allow', reasonCode: null, provider: null };
    const review: FraudDecision = {
      outcome: 'review',
      reasonCode: 'velocity_email',
      provider: 'rules',
    };
    const review2: FraudDecision = {
      outcome: 'review',
      reasonCode: 'radar_elevated',
      provider: 'radar',
    };
    const block: FraudDecision = {
      outcome: 'block',
      reasonCode: 'radar_highest',
      provider: 'radar',
    };
    expect(worse(allow, review)).toBe(review);
    expect(worse(review, allow)).toBe(review);
    expect(worse(review, review2)).toBe(review);
    expect(worse(review, block)).toBe(block);
    expect(worse(block, review)).toBe(block);
  });
});

describe('shared per-store credential loader', () => {
  it('the store-suffixed variable wins, the global one is the fallback, and it is read on every call', () => {
    const e = { RADAR_KEY: 'global-value', RADAR_KEY_BRAND_A: 'store-value' } as NodeJS.ProcessEnv;
    expect(storeSecretFor('brand-a', 'RADAR_KEY', e)).toEqual({
      value: 'store-value',
      variable: 'RADAR_KEY_BRAND_A',
      source: 'store',
    });
    expect(storeSecretFor('brand-b', 'RADAR_KEY', e)).toEqual({
      value: 'global-value',
      variable: 'RADAR_KEY',
      source: 'global',
    });
    e.RADAR_KEY_BRAND_A = 'rotated'; // rotation without a restart
    expect(storeSecretFor('brand-a', 'RADAR_KEY', e)!.value).toBe('rotated');
    expect(storeSecretFor('brand-a', 'OTHER', e)).toBeNull();
  });

  it('a missing secret fails closed at first use: the error names the variables and the path, never a value', () => {
    const e = { SOMETHING_ELSE: 'super-secret-value' } as NodeJS.ProcessEnv;
    let message = '';
    try {
      requireStoreSecret('brand-a', 'STRIPE_SECRET_KEY', 'stripe', e);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('STRIPE_SECRET_KEY_BRAND_A or STRIPE_SECRET_KEY');
    expect(message).toContain('<env>/stores/brand-a/stripe');
    expect(message).not.toContain('super-secret-value');
  });
});

// ---------------------------------------------------------------------------------------------- rules

describe('rules provider', () => {
  it('velocity per email hash: the threshold, the window, and the store boundary', async () => {
    await setFraud(A, { providers: ['rules'], velocity: { max_orders: 2, window_minutes: 60 } });
    const email = `Velocity.Shopper+${randomUUID().slice(0, 6)}@Example.com`;
    const first = await readyCart({ email });
    expect(await evaluate(first)).toMatchObject({ outcome: 'allow' });
    await place(first.cartId);
    const second = await readyCart({ email: ` ${email.toLowerCase()} ` }); // same person, other spelling
    expect(await evaluate(second)).toMatchObject({ outcome: 'allow' }); // 1 order so far
    await place(second.cartId);
    const third = await readyCart({ email });
    expect(await evaluate(third)).toEqual({
      outcome: 'review',
      reasonCode: 'velocity_email',
      provider: 'rules',
    });
    // Another store never sees brand-a's orders (RLS + store filter): same hash, no velocity there.
    await setFraud(B, { providers: ['rules'], velocity: { max_orders: 2, window_minutes: 60 } });
    expect(await evaluate(third, { storeId: B }, check(), b)).toMatchObject({ outcome: 'allow' });
    // Outside the window the old orders no longer count.
    await owner.query(
      `UPDATE "order" SET placed_at = now() - interval '2 hours' WHERE lower(btrim(email)) = $1`,
      [email.toLowerCase()],
    );
    expect(await evaluate(third)).toMatchObject({ outcome: 'allow' });
    // No email yet → nothing to count.
    expect(await evaluate(third, { emailHash: null })).toMatchObject({ outcome: 'allow' });
  });

  it('mismatched shipping and billing countries → review, or allow per store setting', async () => {
    await setFraud(A, { providers: ['rules'] });
    const cart = await readyCart();
    expect(await evaluate(cart, { billingCountry: 'de' })).toEqual({
      outcome: 'review',
      reasonCode: 'country_mismatch',
      provider: 'rules',
    });
    expect(await evaluate(cart, { billingCountry: 'nl' })).toMatchObject({ outcome: 'allow' });
    expect(await evaluate(cart, { billingCountry: null })).toMatchObject({ outcome: 'allow' });
    await setFraud(A, { providers: ['rules'], country_mismatch: 'allow' });
    expect(await evaluate(cart, { billingCountry: 'DE' })).toMatchObject({ outcome: 'allow' });
  });
});

// ---------------------------------------------------------------------------------------------- radar

describe('radar provider', () => {
  it('maps Radar risk levels and manual review; non-stripe payments are not asked', async () => {
    await setFraud(A, { providers: ['radar'] });
    const cart = await readyCart();
    expect(await evaluate(cart)).toMatchObject({ outcome: 'allow' }); // no outcome on the charge
    fake.setRadarOutcome(cart.intentId, { risk_level: 'normal', type: 'authorized' });
    expect(await evaluate(cart)).toMatchObject({ outcome: 'allow' });
    fake.setRadarOutcome(cart.intentId, { risk_level: 'elevated', type: 'authorized' });
    expect(await evaluate(cart)).toEqual({
      outcome: 'review',
      reasonCode: 'radar_elevated',
      provider: 'radar',
    });
    fake.setRadarOutcome(cart.intentId, { risk_level: 'normal', type: 'manual_review' });
    expect(await evaluate(cart)).toMatchObject({
      reasonCode: 'radar_manual_review',
      outcome: 'review',
    });
    fake.setRadarOutcome(cart.intentId, { risk_level: 'highest', type: 'authorized' });
    expect(await evaluate(cart)).toMatchObject({ outcome: 'block', reasonCode: 'radar_highest' });
    await setFraud(A, { providers: ['radar'], radar_highest: 'review' });
    expect(await evaluate(cart)).toMatchObject({ outcome: 'review', reasonCode: 'radar_highest' });
    // The request asked for the charge only; a manual payment never reaches Stripe.
    expect(fake.callsOf('retrievePaymentIntent').at(-1)!.expand).toEqual(['latest_charge']);
    const before = fake.callsOf('retrievePaymentIntent').length;
    expect(
      await evaluate(cart, { paymentProvider: 'manual', providerSessionId: 'man_1' }),
    ).toMatchObject({ outcome: 'allow' });
    expect(fake.callsOf('retrievePaymentIntent')).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------------------------- the check

describe('createFraudCheck', () => {
  it('runs the providers in order, the worst outcome wins, and counts what it decided', async () => {
    const cart = await readyCart();
    fake.setRadarOutcome(cart.intentId, { risk_level: 'highest', type: 'authorized' });
    const decision = await evaluate(cart, { billingCountry: 'DE' }); // rules: review · radar: block
    expect(decision).toEqual({ outcome: 'block', reasonCode: 'radar_highest', provider: 'radar' });
    fake.setRadarOutcome(cart.intentId, { risk_level: 'normal', type: 'authorized' });
    expect(await evaluate(cart, { billingCountry: 'DE' })).toMatchObject({
      outcome: 'review',
      reasonCode: 'country_mismatch',
    });
    expect(await evaluate(cart)).toMatchObject({ outcome: 'allow' });
    expect(fraudMetrics.snapshot()).toMatchObject({
      evaluations: { allow: 1, review: 1, block: 1 },
      reasons: { radar_highest: 1, country_mismatch: 1 },
      outages: {},
    });
  });

  it('a provider outage is REVIEW — never block, never a silent pass — with one log line and a metric', async () => {
    const cart = await readyCart();
    fake.outageNextRetrieve = true;
    const decision = await evaluate(cart);
    expect(decision).toEqual({
      outcome: 'review',
      reasonCode: 'provider_unavailable',
      provider: 'radar',
    });
    expect(fraudMetrics.snapshot().outages).toEqual({ radar: 1 });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('provider radar unavailable');
    expect(logged[0]).toContain(A);
    expect(logged[0]).not.toContain(cart.email);
    // A store whose stripe key vanished is a provider problem too: review, not a crash and not a pass.
    const noKey = check({ env: {} as NodeJS.ProcessEnv });
    expect(await evaluate(cart, {}, noKey)).toMatchObject({
      outcome: 'review',
      reasonCode: 'provider_unavailable',
    });
    // An outage in one provider does not hide another provider's review reason that came first.
    fake.outageNextRetrieve = true;
    expect(await evaluate(cart, { billingCountry: 'DE' })).toMatchObject({
      outcome: 'review',
      reasonCode: 'country_mismatch',
    });
  });

  it('block through completeCart: a plain decline to the customer; the real reason is recorded only AFTER the rollback', async () => {
    const c = check();
    setFraudCheck(c);
    const cart = await readyCart();
    fake.setRadarOutcome(cart.intentId, { risk_level: 'highest', type: 'authorized' });
    let thrown: unknown;
    try {
      await completeCart(a, {
        cartId: cart.cartId,
        idempotencyKey: `blocked-${randomUUID()}`,
        actor: customer,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).status).toBe(402);
    const body = (thrown as AppError).toBody();
    expect(body).toEqual({
      code: 'payment_failed',
      message: 'payment not authorized',
      details: { provider: 'stripe' },
    });
    expect(JSON.stringify(body)).not.toMatch(/fraud|radar|risk|block|review/i); // no oracle
    // Nothing was authorized or placed, and NOTHING was written by the check itself.
    expect(fake.callsOf('confirmPaymentIntent')).toHaveLength(0);
    expect(
      (await owner.query(`SELECT 1 FROM "order" WHERE cart_id = $1`, [cart.cartId])).rows,
    ).toHaveLength(0);
    const auditOf = () =>
      owner.query<{ action: string; entity_type: string; after: Record<string, unknown> }>(
        `SELECT action, entity_type, after FROM audit_log WHERE entity_id = $1`,
        [cart.cartId],
      );
    expect((await auditOf()).rows).toHaveLength(0);
    expect(c.pendingBlockRecords()).toBe(1);
    // The placement transaction is gone: now the record is written, in its own transaction.
    await c.flushBlockRecords();
    expect(c.pendingBlockRecords()).toBe(0);
    const audit = await auditOf();
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'fraud.block',
      entity_type: 'cart',
      after: {
        outcome: 'block',
        reason_code: 'radar_highest',
        provider: 'radar',
        amount_minor: cart.amount,
        currency: 'EUR',
        payment_provider: 'stripe',
      },
    });
    expect(JSON.stringify(audit.rows[0]!.after)).not.toContain('@');
  });

  it('evaluate() writes NOTHING while the placement transaction is open — no second connection is taken inside it', async () => {
    const c = check();
    const cart = await readyCart();
    fake.setRadarOutcome(cart.intentId, { risk_level: 'highest', type: 'authorized' });
    const count = async () =>
      (await owner.query(`SELECT 1 FROM audit_log WHERE entity_id = $1`, [cart.cartId])).rows
        .length;
    await expect(
      a.transaction(async (tx) => {
        const decision = await c.evaluate(contextFor(tx, cart));
        expect(decision.outcome).toBe('block');
        expect(await count()).toBe(0); // still inside the placement transaction: no record yet
        expect(c.pendingBlockRecords()).toBe(1);
        throw new Error('placement rolls back');
      }),
    ).rejects.toThrow('placement rolls back');
    expect(await count()).toBe(0);
    await c.recordBlocked({
      organizationId: ORG,
      storeId: A,
      cartId: cart.cartId,
      amountMinor: cart.amount,
      currency: 'EUR',
      paymentProvider: 'stripe',
      actor: customer,
      decision: { outcome: 'block', reasonCode: 'radar_highest', provider: 'radar' },
    });
    expect(await count()).toBe(1); // what the checkout's post-rollback hook will call
    // A record that cannot be written never changes the decision: it is logged (ids and codes only).
    const broken = check({
      recordClient: () => {
        throw new Error('pool exhausted');
      },
    });
    await a.transaction((tx) => broken.evaluate(contextFor(tx, cart)));
    await broken.flushBlockRecords();
    expect(logged.at(-1)).toContain('could not record block');
    expect(logged.at(-1)).not.toContain(cart.email);
  });
});

// ---------------------------------------------------------------------------------------------- review holds the order

describe('a review outcome holds the order (through the real checkout)', () => {
  it('pending + payment flag + order mirror + ONE order.updated with the reason code and no PII; capture refused until cleared; a resolved review is never re-flagged', async () => {
    setFraudCheck(check());
    const cart = await readyCart({ billingCountry: 'DE' }); // rules: country_mismatch → review
    const { orderId, paymentId } = await place(cart.cartId);

    const order = await owner.query<{
      status: string;
      metadata: { fraud?: Record<string, unknown> };
    }>(`SELECT status, metadata FROM "order" WHERE id = $1`, [orderId]);
    expect(order.rows[0]!.status).toBe('pending');
    // Source of truth = the payment row; the order carries the mirror (written by the orders module).
    const flagged = await owner.query<{ metadata: { fraud: Record<string, unknown> } }>(
      `SELECT metadata FROM payment WHERE id = $1`,
      [paymentId],
    );
    expect(flagged.rows[0]!.metadata.fraud).toMatchObject({
      status: 'review',
      reason_code: 'country_mismatch',
      provider: 'rules',
    });
    expect(order.rows[0]!.metadata.fraud).toMatchObject({
      status: 'review',
      reason_code: 'country_mismatch',
      provider: 'rules',
    });
    const updates = async () =>
      (
        await owner.query<{ payload: { changed_fields: string[] } & Record<string, unknown> }>(
          `SELECT payload FROM outbox WHERE topic = 'order.updated' AND aggregate_id = $1 ORDER BY occurred_at, seq`,
          [orderId],
        )
      ).rows;
    const first = await updates();
    expect(first).toHaveLength(1);
    expect(first[0]!.payload.changed_fields).toEqual([
      'fraud',
      'fraud.reason_code=country_mismatch',
      'fraud.status=review',
    ]);
    expect(first[0]!.payload.status).toBe('pending');
    expect(JSON.stringify(first[0]!.payload)).not.toContain(cart.email);

    // Flagging again is a no-op (no second event) …
    await a.transaction((tx) =>
      flagOrderForReview(tx, orderId, {
        reasonCode: 'velocity_email',
        provider: 'rules',
        actor: staff,
      }),
    );
    expect(await updates()).toHaveLength(1);
    // … and the hold is real: the capture is refused with the reason code.
    await expect(
      capturePayment(a, paymentId, { actor: staff, apiFactory: () => fake, env }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: {
        field: 'payment.metadata.fraud.status',
        from: 'review',
        reason_code: 'country_mismatch',
      },
    });
    expect(fake.callsOf('capturePaymentIntent')).toHaveLength(0);

    // A human clears it → payment row AND order mirror, one more order.updated, and the capture goes through.
    await a.transaction((tx) =>
      resolveOrderReview(tx, orderId, { status: 'cleared', resolution: 'manual', actor: staff }),
    );
    expect(await a.transaction((tx) => readOrderFraud(tx, orderId))).toMatchObject({
      status: 'cleared',
      resolution: 'manual',
    });
    const mirror = await owner.query<{ fraud: Record<string, unknown> }>(
      `SELECT metadata->'fraud' AS fraud FROM "order" WHERE id = $1`,
      [orderId],
    );
    expect(mirror.rows[0]!.fraud).toMatchObject({ status: 'cleared', resolution: 'manual' });
    const second = await updates();
    expect(second).toHaveLength(2);
    expect(second[1]!.payload.changed_fields).toContain('fraud.status=cleared');

    // A RESOLVED review is never re-opened by a later flag: nothing written, no event, still capturable.
    const reflag = await a.transaction((tx) =>
      flagOrderForReview(tx, orderId, {
        reasonCode: 'radar_review_opened',
        provider: 'radar',
        actor: staff,
      }),
    );
    expect(reflag).toMatchObject({ status: 'cleared', reason_code: 'country_mismatch' });
    expect(await updates()).toHaveLength(2);
    const captured = await capturePayment(a, paymentId, {
      actor: staff,
      apiFactory: () => fake,
      env,
    });
    expect(captured.payment.status).toBe('captured');

    // An allowed placement carries no flag anywhere.
    const clean = await readyCart();
    const placed = await place(clean.cartId);
    expect(await a.transaction((tx) => readOrderFraud(tx, placed.orderId))).toBeNull();
  });

  it("the registration is the checkout's: registerFraudCheck() lands in the seam completeCart reads, so the wiring bridge is redundant", async () => {
    const registered = registerFraudCheck({
      apiFactory: () => fake,
      env,
      log: () => {},
      recordClient: () => a,
    });
    expect(currentCheckoutFraudCheck()).toBe(registered);
    expect(currentFraudCheck()).toBe(registered); // the module's name for the same function
  });
});

// ---------------------------------------------------------------------------------------------- radar webhooks

describe('Radar review webhooks through the payments receiver', () => {
  function reviewEvent(type: string, intentId: string, fields: Record<string, unknown>) {
    const id = `evt_${randomUUID().replace(/-/g, '')}`;
    const body = {
      id,
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type,
      data: {
        object: {
          id: `prv_${randomUUID().slice(0, 12)}`,
          object: 'review',
          payment_intent: intentId,
          billing_zip: '1015 CJ',
          ip_address: '203.0.113.7',
          ...fields,
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

  const mirrorOf = async (orderId: string) =>
    (
      await owner.query<{ fraud: Record<string, unknown> | null }>(
        `SELECT metadata->'fraud' AS fraud FROM "order" WHERE id = $1`,
        [orderId],
      )
    ).rows[0]!.fraud;

  it('review.opened flags the order, review.closed approved clears it; late and duplicate events change nothing', async () => {
    registerFraudCheck({ apiFactory: () => fake, env, log: () => {}, recordClient: () => a });
    const cart = await readyCart();
    const { orderId, paymentId } = await place(cart.cartId);

    const opened = reviewEvent('review.opened', cart.intentId, { open: true, reason: 'rule' });
    expect(await deliver(opened.raw)).toMatchObject({ kind: 'processed' });
    expect(await a.transaction((tx) => readOrderFraud(tx, orderId))).toMatchObject({
      status: 'review',
      reason_code: 'radar_review_opened',
      provider: 'radar',
    });
    // A review opened AFTER placement gets its ORDER MIRROR too (the gap found in #236), with its one event.
    expect(await mirrorOf(orderId)).toMatchObject({
      status: 'review',
      reason_code: 'radar_review_opened',
      provider: 'radar',
    });
    const events = await owner.query<{ payload: { changed_fields: string[] } }>(
      `SELECT payload FROM outbox WHERE topic = 'order.updated' AND aggregate_id = $1`,
      [orderId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload.changed_fields).toContain(
      'fraud.reason_code=radar_review_opened',
    );
    const stored = (await getWebhookEvent(a, opened.id))!;
    expect(stored).toMatchObject({
      status: 'processed',
      aggregate_type: 'payment',
      aggregate_id: paymentId,
    });
    expect(JSON.stringify(stored.payload)).not.toMatch(/203\.0\.113\.7|1015 CJ/); // redacted extract
    expect(await deliver(opened.raw)).toMatchObject({ kind: 'duplicate' });
    await expect(
      capturePayment(a, paymentId, { actor: staff, apiFactory: () => fake, env }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const closed = reviewEvent('review.closed', cart.intentId, {
      open: false,
      reason: 'approved',
      closed_reason: 'approved',
    });
    expect(await deliver(closed.raw)).toMatchObject({ kind: 'processed' });
    expect(await a.transaction((tx) => readOrderFraud(tx, orderId))).toMatchObject({
      status: 'cleared',
      resolution: 'approved',
    });
    expect(await mirrorOf(orderId)).toMatchObject({ status: 'cleared', resolution: 'approved' });
    // A late `opened` after the review was closed never re-opens it.
    const late = reviewEvent('review.opened', cart.intentId, { open: true, reason: 'rule' });
    expect(await deliver(late.raw)).toMatchObject({ kind: 'skipped' });
    expect(await a.transaction((tx) => readOrderFraud(tx, orderId))).toMatchObject({
      status: 'cleared',
    });
    const captured = await capturePayment(a, paymentId, {
      actor: staff,
      apiFactory: () => fake,
      env,
    });
    expect(captured.payment.status).toBe('captured');
  });

  it('closed before opened (out of order) and closed as fraud → confirmed_fraud; unknown intents are skipped', async () => {
    registerFraudCheck({ apiFactory: () => fake, env, log: () => {}, recordClient: () => a });
    const cart = await readyCart();
    const { orderId, paymentId } = await place(cart.cartId);
    const closed = reviewEvent('review.closed', cart.intentId, {
      open: false,
      closed_reason: 'refunded_as_fraud',
    });
    expect(await deliver(closed.raw)).toMatchObject({ kind: 'processed' });
    expect(await a.transaction((tx) => readOrderFraud(tx, orderId))).toMatchObject({
      status: 'confirmed_fraud',
      resolution: 'refunded_as_fraud',
    });
    // Out of order (closed before opened): the mirror is flagged, then resolved — consistent with the payment row.
    expect(await mirrorOf(orderId)).toMatchObject({
      status: 'confirmed_fraud',
      reason_code: 'radar_review_opened',
      resolution: 'refunded_as_fraud',
    });
    // Confirmed fraud is never captured (a human cancels the order, which voids the hold) …
    await expect(
      capturePayment(a, paymentId, { actor: staff, apiFactory: () => fake, env }),
    ).rejects.toMatchObject({ code: 'conflict', details: { from: 'confirmed_fraud' } });
    // … and a late `opened` never flags it back to review.
    const late = reviewEvent('review.opened', cart.intentId, { open: true, reason: 'rule' });
    expect(await deliver(late.raw)).toMatchObject({ kind: 'skipped' });
    expect(await a.transaction((tx) => readOrderFraud(tx, orderId))).toMatchObject({
      status: 'confirmed_fraud',
    });
    expect(
      await deliver(
        reviewEvent('review.opened', 'pi_not_ours', { open: true, reason: 'rule' }).raw,
      ),
    ).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('no payment row') });
  });

  it('without the fraud module registered the receiver stores review events as unhandled (replayable)', async () => {
    const cart = await readyCart();
    await place(cart.cartId);
    expect(
      await deliver(
        reviewEvent('review.opened', cart.intentId, { open: true, reason: 'rule' }).raw,
      ),
    ).toMatchObject({ kind: 'skipped', reason: 'unhandled_type' });
  });
});
