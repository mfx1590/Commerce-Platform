// The CDP consumer on a throwaway database, then a live block against the local Redpanda.
//
// The live block follows the shape #553 ended up with, for the reasons recorded there: each test ensures its
// OWN topics under the run's prefix and stops its consumer in a finally before the next starts, because every
// test joins the real group (`engagement.cdp`) and two live members would share the topic's partitions. And the
// dedupe test pre-marks an event on fresh topics, so it is the MARK that silences it and not an offset that was
// never re-read — a dedupe test that still passes with the processed store removed is not a dedupe test.

import { createHash } from 'node:crypto';
import net from 'node:net';
import {
  createOrganizationClient,
  createTenantClient,
  SEED_IDS,
  seed,
  type ScopedClient,
} from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import {
  brokersFromEnv,
  createKafka,
  createKafkaPublisher,
  createValidator,
  dlqTopicName,
  ensureTopics,
  envelopeToMessage,
  makeEvent,
  planTopics,
  readDeadLetters,
  type EventEnvelopeV1Base,
  type EventTopic,
  type TopicPolicy,
} from '@platform/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROCESSED_TABLE } from '../ops/consumer.js';
import { createStoreCodes } from '../ops/store-codes.js';
import { MemoryCdpAdapter } from './adapter/memory.js';
import { CONSENT_PURPOSE } from '../consent.js';
import { CDP_GROUP_ID, createCdpConsumer, handleCdpEvent, type CdpLogLine } from './consumer.js';
import { CdpError } from './types.js';

const ORG = SEED_IDS.organization;
const STORE_A = SEED_IDS.stores.brandA;
const STORE_B = SEED_IDS.stores.brandB;
// Computed, never a literal: the schema needs a real 64-hex sha256, and a hex literal of that length in a
// committed test is exactly the shape gitleaks flags across every branch (Memory-main). This is also how
// apps/core builds its own email_hash fixtures.
const EMAIL_HASH = createHash('sha256').update('cdp-fixture@example.test').digest('hex');
const IDENTITY_ID = '99999999-9999-4999-8999-999999999999';

const validator = createValidator();

let db: TestDatabase;
let hq: ScopedClient;
let adapter: MemoryCdpAdapter;

function storeClientFor(storeId: string): ScopedClient {
  return createTenantClient(db.app, { organizationId: ORG, storeIds: [storeId] });
}

function deps(over: Partial<Parameters<typeof handleCdpEvent>[2]> = {}) {
  return {
    hq,
    storeClientFor,
    storeCodes: createStoreCodes(hq),
    adapter,
    ...over,
  };
}

/** The per-store resolver the real config hands the consumer, built from a plain map for tests. */
const modes =
  (map: Record<string, 'analytics' | 'strict'>, fallback: 'analytics' | 'strict') =>
  (storeCode: string) =>
    map[storeCode] ?? fallback;

function envelopeFor(
  topic: EventTopic,
  payload: Record<string, unknown>,
  aggregate: { type: EventEnvelopeV1Base['aggregate_type']; id: string },
  storeId: string | null = STORE_A,
  version?: number,
): EventEnvelopeV1Base {
  const base = makeEvent({
    topic,
    organizationId: ORG,
    storeId,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload: payload as never,
  });
  // `makeEvent` always stamps LATEST_VERSION, so an explicit `version` is the only way to build a FROZEN
  // older payload. The validator then checks against `schemas/<topic>/v<version>.json`, which is what makes
  // such a fixture honest rather than a v2 envelope with a field removed.
  const e = (version === undefined ? base : { ...base, version }) as EventEnvelopeV1Base;
  const check = validator.validateEnvelope(e);
  expect(check.ok, `${topic}: ${check.errors?.join('; ')}`).toBe(true);
  return e;
}

