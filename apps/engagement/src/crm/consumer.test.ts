// The CRM consumer on a throwaway database, then a live block against the local Redpanda.
//
// The two things most worth proving here: a redelivery writes the SAME contact (idempotency by recomputation,
// not by the marks), and no consent means no Admin API call at all — the PII is never even fetched.

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
  type EventEnvelopeV1Base,
  type EventTopic,
  type TopicPolicy,
} from '@platform/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONSENT_PURPOSE } from '../cdp/consent.js';
import { PROCESSED_TABLE } from '../ops/consumer.js';
import { MemoryCrmAdapter } from './adapter/memory.js';
import { CRM_GROUP_ID, createCrmConsumer, handleCrmEvent, type CrmLogLine } from './consumer.js';
import { CrmError, type AdminCustomer } from './types.js';
import type { CustomerReader } from './admin-api.js';

const ORG = SEED_IDS.organization;
const STORE_A = SEED_IDS.stores.brandA;
const STORE_B = SEED_IDS.stores.brandB;
const IDENTITY_ID = '99999999-9999-4999-8999-999999999999';

const validator = createValidator();

let db: TestDatabase;
let hq: ScopedClient;
let adapter: MemoryCrmAdapter;
let reads: string[];
let customers: CustomerReader;

function storeClientFor(storeId: string): ScopedClient {
  return createTenantClient(db.app, { organizationId: ORG, storeIds: [storeId] });
}

/** A reader that records every call, so "no consent means no PII fetch" is provable. */
function recordingReader(
  pii: Partial<AdminCustomer> = {},
  opts: { missing?: boolean } = {},
): CustomerReader {
  return {
    async getCustomer(storeId, customerId) {
      reads.push(customerId);
      if (opts.missing) return null;
      return {
        id: customerId,
        email: 'ada@example.test',
        first_name: 'Ada',
        last_name: 'Lovelace',
        status: 'registered',
        ...pii,
      };
    },
  };
}

function deps(over: Partial<Parameters<typeof handleCrmEvent>[2]> = {}) {
  return { hq, storeClientFor, customers, adapter, ...over };
}

function envelopeFor(
  topic: EventTopic,
  payload: Record<string, unknown>,
  aggregate: { type: EventEnvelopeV1Base['aggregate_type']; id: string },
  storeId: string | null = STORE_A,
): EventEnvelopeV1Base {
  const e = makeEvent({
    topic,
    organizationId: ORG,
    storeId,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload: payload as never,
  });
  const check = validator.validateEnvelope(e);
  expect(check.ok, `${topic}: ${check.errors?.join('; ')}`).toBe(true);
  return e as EventEnvelopeV1Base;
}

const customerUpdated = (customerId: string) =>
  envelopeFor(
    'customer.updated',
    {
      customer_id: customerId,
      identity_id: IDENTITY_ID,
      email_hash: 'f'.repeat(64),
      status: 'registered',
      customer_group_id: null,
      marketing_consent: true,
      changed_fields: ['first_name'],
    },
    { type: 'customer', id: customerId },
  );

const customerErased = (customerId: string) =>
  envelopeFor(
    'customer.erased',
    { customer_id: customerId, identity_id: IDENTITY_ID, erased_at: '2026-10-23T12:00:00.000Z' },
    { type: 'customer', id: customerId },
  );

const orderPlaced = (orderId: string, customerId: string | null) =>
  envelopeFor(
    'order.placed',
    {
      order_id: orderId,
      display_id: 1001,
      legal_entity_id: SEED_IDS.legalEntities.brandA,
      sales_channel_id: '88888888-8888-4888-8888-888888888888',
      customer_id: customerId,
      email_hash: 'f'.repeat(64),
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
      placed_at: '2026-10-23T10:00:00.000Z',
    },
    { type: 'order', id: orderId },
  );

// ---- fixtures -----------------------------------------------------------------------------------------------

