// Stripe webhook receiver (issue #125) on FakeStripe + a seeded throwaway database with #187's proposed
// `webhook_event` DDL applied by THIS suite only (until migration 0140 lands): signature verification on the raw
// body, redaction + seal, exactly-once per event id, in-flight duplicates (409 / takeover), out-of-order
// convergence through payment-row state guards, order transitions through the orders module, the replay path
// (idempotent; refuses a tampered extract), the Express router, and a PII scan over rows and logs.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import { completeCart, createPaymentSession, setPaymentProvider } from '../checkout';
import { coreErrorHandler } from '../../http/errors';
import { closePool, initDb } from '../../lib/db';
import {
  canonicalJson,
  createStripePaymentProvider,
  FakeStripe,
  getWebhookEvent,
  handleStripeWebhook,
  parseStripeSignature,
  paymentsWebhookRouter,
  redactStripeEvent,
  replayWebhookEvent,
  sealExtract,
  sha256Hex,
  signStripePayload,
  verifySeal,
  verifyStripeSignature,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: null, type: 'customer' as const, requestId: 'req-webhooks' };
const SECRET_A = 'whsec_test_brand_a_secret';
const SECRET_GLOBAL = 'whsec_test_global_secret';
const env = {
  STRIPE_SECRET_KEY: 'sk_test_fake_global',
  STRIPE_WEBHOOK_SECRET: SECRET_GLOBAL,
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
/** PII Stripe puts in real event bodies; must never reach a row or a log line. */
const PII = {
  email: 'jane.doe.webhook@example.com',
  name: 'Jane Doe',
  line1: 'Keizersgracht 1',
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
let logLines: string[];

beforeAll(async () => {
  db = await createTestDatabase('core_webhooks');
  await seed(db.owner, { log: () => {} });
  // #187's DDL, exactly as filed; the real migration 0140 replaces this once it lands.
  await db.owner.query(readFileSync(join(__dirname, 'proposed', '0140_webhook_event.sql'), 'utf8'));
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
  await initDb({ connectionString: db.app.options.connectionString! });
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

beforeEach(() => {
  fake = new FakeStripe();
  logLines = [];
  setPaymentProvider(createStripePaymentProvider({ apiFactory: () => fake, env }));
});

let counter = 0;
async function placedOrder(): Promise<{
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
    actor,
  });
  const p = await owner.query<{ id: string; provider_payment_id: string; amount_minor: string }>(
    `SELECT id, provider_payment_id, amount_minor::text FROM payment WHERE order_id = $1`,
    [order.id],
  );
  return {
    orderId: order.id,
    paymentId: p.rows[0]!.id,
    intentId: p.rows[0]!.provider_payment_id,
    amount: Number(p.rows[0]!.amount_minor),
  };
}

/** A realistic Stripe event body — WITH the PII a real one carries — as raw bytes. */
function stripeEvent(
  type: string,
  intent: { id: string; amount: number; status: string; extra?: Record<string, unknown> },
  id = `evt_${randomUUID().replace(/-/g, '')}`,
): { id: string; raw: Buffer } {
  const body = {
    id,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    request: { id: `req_${randomUUID().slice(0, 8)}`, idempotency_key: null },
    data: {
      object: {
        id: intent.id,
        object: 'payment_intent',
        amount: intent.amount,
        amount_received: intent.status === 'succeeded' ? intent.amount : 0,
        amount_capturable: intent.status === 'requires_capture' ? intent.amount : 0,
        currency: 'eur',
        status: intent.status,
        capture_method: 'manual',
        latest_charge: `ch_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        receipt_email: PII.email,
        description: `Order for ${PII.name}`,
        shipping: { name: PII.name, address: { line1: PII.line1, city: 'Amsterdam' } },
        metadata: { cart_id: randomUUID(), store_id: A, organization_id: ORG, note: 'dropped' },
        ...(intent.extra ?? {}),
      },
    },
  };
  return { id, raw: Buffer.from(JSON.stringify(body), 'utf8') };
}

function deliver(raw: Buffer, opts: { secret?: string; header?: string; client?: typeof a } = {}) {
  const header = opts.header ?? signStripePayload(raw, opts.secret ?? SECRET_A);
  return handleStripeWebhook({
    client: opts.client ?? a,
    storeCode: codeA,
    rawBody: raw,
    signatureHeader: header,
    env,
    log: (line) => logLines.push(line),
  });
}

async function topicsFor(aggregateId: string): Promise<string[]> {
  const r = await owner.query<{ topic: string }>(
    `SELECT topic FROM outbox WHERE aggregate_id = $1 ORDER BY occurred_at, seq`,
    [aggregateId],
  );
  return r.rows.map((x) => x.topic);
}

async function paymentStatus(paymentId: string): Promise<string> {
  const r = await owner.query<{ status: string }>(`SELECT status FROM payment WHERE id = $1`, [
    paymentId,
  ]);
  return r.rows[0]!.status;
}

async function orderPaymentStatus(
  orderId: string,
): Promise<{ status: string; payment_status: string }> {
  const r = await owner.query<{ status: string; payment_status: string }>(
    `SELECT status, payment_status FROM "order" WHERE id = $1`,
    [orderId],
  );
  return r.rows[0]!;
}

function expectNoPii(text: string): void {
  expect(text).not.toContain(PII.email);
  expect(text).not.toContain(PII.name);
  expect(text).not.toContain(PII.line1);
  expect(text).not.toContain('receipt_email');
  expect(text).not.toContain('shipping');
}

// ---------------------------------------------------------------------------------------------- signature

describe('signature', () => {
  const raw = Buffer.from('{"id":"evt_1","object":"event"}');

  it('parses Stripe-Signature and verifies the HMAC over "<t>.<raw body>" for any v1 entry', () => {
    const ts = 1_700_000_000;
    const header = signStripePayload(raw, 'whsec_x', ts);
    expect(parseStripeSignature(header)).toEqual({
      timestamp: ts,
      signatures: [expect.stringMatching(/^[0-9a-f]{64}$/)],
    });
    expect(
      verifyStripeSignature({ rawBody: raw, header, secret: 'whsec_x', nowSeconds: ts + 10 }),
    ).toEqual({ ok: true, timestamp: ts });
    // Secret roll: Stripe sends two v1 entries; the NEW secret verifies through the second one.
    const rolled = `${header},v1=${signStripePayload(raw, 'whsec_new', ts).split('v1=')[1]}`;
    expect(
      verifyStripeSignature({ rawBody: raw, header: rolled, secret: 'whsec_new', nowSeconds: ts }),
    ).toMatchObject({ ok: true });
  });

  it('rejects: missing/malformed header, no v1, wrong secret, tampered body, stale or future timestamp', () => {
    const ts = 1_700_000_000;
    const header = signStripePayload(raw, 'whsec_x', ts);
    const v = (h: string | undefined, secret = 'whsec_x', now = ts, body = raw) =>
      verifyStripeSignature({ rawBody: body, header: h, secret, nowSeconds: now });
    expect(v(undefined)).toEqual({ ok: false, reason: 'missing_header' });
    expect(v('garbage')).toEqual({ ok: false, reason: 'malformed_header' });
    expect(v(`t=${ts}`)).toEqual({ ok: false, reason: 'no_v1_signature' });
    expect(v(header, 'whsec_other')).toEqual({ ok: false, reason: 'no_match' });
    expect(v(header, 'whsec_x', ts, Buffer.from('{"id":"evt_2"}'))).toEqual({
      ok: false,
      reason: 'no_match',
    });
    expect(v(header, 'whsec_x', ts + 301)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    expect(v(header, 'whsec_x', ts - 301)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
    expect(v(header, 'whsec_x', ts + 300)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------- extract + seal

describe('redacted extract and seal', () => {
  it('keeps ids, amounts, statuses and error codes; drops every PII-bearing field and foreign metadata', () => {
    const { raw } = stripeEvent('payment_intent.succeeded', {
      id: 'pi_x',
      amount: 1234,
      status: 'succeeded',
      extra: {
        last_payment_error: {
          code: 'card_declined',
          decline_code: 'fraudulent',
          message: PII.name,
        },
      },
    });
    const extract = redactStripeEvent(JSON.parse(raw.toString('utf8')));
    expect(extract.object).toMatchObject({
      id: 'pi_x',
      object: 'payment_intent',
      status: 'succeeded',
      amount: 1234,
      amount_received: 1234,
      currency: 'eur',
      latest_charge: expect.stringMatching(/^ch_/),
      last_payment_error: { code: 'card_declined', decline_code: 'fraudulent' },
      metadata: { store_id: A, organization_id: ORG },
    });
    expect(extract.object.metadata).not.toHaveProperty('note');
    expectNoPii(JSON.stringify(extract));
    expect(() => redactStripeEvent({ id: 'evt_1', object: 'charge' })).toThrow(/not "event"/);
    expect(() =>
      redactStripeEvent({ id: 'nope', object: 'event', type: 'x', data: { object: {} } }),
    ).toThrow(/missing id/);
  });

  it('seals the extract to the raw-body hash under the webhook secret; editing either side or lacking the secret breaks it', () => {
    const { raw } = stripeEvent('payment_intent.succeeded', {
      id: 'pi_y',
      amount: 10,
      status: 'succeeded',
    });
    const hash = sha256Hex(raw);
    const sealed = sealExtract(redactStripeEvent(JSON.parse(raw.toString('utf8'))), hash, SECRET_A);
    expect(verifySeal(sealed, hash, [SECRET_A])).toBe(true);
    expect(
      verifySeal({ ...sealed, object: { ...sealed.object, amount: 11 } }, hash, [SECRET_A]),
    ).toBe(false);
    expect(verifySeal(sealed, sha256Hex('other body'), [SECRET_A])).toBe(false);
    expect(verifySeal({ ...sealed, seal: undefined }, hash, [SECRET_A])).toBe(false);
    // Keyed: without the store's secret a valid seal can be neither produced nor recognised — an editor who
    // could recompute a plain hash cannot recompute an HMAC.
    expect(verifySeal(sealed, hash, ['whsec_someone_else'])).toBe(false);
    expect(verifySeal(sealed, hash, [])).toBe(false);
    // Secret roll: the previous secret still verifies rows sealed before it; the new one seals new rows.
    expect(verifySeal(sealed, hash, ['whsec_new', SECRET_A])).toBe(true);
    expect(verifySeal(sealed, hash, ['whsec_new'])).toBe(false);
    // The seal survives a JSON round trip through jsonb, which reorders keys.
    const reordered = JSON.parse(canonicalJson(sealed));
    expect(verifySeal(reordered, hash, [SECRET_A])).toBe(true);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

// ---------------------------------------------------------------------------------------------- receiver

describe('handleStripeWebhook — gate', () => {
  it('bad signature → 400 and nothing written; the store-specific secret wins over the global one', async () => {
    const { intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    await expect(deliver(raw, { secret: 'whsec_wrong' })).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: 'no_match' },
    });
    // brand-a has its own secret: the GLOBAL secret does not verify for it.
    await expect(deliver(raw, { secret: SECRET_GLOBAL })).rejects.toMatchObject({
      details: { reason: 'no_match' },
    });
    await expect(deliver(raw, { header: 't=1,v1=00' })).rejects.toMatchObject({
      details: { reason: 'timestamp_out_of_tolerance' },
    });
    expect(await getWebhookEvent(a, id)).toBeNull();
    expect(
      await paymentStatus(
        (
          await owner.query<{ id: string }>(
            `SELECT id FROM payment WHERE provider_payment_id = $1`,
            [intentId],
          )
        ).rows[0]!.id,
      ),
    ).toBe('authorized');
  });

  it('no webhook secret → 400 naming the variables (fail closed); bad JSON / non-event → 400', async () => {
    const { raw } = stripeEvent('payment_intent.succeeded', {
      id: 'pi_z',
      amount: 1,
      status: 'succeeded',
    });
    await expect(
      handleStripeWebhook({
        client: a,
        storeCode: codeA,
        rawBody: raw,
        signatureHeader: signStripePayload(raw, SECRET_A),
        env: { STRIPE_SECRET_KEY: 'sk_test_x' } as NodeJS.ProcessEnv,
        log: () => {},
      }),
    ).rejects.toThrow(/STRIPE_WEBHOOK_SECRET_BRAND_A or STRIPE_WEBHOOK_SECRET/);
    const notJson = Buffer.from('not json');
    await expect(deliver(notJson)).rejects.toMatchObject({ code: 'validation_error' });
    const notEvent = Buffer.from(JSON.stringify({ id: 'evt_1', object: 'charge' }));
    await expect(deliver(notEvent)).rejects.toMatchObject({
      code: 'validation_error',
      details: { reason: expect.stringContaining('not "event"') },
    });
  });

  it('a tenant client of another store cannot deliver for this store (404, nothing written)', async () => {
    const { intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    await expect(deliver(raw, { client: b })).rejects.toMatchObject({ code: 'not_found' });
    expect(await getWebhookEvent(a, id)).toBeNull();
  });
});

describe('handleStripeWebhook — processing', () => {
  it('payment_intent.succeeded: payment captured + payment.captured + order transition; row is redacted and sealed', async () => {
    const { orderId, paymentId, intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    const outcome = await deliver(raw);
    expect(outcome).toMatchObject({
      kind: 'processed',
      eventId: id,
      type: 'payment_intent.succeeded',
    });

    expect(await paymentStatus(paymentId)).toBe('captured');
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
    expect(await orderPaymentStatus(orderId)).toMatchObject({ payment_status: 'captured' });

    const row = (await getWebhookEvent(a, id))!;
    expect(row).toMatchObject({
      provider: 'stripe',
      provider_event_id: id,
      event_type: 'payment_intent.succeeded',
      provider_object_id: intentId,
      aggregate_type: 'payment',
      aggregate_id: paymentId,
      status: 'processed',
      failure_reason: null,
      replay_count: 0,
    });
    expect(row.occurred_at).not.toBeNull();
    expect(row.processed_at).not.toBeNull();
    expect(row.payload_hash).toBe(sha256Hex(raw));
    expect(verifySeal(row.payload, row.payload_hash, [SECRET_A])).toBe(true);
    expect(verifySeal(row.payload, row.payload_hash, [SECRET_GLOBAL])).toBe(false); // sealed with the store's
    expectNoPii(JSON.stringify(row.payload));
    expectNoPii(logLines.join('\n'));
    expect(logLines.join('\n')).toContain(id);
  });

  it('duplicate delivery → duplicate outcome, no second transition, no second event, one row', async () => {
    const { paymentId, intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    await deliver(raw);
    const again = await deliver(raw);
    expect(again).toEqual({
      kind: 'duplicate',
      eventId: id,
      type: 'payment_intent.succeeded',
      status: 'processed',
    });
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
    const rows = await owner.query(`SELECT 1 FROM webhook_event WHERE provider_event_id = $1`, [
      id,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it('a duplicate of an event still in flight gets 409; an abandoned one is taken over', async () => {
    const { paymentId, intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    await deliver(raw);
    // Simulate the first delivery crashing after its commit but before its follow-ups finished.
    await owner.query(
      `UPDATE webhook_event SET status = 'received', processed_at = NULL, received_at = now() WHERE provider_event_id = $1`,
      [id],
    );
    await expect(deliver(raw)).rejects.toMatchObject({
      code: 'conflict',
      details: { provider_event_id: id },
    });
    expect((await getWebhookEvent(a, id))!.status).toBe('received'); // untouched
    // Older than the takeover window: the redelivery finishes it — idempotently (already captured → skipped).
    await owner.query(
      `UPDATE webhook_event SET received_at = now() - interval '2 minutes' WHERE provider_event_id = $1`,
      [id],
    );
    const taken = await deliver(raw);
    expect(taken).toMatchObject({ kind: 'skipped', reason: 'already captured' });
    expect((await getWebhookEvent(a, id))!.status).toBe('skipped');
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
  });

  it('two connections: a duplicate arriving while the first delivery is in flight gets 409, then 200 once it is done', async () => {
    const { paymentId, intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    // Delivery A pauses after its insert transaction committed and before its order follow-ups: the row is
    // `received` and fresh. Delivery B arrives on a second connection meanwhile.
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedPause!: () => void;
    const atPause = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    const first = handleStripeWebhook({
      client: a,
      storeCode: codeA,
      rawBody: raw,
      signatureHeader: signStripePayload(raw, SECRET_A),
      env,
      log: (l) => logLines.push(l),
      hooks: {
        beforeFollowUps: async () => {
          reachedPause();
          await paused;
        },
      },
    });
    await atPause;
    await expect(
      deliver(raw, { client: createTenantClient(db.app, { organizationId: ORG, storeIds: [A] }) }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { provider_event_id: id },
    });
    release();
    expect(await first).toMatchObject({ kind: 'processed' });
    expect(await paymentStatus(paymentId)).toBe('captured');
    // Now the duplicate is a plain 200.
    expect(await deliver(raw)).toMatchObject({ kind: 'duplicate', status: 'processed' });
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
  });

  it('two connections: a duplicate arriving while the insert transaction is still open WAITS at the unique index, then is a duplicate', async () => {
    // An event without order follow-ups (`skipped` is final inside the insert transaction), so that what the
    // waiting connection sees after the commit is deterministic: a finished duplicate, not an in-flight 409.
    const { raw } = stripeEvent('customer.created', { id: 'cus_wait', amount: 0, status: 'x' });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedPause!: () => void;
    const atPause = new Promise<void>((resolve) => {
      reachedPause = resolve;
    });
    const first = handleStripeWebhook({
      client: a,
      storeCode: codeA,
      rawBody: raw,
      signatureHeader: signStripePayload(raw, SECRET_A),
      env,
      log: (l) => logLines.push(l),
      hooks: {
        afterInsert: async () => {
          reachedPause();
          await paused; // the insert transaction stays open: the unique index entry is uncommitted
        },
      },
    });
    await atPause;
    let secondSettled = false;
    const second = deliver(raw, {
      client: createTenantClient(db.app, { organizationId: ORG, storeIds: [A] }),
    }).finally(() => {
      secondSettled = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(secondSettled).toBe(false); // blocked on the unique index, not answered
    release();
    expect(await first).toMatchObject({ kind: 'skipped', reason: 'unhandled_type' });
    expect(await second).toMatchObject({ kind: 'duplicate', status: 'skipped' });
    const rows = await owner.query(
      `SELECT 1 FROM webhook_event WHERE provider_object_id = 'cus_wait'`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('out of order: an authorization event after the capture is skipped; the row never regresses', async () => {
    const { paymentId, intentId, amount } = await placedOrder();
    await deliver(
      stripeEvent('payment_intent.succeeded', { id: intentId, amount, status: 'succeeded' }).raw,
    );
    const late = await deliver(
      stripeEvent('payment_intent.amount_capturable_updated', {
        id: intentId,
        amount,
        status: 'requires_capture',
      }).raw,
    );
    expect(late).toMatchObject({ kind: 'skipped', reason: 'payment row is already captured' });
    expect(await paymentStatus(paymentId)).toBe('captured');
  });

  it('out of order: succeeded after canceled does not resurrect the payment — a state_conflict for a human', async () => {
    const { orderId, paymentId, intentId, amount } = await placedOrder();
    const cancel = await deliver(
      stripeEvent('payment_intent.canceled', {
        id: intentId,
        amount,
        status: 'canceled',
        extra: { cancellation_reason: 'abandoned' },
      }).raw,
    );
    expect(cancel).toMatchObject({ kind: 'processed' });
    // The orders module did the cancel: order cancelled, payment row cancelled, hold released via the provider.
    expect(await orderPaymentStatus(orderId)).toMatchObject({ status: 'cancelled' });
    expect(await paymentStatus(paymentId)).toBe('cancelled');
    expect(fake.callsOf('cancelPaymentIntent').map((c) => c.id)).toContain(intentId);

    const conflict = await deliver(
      stripeEvent('payment_intent.succeeded', { id: intentId, amount, status: 'succeeded' }).raw,
    );
    expect(conflict).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('state_conflict'),
    });
    expect(await paymentStatus(paymentId)).toBe('cancelled');
    expect(await topicsFor(paymentId)).not.toContain('payment.captured');
    // Then the second cancel event is a plain no-op.
    const again = await deliver(
      stripeEvent('payment_intent.canceled', { id: intentId, amount, status: 'canceled' }).raw,
    );
    expect(again).toMatchObject({ kind: 'skipped', reason: 'already cancelled' });
  });

  it('payment_intent.payment_failed on an authorized payment: row failed + payment.failed + order payment_status', async () => {
    const { orderId, paymentId, intentId, amount } = await placedOrder();
    const r = await deliver(
      stripeEvent('payment_intent.payment_failed', {
        id: intentId,
        amount,
        status: 'requires_payment_method',
        extra: {
          last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
        },
      }).raw,
    );
    expect(r).toMatchObject({ kind: 'processed' });
    expect(await paymentStatus(paymentId)).toBe('failed');
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.failed']);
    const ev = await owner.query<{ payload: { failure_reason: string } }>(
      `SELECT payload FROM outbox WHERE topic = 'payment.failed' AND aggregate_id = $1`,
      [paymentId],
    );
    expect(ev.rows[0]!.payload.failure_reason).toBe('insufficient_funds');
    expect(await orderPaymentStatus(orderId)).toMatchObject({ payment_status: 'failed' });
  });

  it('captured amount that differs from ours, and an intent we never placed, are failed rows, not transitions', async () => {
    const { paymentId, intentId, amount } = await placedOrder();
    const wrong = await deliver(
      stripeEvent('payment_intent.succeeded', {
        id: intentId,
        amount: amount + 1,
        status: 'succeeded',
      }).raw,
    );
    expect(wrong).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('amount_conflict'),
    });
    expect(await paymentStatus(paymentId)).toBe('authorized');
    const foreign = await deliver(
      stripeEvent('payment_intent.succeeded', {
        id: 'pi_never_ours',
        amount: 5,
        status: 'succeeded',
      }).raw,
    );
    expect(foreign).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('no payment row'),
    });
    expect((await getWebhookEvent(a, foreign.eventId))!.status).toBe('failed');
  });

  it('unhandled types are stored as skipped (replayable later): refunds wait for 2.3', async () => {
    const r1 = await deliver(
      stripeEvent('charge.refunded', { id: 'pi_r', amount: 5, status: 'succeeded' }).raw,
    );
    expect(r1).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('informational') });
    const r2 = await deliver(
      stripeEvent('customer.created', { id: 'cus_1', amount: 0, status: 'x' }).raw,
    );
    expect(r2).toMatchObject({ kind: 'skipped', reason: 'unhandled_type' });
  });
});

// ---------------------------------------------------------------------------------------------- replay

describe('replayWebhookEvent', () => {
  it('reprocesses idempotently (no second event), counts the replay, and refuses a tampered extract', async () => {
    const { paymentId, intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    await deliver(raw);

    const replay = await replayWebhookEvent(a, id, { log: (l) => logLines.push(l), env });
    expect(replay).toMatchObject({ kind: 'skipped', reason: 'already captured', replayed: true });
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
    expect((await getWebhookEvent(a, id))!.replay_count).toBe(1);
    expectNoPii(logLines.join('\n'));

    // Someone edits the stored extract by hand: the seal no longer matches payload_hash → refused, untouched.
    await owner.query(
      `UPDATE webhook_event SET payload = jsonb_set(payload, '{object,amount}', '1'::jsonb) WHERE provider_event_id = $1`,
      [id],
    );
    await expect(replayWebhookEvent(a, id, { log: () => {}, env })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('does not match payload_hash'),
    });
    expect((await getWebhookEvent(a, id))!.replay_count).toBe(1);
    await expect(
      replayWebhookEvent(a, 'evt_missing', { log: () => {}, env }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('secret roll: deliveries and replays verify under [current, previous]; a replay with only the new secret is refused', async () => {
    const { intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    await deliver(raw); // sealed under SECRET_A (the current secret at delivery time)
    const rolled = {
      ...env,
      STRIPE_WEBHOOK_SECRET_BRAND_A: 'whsec_rolled',
      STRIPE_WEBHOOK_SECRET_BRAND_A_PREVIOUS: SECRET_A,
    } as NodeJS.ProcessEnv;
    // During the roll Stripe still signs with the old secret for a while: accepted through _PREVIOUS.
    const late = stripeEvent('payment_intent.amount_capturable_updated', {
      id: intentId,
      amount,
      status: 'requires_capture',
    });
    const r = await handleStripeWebhook({
      client: a,
      storeCode: codeA,
      rawBody: late.raw,
      signatureHeader: signStripePayload(late.raw, SECRET_A),
      env: rolled,
      log: () => {},
    });
    expect(r).toMatchObject({ kind: 'skipped' });
    // …and the new one seals new rows.
    expect(
      verifySeal((await getWebhookEvent(a, late.id))!.payload, sha256Hex(late.raw), [
        'whsec_rolled',
      ]),
    ).toBe(true);
    // Replaying the pre-roll row works while _PREVIOUS is set, and is refused once it is dropped.
    expect(await replayWebhookEvent(a, id, { log: () => {}, env: rolled })).toMatchObject({
      kind: 'skipped',
    });
    const dropped = { ...env, STRIPE_WEBHOOK_SECRET_BRAND_A: 'whsec_rolled' } as NodeJS.ProcessEnv;
    await expect(replayWebhookEvent(a, id, { log: () => {}, env: dropped })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('webhook secret'),
    });
  });

  it('finishes a failed event after its cause is fixed (the same state guards, the same follow-ups)', async () => {
    const { orderId, paymentId, intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    await deliver(raw);
    // A crash after the payment transaction and before the order transition leaves the order behind…
    await owner.query(`UPDATE "order" SET payment_status = 'authorized' WHERE id = $1`, [orderId]);
    await owner.query(
      `UPDATE webhook_event SET status = 'failed', failure_reason = 'simulated' WHERE provider_event_id = $1`,
      [id],
    );
    // …and the replay converges it without a second payment.captured.
    const r = await replayWebhookEvent(a, id, { log: () => {}, env });
    expect(r).toMatchObject({ kind: 'skipped', reason: 'already captured' });
    expect(await orderPaymentStatus(orderId)).toMatchObject({ payment_status: 'captured' });
    expect(await topicsFor(paymentId)).toEqual(['payment.authorized', 'payment.captured']);
    expect((await getWebhookEvent(a, id))!).toMatchObject({
      status: 'skipped',
      failure_reason: 'already captured',
    });
  });
});

// ---------------------------------------------------------------------------------------------- router

describe('paymentsWebhookRouter', () => {
  function app() {
    const e = express();
    e.use(paymentsWebhookRouter({ env, log: (l) => logLines.push(l) }));
    e.use(coreErrorHandler);
    return e;
  }

  it('POST /webhooks/stripe/:storeCode on the raw body: 200 processed, 200 duplicate, 400, 404', async () => {
    const { paymentId, intentId, amount } = await placedOrder();
    const { id, raw } = stripeEvent('payment_intent.succeeded', {
      id: intentId,
      amount,
      status: 'succeeded',
    });
    const res = await request(app())
      .post(`/webhooks/stripe/${codeA}`)
      .set('Content-Type', 'application/json; charset=utf-8')
      .set('Stripe-Signature', signStripePayload(raw, SECRET_A))
      .send(raw.toString('utf8')); // a string goes on the wire verbatim; superagent would JSON-encode a Buffer
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, event_id: id, outcome: 'processed', reason: null });
    expect(await paymentStatus(paymentId)).toBe('captured');

    const dup = await request(app())
      .post(`/webhooks/stripe/${codeA}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signStripePayload(raw, SECRET_A))
      .send(raw.toString('utf8')); // a string goes on the wire verbatim; superagent would JSON-encode a Buffer
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({
      received: true,
      event_id: id,
      duplicate: true,
      status: 'processed',
    });

    const bad = await request(app())
      .post(`/webhooks/stripe/${codeA}`)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signStripePayload(raw, 'whsec_nope'))
      .send(raw.toString('utf8')); // a string goes on the wire verbatim; superagent would JSON-encode a Buffer
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'validation_error', details: { reason: 'no_match' } });

    const unknown = await request(app())
      .post('/webhooks/stripe/no-such-store')
      .set('Stripe-Signature', signStripePayload(raw, SECRET_A))
      .send(raw.toString('utf8')); // a string goes on the wire verbatim; superagent would JSON-encode a Buffer
    expect(unknown.status).toBe(404);
    const weird = await request(app())
      .post('/webhooks/stripe/Not%20A%20Code')
      .send(raw.toString('utf8')); // a string goes on the wire verbatim; superagent would JSON-encode a Buffer
    expect(weird.status).toBe(404);
    expectNoPii(logLines.join('\n'));
  });
});