const customerCreated = (customerId: string, storeId: string = STORE_A) =>
  envelopeFor(
    'customer.created',
    {
      customer_id: customerId,
      identity_id: IDENTITY_ID,
      email_hash: EMAIL_HASH,
      status: 'registered',
      customer_group_id: null,
      // Deliberately the OPPOSITE of what the projection will say, to prove it is ignored.
      marketing_consent: true,
    },
    { type: 'customer', id: customerId },
    storeId,
  );

const customerErased = (customerId: string, storeId: string = STORE_A) =>
  envelopeFor(
    'customer.erased',
    {
      customer_id: customerId,
      identity_id: IDENTITY_ID,
      // Required since customer.erased v2 (#580).
      email_hash: EMAIL_HASH,
      erased_at: '2026-10-23T12:00:00.000Z',
    },
    { type: 'customer', id: customerId },
    storeId,
  );

/**
 * A GENUINE v1 erasure: version 1 and NO `email_hash` — the field does not exist in that schema (v1 is
 * frozen; #580 added it in v2, and `customerErased` above is the v2 shape since #583). A v1 test must build
 * its own envelope: reusing the shared fixture is exactly how the v1 assertion below started receiving a hash
 * it claims cannot be there, which is the #585 queue failure.
 */
const customerErasedV1 = (customerId: string, storeId: string = STORE_A) =>
  envelopeFor(
    'customer.erased',
    {
      customer_id: customerId,
      identity_id: IDENTITY_ID,
      erased_at: '2026-10-23T12:00:00.000Z',
    },
    { type: 'customer', id: customerId },
    storeId,
    1,
  );

const paymentCaptured = (orderId: string, storeId: string = STORE_A) =>
  envelopeFor(
    'payment.captured',
    {
      payment_id: '22222222-2222-4222-8222-222222222222',
      order_id: orderId,
      legal_entity_id: SEED_IDS.legalEntities.brandA,
      provider: 'stripe',
      provider_payment_id: 'pi-alpha',
      amount_minor: 10494,
      fee_minor: 250,
      currency: 'EUR',
      captured_at: '2026-10-23T10:05:00.000Z',
    },
    { type: 'payment', id: '22222222-2222-4222-8222-222222222222' },
    storeId,
  );

/** `order.placed` is the one mapped commerce topic that carries an `email_hash`, so it is the guest path. */
const orderPlaced = (orderId: string, customerId: string | null, storeId: string = STORE_A) =>
  envelopeFor(
    'order.placed',
    {
      order_id: orderId,
      display_id: 1001,
      legal_entity_id: SEED_IDS.legalEntities.brandA,
      sales_channel_id: '88888888-8888-4888-8888-888888888888',
      customer_id: customerId,
      email_hash: EMAIL_HASH,
      currency: 'EUR',
      locale: 'en-GB',
      totals: {
        subtotal_minor: 9000,
        discount_minor: 0,
        shipping_minor: 499,
        tax_minor: 1495,
        total_minor: 10994,
      },
      line_items: [
        {
          order_line_item_id: '66666666-6666-4666-8666-666666666666',
          variant_id: '88888888-8888-4888-8888-888888888888',
          sku: 'SKU-ALPHA',
          title: 'Alpha chair',
          quantity: 1,
          unit_price_minor: 9000,
          discount_minor: 0,
          tax_rate_bp: 1900,
          tax_minor: 1495,
          total_minor: 10994,
        },
      ],
      shipping: { code: 'standard', name: 'Standard', carrier: 'dhl', price_minor: 499 },
      shipping_country: 'DE',
      billing_country: 'DE',
      promotion_codes: [],
      placed_at: '2026-10-24T10:00:00.000Z',
    },
    { type: 'order', id: orderId },
    storeId,
  );

// ---- fixtures in the database -------------------------------------------------------------------------------