async function makeCustomer(consent: boolean | null, storeId = STORE_A): Promise<string> {
  const r = await db.owner.query(
    `INSERT INTO customer (organization_id, store_id, email, status, consent)
     VALUES ($1, $2, $3, 'registered', '{}'::jsonb) RETURNING id`,
    [ORG, storeId, `crm-${Math.random().toString(36).slice(2, 10)}@example.test`],
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

async function makeOrder(
  customerId: string | null,
  over: {
    status?: string;
    total?: number;
    currency?: string;
    placedAt?: string;
    storeId?: string;
  } = {},
): Promise<string> {
  const storeId = over.storeId ?? STORE_A;
  const channel = await db.owner.query(`SELECT id FROM sales_channel WHERE store_id = $1 LIMIT 1`, [
    storeId,
  ]);
  const r = await db.owner.query(
    `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, customer_id, email,
                          currency, locale, status, shipping_address, billing_address,
                          subtotal_minor, shipping_minor, tax_minor, total_minor, placed_at)
     VALUES ($1, $2, $3, $4, $5, 'crm-order@example.test', $6, 'en-GB', $7, '{}'::jsonb, '{}'::jsonb,
             9000, 499, 1495, $8, $9)
     RETURNING id`,
    [
      ORG,
      storeId,
      Math.floor(Math.random() * 1_000_000) + 1000,
      (channel.rows[0] as { id: string }).id,
      customerId,
      over.currency ?? 'EUR',
      over.status ?? 'confirmed',
      over.total ?? 10994,
      over.placedAt ?? '2026-10-23T10:00:00.000Z',
    ],
  );
  return (r.rows[0] as { id: string }).id;
}

async function makeRefund(orderId: string, amount: number, status = 'succeeded'): Promise<void> {
  const payment = await db.owner.query(
    // idempotency_key is NOT NULL and per-store by construction (<store_id>:<key>, see the payments module).
    `INSERT INTO payment (organization_id, store_id, order_id, provider, status, amount_minor, currency,
                          idempotency_key)
     VALUES ($1, $2, $3, 'manual', 'captured', $4, 'EUR', $5) RETURNING id`,
    [
      ORG,
      STORE_A,
      orderId,
      amount,
      `${STORE_A}:crm-test-${Math.random().toString(36).slice(2, 10)}`,
    ],
  );
  await db.owner.query(
    `INSERT INTO refund (organization_id, store_id, order_id, payment_id, amount_minor, currency, status,
                         reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'EUR', $6, 'return', $7)`,
    [
      ORG,
      STORE_A,
      orderId,
      (payment.rows[0] as { id: string }).id,
      amount,
      status,
      `${STORE_A}:crm-refund-${Math.random().toString(36).slice(2, 10)}`,
    ],
  );
}

beforeAll(async () => {
  db = await createTestDatabase('platform_crm');
  await seed(db.owner);
  hq = createOrganizationClient(db.app, { organizationId: ORG });
}, 120_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  adapter = new MemoryCrmAdapter();
  reads = [];
  customers = recordingReader();
  await db.owner.query(`DELETE FROM ${PROCESSED_TABLE}`);
  const stores = [STORE_A, STORE_B];
  await db.owner.query(`DELETE FROM refund WHERE store_id = ANY($1::uuid[])`, [stores]);
  await db.owner.query(`DELETE FROM payment WHERE store_id = ANY($1::uuid[])`, [stores]);
  await db.owner.query(`DELETE FROM "order" WHERE store_id = ANY($1::uuid[])`, [stores]);
  await db.owner.query(`DELETE FROM customer WHERE store_id = ANY($1::uuid[])`, [stores]);
});

describe('handleCrmEvent — upsert', () => {
  it('syncs a consenting customer with the PII and the rollup', async () => {
    const id = await makeCustomer(true);
    await makeOrder(id, { total: 10994 });
    const r = await handleCrmEvent(customerUpdated(id), 'out-1', deps());

    expect(r.action).toBe('upserted');
    expect(adapter.get(id)).toEqual({
      externalId: id,
      storeCode: 'brand-a',
      email: 'ada@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      ordersCount: 1,
      netRevenueMinor: 10994,
      currency: 'EUR',
      lastOrderAt: '2026-10-23T10:00:00.000Z',
    });
  });

  it('upserts by OUR customer id, so the contact key is never the e-mail', async () => {
    const id = await makeCustomer(true);
    await handleCrmEvent(customerUpdated(id), 'out-2', deps());
    expect([...adapter.contacts.keys()]).toEqual([id]);
  });

  it('IS IDEMPOTENT on redelivery: the same event twice writes the same contact', async () => {
    const id = await makeCustomer(true);
    await makeOrder(id, { total: 10994 });
    const event = customerUpdated(id);

    await handleCrmEvent(event, 'out-3', deps());
    const first = adapter.get(id);
    await handleCrmEvent(event, 'out-3', deps());
    const second = adapter.get(id);

    expect(second).toEqual(first);
    // Two writes, one contact, and the numbers did not accumulate — the whole reason the rollup recomputes.
    expect(adapter.upserts).toHaveLength(2);
    expect(adapter.contacts.size).toBe(1);
    expect(second!.ordersCount).toBe(1);
    expect(second!.netRevenueMinor).toBe(10994);
  });

  it('reflects the order history as it stands, across placed, cancelled and refunded', async () => {
    const id = await makeCustomer(true);
    const kept = await makeOrder(id, { total: 10000, placedAt: '2026-10-01T10:00:00.000Z' });
    await makeOrder(id, { total: 5000, status: 'cancelled', placedAt: '2026-10-09T10:00:00.000Z' });
    await makeRefund(kept, 2500);

    await handleCrmEvent(customerUpdated(id), 'out-4', deps());
    expect(adapter.get(id)).toMatchObject({
      ordersCount: 1,
      netRevenueMinor: 7500,
      lastOrderAt: '2026-10-01T10:00:00.000Z',
    });
  });

  it('syncs a customer with no orders as zeroes rather than skipping them', async () => {
    const id = await makeCustomer(true);
    await handleCrmEvent(customerUpdated(id), 'out-5', deps());
    expect(adapter.get(id)).toMatchObject({
      ordersCount: 0,
      netRevenueMinor: 0,
      lastOrderAt: null,
    });
  });

  it("NEVER lets another store's order into this customer's rollup (RLS, store-scoped read)", async () => {
    // The read goes through a tenant client scoped to the EVENT's store, so a row belonging to brand-b is
    // invisible to it — not filtered in our SQL, but unreachable. The fixture writes the anomaly deliberately:
    // an order in store B carrying a store-A customer's id, which only the owner role could ever create.
    const id = await makeCustomer(true);
    await makeOrder(id, { total: 10000, placedAt: '2026-10-01T10:00:00.000Z' });
    await makeOrder(id, { total: 99999, storeId: STORE_B, placedAt: '2026-10-09T10:00:00.000Z' });

    await handleCrmEvent(customerUpdated(id), 'out-iso', deps());

    // Store A's order only: one order, its total, and its date — the store-B order contributes nothing.
    expect(adapter.get(id)).toMatchObject({
      storeCode: 'brand-a',
      ordersCount: 1,
      netRevenueMinor: 10000,
      lastOrderAt: '2026-10-01T10:00:00.000Z',
    });
    // The owner role can see both, so the anomaly really is in the database and the isolation is what hid it.
    const all = await db.owner.query(
      'SELECT count(*)::int AS n FROM "order" WHERE customer_id = $1',
      [id],
    );
    expect((all.rows[0] as { n: number }).n).toBe(2);
  });

  it('reads order history READ-ONLY: not one column of order, refund or customer changes', async () => {
    const id = await makeCustomer(true);
    const orderId = await makeOrder(id, { total: 10000 });
    await makeRefund(orderId, 2500);

    // A checksum over every ROW of each table, not counts and a max(updated_at): the claim is that nothing
    // changed, so the test has to be able to see a changed column anywhere (#568 review).
    const checksum = async () =>
      (
        await db.owner.query(
          `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h FROM (
             SELECT t::text AS x FROM "order" t
             UNION ALL SELECT t::text FROM refund t
             UNION ALL SELECT t::text FROM customer t
           ) rows`,
        )
      ).rows[0] as { h: string };

    const before = await checksum();
    await handleCrmEvent(customerUpdated(id), 'out-ro', deps());
    const after = await checksum();
    expect(after.h).toBe(before.h);

    // ...and the checksum really does notice a change, so a passing assertion means something. One column on
    // one row, nothing to do with counts or timestamps.
    await db.owner.query(`UPDATE "order" SET total_minor = total_minor + 1 WHERE id = $1`, [
      orderId,
    ]);
    expect((await checksum()).h).not.toBe(before.h);
  });

  it('resolves the customer from the ORDER for an order-scoped event', async () => {
    const id = await makeCustomer(true);
    const orderId = await makeOrder(id);
    const r = await handleCrmEvent(orderPlaced(orderId, id), 'out-6', deps());
    expect(r.action).toBe('upserted');
    expect(adapter.get(id)?.ordersCount).toBe(1);
  });
});

describe('handleCrmEvent — consent', () => {
  it('syncs NOTHING for a customer who revoked, and never fetches their PII', async () => {
    const id = await makeCustomer(false);
    const r = await handleCrmEvent(customerUpdated(id), 'out-7', deps());

    expect(r).toEqual({ action: 'skipped', reason: 'consent_revoked' });
    expect(adapter.contacts.size).toBe(0);
    // The gate runs BEFORE the Admin API call: no consent, no personal data fetched at all.
    expect(reads).toEqual([]);
  });

  it('syncs nothing for a customer who never answered', async () => {
    const id = await makeCustomer(null);
    const r = await handleCrmEvent(customerUpdated(id), 'out-8', deps());
    expect(r).toEqual({ action: 'skipped', reason: 'consent_absent' });
    expect(reads).toEqual([]);
  });

  it('skips a guest order: there is nobody to be a contact', async () => {
    const orderId = await makeOrder(null);
    const r = await handleCrmEvent(orderPlaced(orderId, null), 'out-9', deps());
    expect(r).toEqual({ action: 'skipped', reason: 'no_identity' });
    expect(reads).toEqual([]);
  });

  it('skips an unmapped topic', async () => {
    const e = envelopeFor(
      'order.confirmed',
      {
        order_id: '11111111-1111-4111-8111-111111111111',
        display_id: 1001,
        confirmed_at: '2026-10-23T10:00:00.000Z',
      },
      { type: 'order', id: '11111111-1111-4111-8111-111111111111' },
    );
    expect(await handleCrmEvent(e, 'out-10', deps())).toEqual({
      action: 'skipped',
      reason: 'unmapped',
    });
  });

  it('skips when the Admin API says the customer is gone', async () => {
    const id = await makeCustomer(true);
    const r = await handleCrmEvent(
      customerUpdated(id),
      'out-11',
      deps({ customers: recordingReader({}, { missing: true }) }),
    );
    expect(r).toEqual({ action: 'skipped', reason: 'customer_gone' });
    expect(adapter.contacts.size).toBe(0);
  });

  it('skips a customer the Admin API reports as erased', async () => {
    const id = await makeCustomer(true);
    const r = await handleCrmEvent(
      customerUpdated(id),
      'out-12',
      deps({ customers: recordingReader({ status: 'erased' }) }),
    );
    expect(r).toEqual({ action: 'skipped', reason: 'customer_gone' });
  });
});

describe('handleCrmEvent — erasure', () => {
  it('REMOVES the contact on customer.erased, whatever consent said', async () => {
    const id = await makeCustomer(true);
    await handleCrmEvent(customerUpdated(id), 'out-13', deps());
    expect(adapter.contacts.size).toBe(1);

    const r = await handleCrmEvent(customerErased(id), 'out-14', deps());
    expect(r).toEqual({ action: 'removed', externalId: id });
    expect(adapter.get(id)).toBeUndefined();
  });

  it('removes even when the customer row and the consent are already gone', async () => {
    const id = await makeCustomer(false);
    await db.owner.query(`DELETE FROM customer WHERE id = $1`, [id]);
    const r = await handleCrmEvent(customerErased(id), 'out-15', deps());
    expect(r).toEqual({ action: 'removed', externalId: id });
    expect(adapter.removed).toEqual([id]);
    // No PII is fetched for an erasure: there is nothing to read and nothing to need.
    expect(reads).toEqual([]);
  });

  it('is idempotent: a redelivered erasure removes again without failing', async () => {
    const id = await makeCustomer(true);
    const e = customerErased(id);
    await handleCrmEvent(e, 'out-16', deps());
    await expect(handleCrmEvent(e, 'out-16', deps())).resolves.toEqual({
      action: 'removed',
      externalId: id,
    });
  });
});

describe('handleCrmEvent — logging and failures', () => {
  it('logs ids and counts, NEVER a name or an e-mail', async () => {
    const lines: CrmLogLine[] = [];
    const id = await makeCustomer(true);
    await makeOrder(id);
    const revoked = await makeCustomer(false);
    const d = deps({ log: (l) => lines.push(l) });

    await handleCrmEvent(customerUpdated(id), 'out-17', d);
    await handleCrmEvent(customerUpdated(revoked), 'out-18', d);
    await handleCrmEvent(customerErased(id), 'out-19', d);

    expect(lines.map((l) => l.event)).toEqual(['upserted', 'skipped', 'removed']);
    expect(lines[0]).toMatchObject({
      service: 'engagement',
      module: 'crm',
      customer_id: id,
      store_code: 'brand-a',
      orders_count: 1,
      mixed_currency: false,
      adapter: 'memory',
    });
    expect(lines[1]).toMatchObject({ reason: 'consent_revoked' });

    const text = JSON.stringify(lines);
    expect(text).not.toContain('ada@example.test');
    expect(text).not.toContain('Ada');
    expect(text).not.toContain('Lovelace');
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });

  it('flags a mixed-currency customer in the log line', async () => {
    const lines: CrmLogLine[] = [];
    const id = await makeCustomer(true);
    await makeOrder(id, { total: 10000, currency: 'EUR' });
    await makeOrder(id, { total: 8000, currency: 'GBP' });
    await handleCrmEvent(customerUpdated(id), 'out-20', deps({ log: (l) => lines.push(l) }));

    expect(lines[0]).toMatchObject({ orders_count: 2, mixed_currency: true });
    // The headline figure stays the store's own currency.
    expect(adapter.get(id)).toMatchObject({ netRevenueMinor: 10000, currency: 'EUR' });
  });

  it('an adapter refusal propagates, so the SDK retries and finally dead-letters', async () => {
    const id = await makeCustomer(true);
    adapter.failWith = new CrmError('twenty upsert: HTTP 500', { retryable: true });
    await expect(handleCrmEvent(customerUpdated(id), 'out-21', deps())).rejects.toThrow('HTTP 500');
  });

  it('an Admin API refusal propagates rather than syncing a contact with no name', async () => {
    const id = await makeCustomer(true);
    const failing: CustomerReader = {
      async getCustomer() {
        throw new CrmError('admin api: HTTP 403', { retryable: true });
      },
    };
    await expect(
      handleCrmEvent(customerUpdated(id), 'out-22', deps({ customers: failing })),
    ).rejects.toThrow('HTTP 403');
    expect(adapter.contacts.size).toBe(0);
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
  console.warn(`crm/consumer.test: broker ${brokerDown} — live block skipped (pnpm compose:up)`);
}

describe.runIf(brokerDown === null)(
  'crm consumer against the local Redpanda (prefixed, self-cleaning)',
  () => {
    const prefix = `t-crm-${Math.random().toString(36).slice(2, 8)}.`;
    const kafka = createKafka({ clientId: 'engagement-crm-test' });
    const publisher = createKafkaPublisher(kafka, { retries: 1 });
    const topics: EventTopic[] = ['customer.updated', 'customer.erased'];
    const policy: TopicPolicy = {
      environments: { t: { partitions: 2, replication: 1 } },
      retention: { forever: [], days_30: ['customer.'] },
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
        console.info(`crm/consumer.test: deleted ${mine.length} topic(s) with prefix ${prefix}`);
        expect((await admin.listTopics()).filter((t) => t.startsWith(prefix))).toEqual([]);
      } finally {
        await admin.disconnect();
      }
    }, 60_000);

    it('upserts a consenting customer and skips a revoked one, off the real bus', async () => {
      const consenting = await makeCustomer(true);
      const revoked = await makeCustomer(false);
      await makeOrder(consenting, { total: 10994 });

      const consumer = createCrmConsumer({
        hq,
        pool: db.app,
        customers,
        adapter,
        storeClientFor,
        topicPrefix: prefix,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();
        await publisher.send(
          `${prefix}customer.updated`,
          [customerUpdated(consenting), customerUpdated(revoked)].map((e) =>
            envelopeToMessage(e, 'test'),
          ),
        );
        await until(() => consumer.upserted + consumer.skipped >= 2, 30_000, 'both events handled');

        expect(consumer.upserted).toBe(1);
        expect(consumer.skipped).toBe(1);
        expect([...adapter.contacts.keys()]).toEqual([consenting]);
        expect(adapter.get(consenting)?.netRevenueMinor).toBe(10994);
        expect(consumer.dlqTopic).toBe(`${prefix}${dlqTopicName(CRM_GROUP_ID)}`);

        const marks = await hq.query(
          `SELECT count(*)::int AS n FROM ${PROCESSED_TABLE} WHERE group_id = $1`,
          [CRM_GROUP_ID],
        );
        expect((marks.rows[0] as { n: number }).n).toBe(2);
      });
    }, 90_000);

    it('does nothing for an event already marked for this group, however it reaches it', async () => {
      const replayPrefix = `${prefix}replay.`;
      await ensure(replayPrefix);

      const done = await makeCustomer(true);
      const fresh = await makeCustomer(true);
      const doneEvent = customerUpdated(done);
      const freshEvent = customerUpdated(fresh);
      await hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
        CRM_GROUP_ID,
        doneEvent.event_id,
      ]);

      const consumer = createCrmConsumer({
        hq,
        pool: db.app,
        customers,
        adapter,
        storeClientFor,
        topicPrefix: replayPrefix,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();
        await publisher.send(
          `${replayPrefix}customer.updated`,
          [doneEvent, freshEvent].map((e) => envelopeToMessage(e, 'test')),
        );
        await until(() => adapter.contacts.size >= 1, 30_000, 'the unmarked upsert');
        await new Promise((r) => setTimeout(r, 1500));
        expect([...adapter.contacts.keys()]).toEqual([fresh]);
      });
    }, 90_000);

    it('removes the contact on customer.erased off the bus', async () => {
      const erasePrefix = `${prefix}erase.`;
      await ensure(erasePrefix);

      const id = await makeCustomer(true);
      await adapter.upsert({
        externalId: id,
        storeCode: 'brand-a',
        email: 'ada@example.test',
        firstName: 'Ada',
        lastName: 'Lovelace',
        ordersCount: 0,
        netRevenueMinor: 0,
        currency: 'EUR',
        lastOrderAt: null,
      });

      const consumer = createCrmConsumer({
        hq,
        pool: db.app,
        customers,
        adapter,
        storeClientFor,
        topicPrefix: erasePrefix,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();
        await publisher.send(`${erasePrefix}customer.erased`, [
          envelopeToMessage(customerErased(id), 'test'),
        ]);
        await until(() => consumer.removed >= 1, 30_000, 'the removal');
        expect(adapter.get(id)).toBeUndefined();
        expect(adapter.removed).toContain(id);
      });
    }, 90_000);
  },
);