async function makeCustomer(storeId: string, consent: boolean | null): Promise<string> {
  const r = await db.owner.query(
    `INSERT INTO customer (organization_id, store_id, email, status, consent)
     VALUES ($1, $2, $3, 'registered', '{}'::jsonb) RETURNING id`,
    [ORG, storeId, `cdp-${Math.random().toString(36).slice(2, 10)}@example.test`],
  );
  const id = (r.rows[0] as { id: string }).id;
  if (consent !== null) {
    await db.owner.query(
      `UPDATE customer SET consent = jsonb_set(coalesce(consent, '{}'::jsonb), $2::text[], $3::jsonb)
        WHERE id = $1`,
      [
        id,
        [CONSENT_PURPOSE],
        JSON.stringify({ granted: consent, at: '2026-10-20T10:00:00.000Z', source: 'storefront' }),
      ],
    );
  }
  return id;
}

async function makeOrder(storeId: string, customerId: string | null): Promise<string> {
  const channel = await db.owner.query(`SELECT id FROM sales_channel WHERE store_id = $1 LIMIT 1`, [
    storeId,
  ]);
  const r = await db.owner.query(
    `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, customer_id, email,
                          currency, locale, shipping_address, billing_address,
                          subtotal_minor, shipping_minor, tax_minor, total_minor)
     VALUES ($1, $2, $3, $4, $5, 'cdp-order@example.test', 'EUR', 'en-GB', '{}'::jsonb, '{}'::jsonb,
             9000, 499, 1495, 10994)
     RETURNING id`,
    [
      ORG,
      storeId,
      Math.floor(Math.random() * 1_000_000) + 1000,
      (channel.rows[0] as { id: string }).id,
      customerId,
    ],
  );
  return (r.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  db = await createTestDatabase('platform_cdp_consumer');
  await seed(db.owner);
  hq = createOrganizationClient(db.app, { organizationId: ORG });
}, 120_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  adapter = new MemoryCdpAdapter();
  await db.owner.query(`DELETE FROM ${PROCESSED_TABLE}`);
  await db.owner.query(`DELETE FROM "order" WHERE store_id = ANY($1::uuid[])`, [
    [STORE_A, STORE_B],
  ]);
  await db.owner.query(`DELETE FROM customer WHERE store_id = ANY($1::uuid[])`, [
    [STORE_A, STORE_B],
  ]);
});

describe('handleCdpEvent — the decision path', () => {
  it('identifies a consenting customer, with the resolved store code', async () => {
    const id = await makeCustomer(STORE_A, true);
    const r = await handleCdpEvent(customerCreated(id), 'out-1', deps());

    expect(r.sent?.kind).toBe('identify');
    expect(adapter.identifies).toHaveLength(1);
    expect(adapter.identifies[0]!.traits).toMatchObject({
      customer_id: id,
      store_code: 'brand-a',
      email_hash: EMAIL_HASH,
    });
    expect(adapter.identifies[0]!.identity).toEqual({ userId: id, anonymousId: EMAIL_HASH });
  });

  it('IGNORES the payload s marketing_consent: the projection decides', async () => {
    // The event says marketing_consent: true; the projection says revoked. Nothing is sent.
    const id = await makeCustomer(STORE_A, false);
    const r = await handleCdpEvent(customerCreated(id), 'out-2', deps());
    expect(r.sent).toBeNull();
    expect(r.reason).toBe('consent_revoked');
    expect(adapter.count).toBe(0);
  });

  it('drops a customer who never answered', async () => {
    const id = await makeCustomer(STORE_A, null);
    const r = await handleCdpEvent(customerCreated(id), 'out-3', deps());
    expect(r.reason).toBe('consent_absent');
    expect(adapter.count).toBe(0);
  });

  it('tracks an order-scoped event by resolving the customer from the order row', async () => {
    const customerId = await makeCustomer(STORE_A, true);
    const orderId = await makeOrder(STORE_A, customerId);
    const r = await handleCdpEvent(paymentCaptured(orderId), 'out-4', deps());

    expect(r.sent?.kind).toBe('track');
    expect(adapter.tracks).toHaveLength(1);
    expect(adapter.tracks[0]!.event).toBe('Payment Captured');
    expect(adapter.tracks[0]!.identity.userId).toBe(customerId);
    expect(adapter.tracks[0]!.properties).toMatchObject({
      order_id: orderId,
      amount_minor: 10494,
      currency: 'EUR',
      store_code: 'brand-a',
    });
  });

  it('drops an order-scoped event whose customer has revoked', async () => {
    const customerId = await makeCustomer(STORE_A, false);
    const orderId = await makeOrder(STORE_A, customerId);
    const r = await handleCdpEvent(paymentCaptured(orderId), 'out-5', deps());
    expect(r.reason).toBe('consent_revoked');
    expect(adapter.count).toBe(0);
  });

  it('DROPS a guest order rather than tracking it pseudonymously', async () => {
    const orderId = await makeOrder(STORE_A, null);
    const r = await handleCdpEvent(paymentCaptured(orderId), 'out-6', deps());
    expect(r.reason).toBe('no_identity');
    expect(adapter.count).toBe(0);
  });

  it('drops an event whose order is gone', async () => {
    const r = await handleCdpEvent(
      paymentCaptured('99999999-9999-4999-8999-999999999999'),
      'out-7',
      deps(),
    );
    expect(r.reason).toBe('order_not_found');
  });

  it('SUPPRESSES on customer.erased even though the row and the consent are gone', async () => {
    const id = await makeCustomer(STORE_A, false);
    await db.owner.query(`DELETE FROM customer WHERE id = $1`, [id]);

    const r = await handleCdpEvent(customerErased(id), 'out-8', deps());
    expect(r.sent?.kind).toBe('suppress');
    expect(adapter.suppressions).toHaveLength(1);
    expect(adapter.isSuppressed(id)).toBe(true);
  });

  it('suppresses an erased customer whose row still exists and says revoked', async () => {
    const id = await makeCustomer(STORE_A, false);
    const r = await handleCdpEvent(customerErased(id), 'out-9', deps());
    expect(r.sent?.kind).toBe('suppress');
    expect(adapter.isSuppressed(id)).toBe(true);
  });

  it('reads consent in the EVENT S OWN store: another store s consent cannot grant it', async () => {
    // Same customer id, but the customer (and the consent) belong to brand-a; the event claims brand-b.
    const id = await makeCustomer(STORE_A, true);
    const r = await handleCdpEvent(customerCreated(id, STORE_B), 'out-10', deps());
    expect(r.sent).toBeNull();
    expect(adapter.count).toBe(0);
  });

  it('skips an unmapped topic without touching the adapter', async () => {
    const e = envelopeFor(
      'order.confirmed',
      {
        order_id: '11111111-1111-4111-8111-111111111111',
        display_id: 1001,
        confirmed_at: '2026-10-23T10:00:00.000Z',
      },
      { type: 'order', id: '11111111-1111-4111-8111-111111111111' },
    );
    const r = await handleCdpEvent(e, 'out-11', deps());
    expect(r.sent).toBeNull();
    expect(r.reason).toBeUndefined();
    expect(adapter.count).toBe(0);
  });

  it('logs every drop with a reason, and never any customer data', async () => {
    const lines: unknown[] = [];
    const revoked = await makeCustomer(STORE_A, false);
    const consenting = await makeCustomer(STORE_A, true);
    const d = deps({ log: (l) => lines.push(l) });

    await handleCdpEvent(customerCreated(revoked), 'out-12', d);
    await handleCdpEvent(customerCreated(consenting), 'out-13', d);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      service: 'engagement',
      module: 'cdp',
      event: 'dropped',
      reason: 'consent_revoked',
      call: 'identify',
      store_code: 'brand-a',
    });
    expect(lines[1]).toMatchObject({ event: 'sent', call: 'identify', adapter: 'memory' });
    // A log line carries reason codes and ids, never traits or an e-mail.
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(text).not.toContain(EMAIL_HASH);
  });

  it('an adapter refusal propagates, so the SDK retries and finally dead-letters', async () => {
    const id = await makeCustomer(STORE_A, true);
    adapter.failWith = new CdpError('rudderstack /v1/identify: HTTP 500');
    await expect(handleCdpEvent(customerCreated(id), 'out-14', deps())).rejects.toThrow('HTTP 500');
  });
});

describe('handleCdpEvent — the consent mode (#576)', () => {
  it('ANALYTICS: sends a customer who revoked marketing consent', async () => {
    const id = await makeCustomer(STORE_A, false);
    const r = await handleCdpEvent(
      customerCreated(id),
      'out-m1',
      deps({ consentModeFor: modes({}, 'analytics') }),
    );
    expect(r.sent?.kind).toBe('identify');
    expect(adapter.identifies).toHaveLength(1);
  });

  it('ANALYTICS: sends a customer who never answered', async () => {
    const id = await makeCustomer(STORE_A, null);
    const r = await handleCdpEvent(
      customerCreated(id),
      'out-m2',
      deps({ consentModeFor: modes({}, 'analytics') }),
    );
    expect(r.sent?.kind).toBe('identify');
  });

  it('ANALYTICS: TRACKS A GUEST under the email_hash when the event carries one', async () => {
    // `order.placed` carries `email_hash`, so a guest's purchase reaches the CDP pseudonymously — which is
    // what #576 asks for.
    const orderId = await makeOrder(STORE_A, null);
    const r = await handleCdpEvent(
      orderPlaced(orderId, null),
      'out-m3',
      deps({ consentModeFor: modes({}, 'analytics') }),
    );
    expect(r.sent?.kind).toBe('track');
    expect(adapter.tracks[0]!.event).toBe('Order Completed');
    expect(adapter.tracks[0]!.identity).toEqual({ userId: null, anonymousId: EMAIL_HASH });
  });

  it('ANALYTICS: a guest event with NO hash in the payload is still dropped — the known asymmetry', async () => {
    // Of the six mapped commerce topics only `order.placed` carries an `email_hash`; `order.cancelled`,
    // `payment.captured`, `refund.issued`, `shipment.shipped` and `return.requested` carry neither it nor a
    // `customer_id`, so for a GUEST there is no identity to send and nothing to invent. The consequence is
    // visible and deliberate: a guest's "Order Completed" reaches the CDP while their later "Order Shipped"
    // does not. Closing it would mean hashing the order row's raw e-mail inside the CDP path, which widens
    // what this service reads — flagged to the manager rather than slipped in. README records it.
    const orderId = await makeOrder(STORE_A, null);
    const r = await handleCdpEvent(
      paymentCaptured(orderId),
      'out-m3b',
      deps({ consentModeFor: modes({}, 'analytics') }),
    );
    expect(r).toMatchObject({ sent: null, reason: 'no_identity' });
    expect(adapter.count).toBe(0);
  });

  it('ANALYTICS: an order-scoped event for a KNOWN customer is tracked whatever their consent', async () => {
    // The asymmetry above is about guests only: with a customer on the order there is an identity, so the
    // whole order lifecycle reaches the CDP in analytics mode.
    const customerId = await makeCustomer(STORE_A, false);
    const orderId = await makeOrder(STORE_A, customerId);
    const r = await handleCdpEvent(
      paymentCaptured(orderId),
      'out-m3c',
      deps({ consentModeFor: modes({}, 'analytics') }),
    );
    expect(r.sent?.kind).toBe('track');
    expect(adapter.tracks[0]!.identity.userId).toBe(customerId);
  });

  it('ANALYTICS: still refuses an ERASED customer', async () => {
    const id = await makeCustomer(STORE_A, true);
    await db.owner.query(`UPDATE customer SET status = 'erased' WHERE id = $1`, [id]);
    const r = await handleCdpEvent(
      customerCreated(id),
      'out-m4',
      deps({ consentModeFor: modes({}, 'analytics') }),
    );
    expect(r).toMatchObject({ sent: null, reason: 'customer_erased' });
    expect(adapter.count).toBe(0);
  });

  it('STRICT: the same revoked customer is dropped', async () => {
    const id = await makeCustomer(STORE_A, false);
    const r = await handleCdpEvent(
      customerCreated(id),
      'out-m5',
      deps({ consentModeFor: modes({}, 'strict') }),
    );
    expect(r).toMatchObject({ sent: null, reason: 'consent_revoked' });
    expect(adapter.count).toBe(0);
  });

  it('STRICT: the same guest order is dropped', async () => {
    const orderId = await makeOrder(STORE_A, null);
    const r = await handleCdpEvent(
      paymentCaptured(orderId),
      'out-m6',
      deps({ consentModeFor: modes({}, 'strict') }),
    );
    expect(r).toMatchObject({ sent: null, reason: 'no_identity' });
  });

  it('A PER-STORE OVERRIDE DECIDES: brand-a strict, brand-b analytics, same revoked consent', async () => {
    // One revoked customer in each store, one resolver, two different outcomes — which is the whole point of
    // a per-store mode (#576): each brand is one market.
    const inA = await makeCustomer(STORE_A, false);
    const inB = await makeCustomer(STORE_B, false);
    const resolver = modes({ 'brand-a': 'strict', 'brand-b': 'analytics' }, 'analytics');

    const a = await handleCdpEvent(
      customerCreated(inA, STORE_A),
      'out-m7',
      deps({ consentModeFor: resolver }),
    );
    const b = await handleCdpEvent(
      customerCreated(inB, STORE_B),
      'out-m8',
      deps({ consentModeFor: resolver }),
    );

    expect(a).toMatchObject({ sent: null, reason: 'consent_revoked' });
    expect(b.sent?.kind).toBe('identify');
    expect(adapter.identifies).toHaveLength(1);
    expect(adapter.identifies[0]!.identity.userId).toBe(inB);
  });

  it('defaults to STRICT when no resolver is given', async () => {
    const id = await makeCustomer(STORE_A, false);
    const r = await handleCdpEvent(customerCreated(id), 'out-m9', deps());
    expect(r).toMatchObject({ sent: null, reason: 'consent_revoked' });
  });

  it('puts the mode on the per-event log line, for a send and for a drop', async () => {
    const lines: CdpLogLine[] = [];
    const sent = await makeCustomer(STORE_A, true);
    const dropped = await makeCustomer(STORE_A, false);

    await handleCdpEvent(
      customerCreated(sent),
      'out-m10',
      deps({ consentModeFor: modes({}, 'analytics'), log: (l) => lines.push(l) }),
    );
    await handleCdpEvent(
      customerCreated(dropped),
      'out-m11',
      deps({ consentModeFor: modes({}, 'strict'), log: (l) => lines.push(l) }),
    );

    expect(lines[0]).toMatchObject({ event: 'sent', consent_mode: 'analytics' });
    expect(lines[1]).toMatchObject({
      event: 'dropped',
      consent_mode: 'strict',
      reason: 'consent_revoked',
    });
    // Still no PII on a log line.
    expect(JSON.stringify(lines)).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });

  it('SUPPRESSES WITH BOTH IDS when the erasure payload carries a hash (#580 v2)', async () => {
    // `customerErased` is the v2 fixture (#583), so the hash arrives in the payload as the core sends it.
    const id = await makeCustomer(STORE_A, true);
    const e = customerErased(id);
    expect(e.version).toBe(2);

    const r = await handleCdpEvent(e, 'out-m12', deps({ consentModeFor: modes({}, 'analytics') }));
    expect(r.sent?.kind).toBe('suppress');
    expect(adapter.suppressions[0]!.identity).toEqual({ userId: id, anonymousId: EMAIL_HASH });
    // Both keys are suppressed as far as the adapter is concerned.
    expect(adapter.isSuppressed(id)).toBe(true);
    expect(adapter.isSuppressed(EMAIL_HASH)).toBe(true);
  });

  it('suppresses by customer_id alone on a GENUINE v1 payload, in both modes', async () => {
    for (const mode of ['analytics', 'strict'] as const) {
      adapter = new MemoryCdpAdapter();
      const id = await makeCustomer(STORE_A, true);
      const e = customerErasedV1(id);
      // The two guards that make the assertion below about the v1 PATH rather than about the fixture: a v2
      // envelope would carry a hash, and `anonymousId: null` would then be testing nothing.
      expect(e.version).toBe(1);
      expect(e.payload).not.toHaveProperty('email_hash');
      const r = await handleCdpEvent(
        e,
        `out-m13-${mode}`,
        deps({ consentModeFor: modes({}, mode) }),
      );
      expect(r.sent?.kind).toBe('suppress');
      expect(adapter.suppressions[0]!.identity).toEqual({ userId: id, anonymousId: null });
    }
  });
});

// ---- live ---------------------------------------------------------------------------------------------------

async function probeBroker(): Promise<string | null> {
  const [hostPort] = brokersFromEnv();
  const [host, port] = hostPort!.split(':');
  return new Promise((done) => {
    const s = net.connect({
      host: host === 'localhost' ? '127.0.0.1' : host!,
      port: Number(port),
      timeout: 1500,
    });
    s.once('connect', () => (s.destroy(), done(null)));
    s.once('error', (e) => done(`${hostPort}: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    s.once('timeout', () => (s.destroy(), done(`${hostPort}: timeout`)));
  });
}
const brokerDown = await probeBroker();
if (brokerDown) {
  console.warn(`cdp/consumer.test: broker ${brokerDown} — live block skipped (pnpm compose:up)`);
}

describe.runIf(brokerDown === null)(
  'cdp consumer against the local Redpanda (prefixed, self-cleaning)',
  () => {
    const prefix = `t-cdp-${Math.random().toString(36).slice(2, 8)}.`;
    const kafka = createKafka({ clientId: 'engagement-cdp-test' });
    const publisher = createKafkaPublisher(kafka, { retries: 1 });
    const topics: EventTopic[] = ['customer.created', 'payment.captured', 'customer.erased'];
    const policy: TopicPolicy = {
      environments: { t: { partitions: 2, replication: 1 } },
      retention: { forever: [], days_30: ['customer.', 'payment.'] },
      dlq: { prefix: 'dlq.', consumer_groups: [] },
    };
    const started: { stop(): Promise<void> }[] = [];

    const until = async (cond: () => boolean, ms = 30_000, what = 'condition') => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const run = async (c: { stop(): Promise<void> }, body: () => Promise<void>) => {
      started.push(c);
      try {
        await body();
      } finally {
        await c.stop();
      }
    };
    const ensure = async (topicPrefix: string) => {
      const admin = kafka.admin();
      await admin.connect();
      try {
        await ensureTopics(
          admin,
          planTopics(policy, { environment: 't', prefix: topicPrefix, topics }),
        );
      } finally {
        await admin.disconnect();
      }
    };

    beforeAll(async () => {
      await ensure(prefix);
      await publisher.connect();
    }, 60_000);

    afterAll(async () => {
      for (const c of started) await c.stop();
      await publisher.disconnect().catch(() => {});
      const admin = kafka.admin();
      await admin.connect();
      try {
        const mine = (await admin.listTopics()).filter((t) => t.startsWith(prefix));
        if (mine.length) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
        console.info(`cdp/consumer.test: deleted ${mine.length} topic(s) with prefix ${prefix}`);
        expect((await admin.listTopics()).filter((t) => t.startsWith(prefix))).toEqual([]);
      } finally {
        await admin.disconnect();
      }
    }, 60_000);

    it('sends for a consenting customer and nothing for a revoked one, off the real bus', async () => {
      const consenting = await makeCustomer(STORE_A, true);
      const revoked = await makeCustomer(STORE_A, false);
      const consumer = createCdpConsumer({
        hq,
        pool: db.app,
        adapter,
        storeClientFor,
        topicPrefix: prefix,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();
        await publisher.send(
          `${prefix}customer.created`,
          [customerCreated(consenting), customerCreated(revoked)].map((e) =>
            envelopeToMessage(e, 'test'),
          ),
        );
        await until(() => consumer.sent + consumer.dropped >= 2, 30_000, 'both events handled');

        expect(adapter.identifies).toHaveLength(1);
        expect(adapter.identifies[0]!.identity.userId).toBe(consenting);
        expect(consumer.sent).toBe(1);
        expect(consumer.dropped).toBe(1);

        // Both are marked: a dropped event is finished, not retried forever.
        const marks = await hq.query(
          `SELECT count(*)::int AS n FROM ${PROCESSED_TABLE} WHERE group_id = $1`,
          [CDP_GROUP_ID],
        );
        expect((marks.rows[0] as { n: number }).n).toBe(2);
        expect(consumer.dlqTopic).toBe(`${prefix}${dlqTopicName(CDP_GROUP_ID)}`);
      });
    }, 90_000);

    it('sends nothing for an event already marked for this group, however it reaches it', async () => {
      // Fresh topics, so no committed offset can be mistaken for dedupe: the MARK is what silences it.
      const replayPrefix = `${prefix}replay.`;
      await ensure(replayPrefix);

      const done = await makeCustomer(STORE_A, true);
      const fresh = await makeCustomer(STORE_A, true);
      const doneEvent = customerCreated(done);
      const freshEvent = customerCreated(fresh);
      await hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
        CDP_GROUP_ID,
        doneEvent.event_id,
      ]);

      const consumer = createCdpConsumer({
        hq,
        pool: db.app,
        adapter,
        storeClientFor,
        topicPrefix: replayPrefix,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();
        await publisher.send(
          `${replayPrefix}customer.created`,
          [doneEvent, freshEvent].map((e) => envelopeToMessage(e, 'test')),
        );
        // The unmarked one proves the consumer really is reading this topic.
        await until(() => adapter.identifies.length >= 1, 30_000, 'the unmarked identify');
        await new Promise((r) => setTimeout(r, 1500));

        expect(adapter.identifies).toHaveLength(1);
        expect(adapter.identifies[0]!.identity.userId).toBe(fresh);
      });
    }, 90_000);

    it('a refusing adapter dead-letters with the error class and no payload', async () => {
      const deadPrefix = `${prefix}dead.`;
      await ensure(deadPrefix);

      const id = await makeCustomer(STORE_A, true);
      adapter.failWith = new CdpError('rudderstack /v1/identify: HTTP 500');
      const consumer = createCdpConsumer({
        hq,
        pool: db.app,
        adapter,
        storeClientFor,
        topicPrefix: deadPrefix,
        retries: 2,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();
        const event = customerCreated(id);
        await publisher.send(`${deadPrefix}customer.created`, [envelopeToMessage(event, 'test')]);

        const deadline = Date.now() + 40_000;
        let entry: Awaited<ReturnType<typeof readDeadLetters>>[number] | undefined;
        while (!entry && Date.now() < deadline) {
          const dead = await readDeadLetters(CDP_GROUP_ID, { kafka, topicPrefix: deadPrefix });
          entry = dead.find((d) => d.outbox_id === event.event_id);
          if (!entry) await new Promise((r) => setTimeout(r, 1000));
        }
        expect(entry, 'the message was not dead-lettered within 40 s').toBeDefined();
        expect(entry).toMatchObject({
          group_id: CDP_GROUP_ID,
          event_topic: 'customer.created',
          error_class: 'CdpError',
        });
        // No payload in a dead letter: nothing of the customer is in it.
        expect(JSON.stringify(entry)).not.toContain(id);
        expect(JSON.stringify(entry)).not.toContain(EMAIL_HASH);

        // Nothing marked: the handler never succeeded.
        const marks = await hq.query(
          `SELECT 1 FROM ${PROCESSED_TABLE} WHERE group_id = $1 AND outbox_id = $2`,
          [CDP_GROUP_ID, event.event_id],
        );
        expect(marks.rows).toEqual([]);
      });
    }, 120_000);
  },
);
