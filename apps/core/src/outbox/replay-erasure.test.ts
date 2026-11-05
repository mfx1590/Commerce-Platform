// The erasure-aware replay (#629). The outbox keeps every payload, so a replay must not hand an erased customer's ids
// back to the bus: per store, an order.placed that names an erased customer is SCRUBBED (sent as order.placed@2 with
// customer_id and email_hash null, the event_id unchanged; #629 decision 2(i), possible since @2 landed in #716), every
// other row that names one is skipped, customer.erased keeps its payload, and on every topic an envelope actor that is
// an erased customer of the store loses its id (#700 review: a signed-in checkout stamps the customer as the actor of
// payment.authorized, order.confirmed, …).
import net from 'node:net';
import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import {
  brokersFromEnv,
  createKafka,
  createKafkaPublisher,
  createValidator,
  decodeMessage,
  ensureTopics,
  planTopics,
  readTopicToEnd,
  type EventEnvelope,
  type RelayMessage,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore } from '../modules/registry';
import { buildEvent, withEvents } from './index';
import { runRelayLoop } from './relay';
import { replayOutbox } from './replay';

const ORG = '32000000-0000-4000-8000-000000000002';
const LE = '32000000-0000-4000-8000-000000000012';
const quiet = () => {};
const uuid = () => crypto.randomUUID();

// the erased customer X (store A), a customer Y who stays, and X's hash again as a guest in store B
const X = uuid();
const Y = uuid();
const HX = 'a1'.repeat(32);
const HY = 'b2'.repeat(32);

let db: TestDatabase;
let hq: ReturnType<typeof createOrganizationClient>;
let storeA = '';
let storeB = '';
// the two rows the scrub rewrites: X's own order STORED AS v1 (history from before #716) and X's guest order (v2)
let orderXv1 = '';
let guestOrderX = '';

// ERASURE_RULES, namesErased and actorErased, and the guard that every schema naming a customer has a rule, are
// @platform/events' since #703 (packages/events/test/erasure.test.ts); this file tests the outbox replay with them.
const customerActor = (id: string | null) => ({ type: 'customer' as const, id });

const orderPlaced = (storeId: string, customerId: string | null, emailHash: string) => {
  const orderId = uuid();
  return buildEvent({
    organizationId: ORG,
    storeId,
    aggregateType: 'order',
    aggregateId: orderId,
    topic: 'order.placed',
    actor: customerActor(customerId),
    payload: {
      order_id: orderId,
      display_id: 1,
      legal_entity_id: LE,
      sales_channel_id: uuid(),
      customer_id: customerId,
      email_hash: emailHash,
      currency: 'EUR',
      locale: 'en-GB',
      totals: {
        subtotal_minor: 1999,
        discount_minor: 0,
        shipping_minor: 0,
        tax_minor: 0,
        total_minor: 1999,
      },
      line_items: [
        {
          order_line_item_id: uuid(),
          variant_id: uuid(),
          sku: 'TEE-M-RED',
          title: 'Tee',
          quantity: 1,
          unit_price_minor: 1999,
          discount_minor: 0,
          tax_rate_bp: 0,
          tax_minor: 0,
          total_minor: 1999,
        },
      ],
      shipping: {
        shipping_option_id: null,
        code: 'standard',
        name: 'Standard',
        carrier: 'manual',
        price_minor: 0,
      },
      shipping_country: 'NL',
      billing_country: 'NL',
      promotion_codes: [],
      placed_at: new Date().toISOString(),
    },
  });
};

/** A topic outside ERASURE_RULES whose envelope actor is the signed-in customer (store-routes.ts completeCart). */
const paymentAuthorized = (storeId: string, actorId: string) => {
  const paymentId = uuid();
  return buildEvent({
    organizationId: ORG,
    storeId,
    aggregateType: 'payment',
    aggregateId: paymentId,
    topic: 'payment.authorized',
    actor: customerActor(actorId),
    payload: {
      payment_id: paymentId,
      order_id: uuid(),
      legal_entity_id: LE,
      provider: 'manual',
      provider_payment_id: null,
      amount_minor: 1999,
      currency: 'EUR',
      authorized_at: new Date().toISOString(),
    },
  });
};

const cartAbandoned = (storeId: string, customerId: string, emailHash: string) => {
  const cartId = uuid();
  return buildEvent({
    organizationId: ORG,
    storeId,
    aggregateType: 'cart',
    aggregateId: cartId,
    topic: 'cart.abandoned',
    payload: {
      cart_id: cartId,
      customer_id: customerId,
      email_hash: emailHash,
      currency: 'EUR',
      total_minor: 1999,
      line_item_count: 1,
      last_activity_at: new Date().toISOString(),
      abandoned_at: new Date().toISOString(),
      has_attribution: false,
    },
  });
};

/** Drains every unpublished row through a no-op relay, so the replay (PUBLISHED rows only) sees them. */
async function publishAll(): Promise<void> {
  const controller = new AbortController();
  await runRelayLoop(
    hq,
    { send: async () => {} },
    {
      organizationId: ORG,
      intervalMs: 10,
      signal: controller.signal,
      log: (l) => {
        if (l.batch === 0) controller.abort();
      },
    },
  );
}

function recorder() {
  const sent: { topic: string; messages: RelayMessage[] }[] = [];
  return {
    sent,
    publisher: {
      send: async (topic: string, messages: RelayMessage[]) => {
        sent.push({ topic, messages });
      },
    },
    envelopes: () =>
      sent.flatMap((s) => s.messages.map((m) => JSON.parse(m.value) as EventEnvelope)),
  };
}

beforeAll(async () => {
  db = await createTestDatabase('core_replay_erasure');
  const owner = createOrganizationClient(db.owner, { organizationId: ORG });
  await owner.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq-e', 'HQ E')`, [ORG]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le-e', 'LE E', 'NL', 'EUR')`,
      [LE, ORG],
    );
  });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  const store = async (code: string) =>
    (
      await createStore(hq, {
        legal_entity_id: LE,
        code,
        name: code,
        default_currency: 'EUR',
        default_locale: 'en-GB',
        default_country: 'NL',
      })
    ).id;
  storeA = await store('brand-ea');
  storeB = await store('brand-eb');

  const ownV1 = { ...(await orderPlaced(storeA, X, HX)), version: 1 }; // scrubbed v1 → v2
  const guest = await orderPlaced(storeA, null, HX); // scrubbed by the hash alone
  orderXv1 = ownV1.event_id;
  guestOrderX = guest.event_id;
  const events = [
    ownV1, // X's own order, stored as v1 before @2 existed: sent scrubbed as v2
    guest, // X's guest order before registering: sent scrubbed (matched by the hash)
    await orderPlaced(storeA, Y, HY), // Y stays
    await orderPlaced(storeB, null, HX), // the same person in another store, not erased there
    await cartAbandoned(storeA, X, HX), // skipped
    await cartAbandoned(storeA, Y, HY),
    await paymentAuthorized(storeA, X), // sent, the actor id nulled
    await paymentAuthorized(storeA, Y), // sent as it is
    await buildEvent({
      organizationId: ORG,
      storeId: storeA,
      aggregateType: 'customer',
      aggregateId: X,
      topic: 'customer.erased',
      actor: customerActor(X), // eraseMe: the customer erased themself
      payload: {
        customer_id: X,
        identity_id: null,
        email_hash: HX,
        erased_at: new Date().toISOString(),
      },
    }),
  ];
  await hq.transaction((tx) => withEvents(tx, events));
  await publishAll();
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe('replayOutbox with an erased customer (database, recording publisher)', () => {
  it('scrubs the erased customer’s order.placed in that store only (by id and by hash) to a valid v2, same event_id, and counts it per type', async () => {
    const r = recorder();
    const summary = await replayOutbox(hq, r.publisher, {
      organizationId: ORG,
      topic: 'order.placed',
      // the schema id follows the SENT version: a scrubbed v1 row goes out as @2
      schemaIds: { 'order.placed@1': 101, 'order.placed@2': 202 },
      log: quiet,
    });
    expect(summary).toMatchObject({
      rows: 4,
      published: 4,
      erased_customers: 1,
      erased_skipped: { 'order.placed': 0 },
      erased_scrubbed: { 'order.placed': 2 },
      erased_actors: 1, // X's own order: X was the actor too
    });
    const out = r.envelopes();
    const byId = new Map(out.map((e) => [e.event_id, e]));
    for (const id of [orderXv1, guestOrderX]) {
      expect(byId.get(id)).toMatchObject({
        version: 2,
        store_id: storeA,
        payload: { customer_id: null, email_hash: null },
      });
    }
    expect(byId.get(orderXv1)!.actor).toEqual(customerActor(null));
    // everything but the identifiers is unchanged: the original rows, field by field
    const stored = await hq.query<{ id: string; payload: Record<string, unknown> }>(
      `SELECT id, payload FROM outbox WHERE id = ANY($1::uuid[])`,
      [[orderXv1, guestOrderX]],
    );
    for (const row of stored.rows) {
      expect(byId.get(row.id)!.payload).toEqual({
        ...row.payload,
        customer_id: null,
        email_hash: null,
      });
    }
    // every message on the wire validates as what it says it is
    const v = createValidator();
    for (const e of out) expect(v.validateEnvelope(e)).toEqual({ ok: true, errors: [] });
    // the version and schema-id headers follow the scrubbed version
    const headersOf = (id: string) =>
      r.sent.flatMap((x) => x.messages).find((m) => m.headers.outbox_id === id)!.headers;
    expect(headersOf(orderXv1)).toMatchObject({ version: '2', schema_id: '202' });
    // nothing on the wire carries the erased customer's id, or their hash in store A
    const wire = r.sent.flatMap((x) => x.messages.map((m) => m.value));
    expect(wire.filter((val) => val.includes(X))).toEqual([]);
    expect(wire.filter((val) => val.includes(HX) && val.includes(storeA))).toEqual([]);
    // Y's order and the same person's order in store B (not erased there) go out as stored
    expect(
      out
        .filter((e) => ![orderXv1, guestOrderX].includes(e.event_id))
        .map((e) => [e.store_id, (e.payload as { email_hash: string }).email_hash]),
    ).toEqual([
      [storeA, HY],
      [storeB, HX],
    ]);

    // a store without erased customers replays as before
    expect(
      await replayOutbox(hq, recorder().publisher, {
        organizationId: ORG,
        topic: 'order.placed',
        storeId: storeB,
        log: quiet,
      }),
    ).toMatchObject({
      published: 1,
      erased_customers: 0,
      erased_skipped: { 'order.placed': 0 },
      erased_scrubbed: { 'order.placed': 0 },
    });
  });

  it('nulls the actor id of an erased customer on a topic outside the rules, and leaves the payload and other actors', async () => {
    const r = recorder();
    expect(
      await replayOutbox(hq, r.publisher, {
        organizationId: ORG,
        topic: 'payment.authorized',
        log: quiet,
      }),
    ).toMatchObject({
      rows: 2,
      published: 2,
      erased_customers: 1,
      erased_actors: 1,
      erased_skipped: {},
    });
    expect(r.envelopes().map((e) => e.actor)).toEqual([customerActor(null), customerActor(Y)]);
    const wire = r.sent.flatMap((s) => s.messages.map((m) => m.value));
    expect(wire).toHaveLength(2);
    expect(wire.filter((v) => v.includes(X))).toEqual([]);
    expect(wire.filter((v) => v.includes(Y))).toHaveLength(1);
  });

  it('skips the erased customer’s cart.abandoned, sends customer.erased with its payload, and the dry run counts the erased', async () => {
    const carts = recorder();
    expect(
      await replayOutbox(hq, carts.publisher, {
        organizationId: ORG,
        topic: 'cart.abandoned',
        log: quiet,
      }),
    ).toMatchObject({
      rows: 2,
      published: 1,
      erased_skipped: { 'cart.abandoned': 1 },
      erased_scrubbed: {},
    });
    expect(
      carts.envelopes().map((e) => (e.payload as { customer_id: string }).customer_id),
    ).toEqual([Y]);

    const erasures = recorder();
    const whole = await replayOutbox(hq, erasures.publisher, {
      organizationId: ORG,
      topic: 'customer.erased',
      log: quiet,
    });
    expect(whole).toMatchObject({
      published: 1,
      erased_customers: 1,
      erased_actors: 1,
      erased_skipped: {},
    });
    // the instruction keeps its ids (every consumer needs them); the actor is no longer the customer's id
    expect(erasures.envelopes()[0]).toMatchObject({
      actor: customerActor(null),
      payload: { customer_id: X, email_hash: HX },
    });

    expect(
      await replayOutbox(hq, carts.publisher, {
        organizationId: ORG,
        topic: 'order.placed',
        dryRun: true,
        log: quiet,
      }),
    ).toMatchObject({ rows: 4, published: 0, erased_customers: 1 });
    // order.placed scrubs; a dry run sends nothing and counts nothing as scrubbed
  });

  it('a batch whose every row is skipped sends nothing and the replay still moves on', async () => {
    const r = recorder();
    const summary = await replayOutbox(hq, r.publisher, {
      organizationId: ORG,
      topic: 'cart.abandoned',
      batchSize: 1,
      log: quiet,
    });
    expect(summary).toMatchObject({
      rows: 2,
      published: 1,
      batches: 2,
      erased_skipped: { 'cart.abandoned': 1 },
    });
    expect(r.sent).toHaveLength(1);
  });
});

describe('the replay scans (#702)', () => {
  // seq scans priced out, so the plan shows which index the planner CAN use; without outbox_topic_seq_idx both
  // queries fall back to a (disabled, still chosen) sequential scan of the whole outbox
  const planOf = (sql: string) =>
    hq.transaction(async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const r = await tx.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`);
      return JSON.stringify(r.rows[0]!['QUERY PLAN']);
    });

  it('a topic in seq order and the erased set both read outbox_topic_seq_idx', async () => {
    expect(
      await planOf(
        `SELECT id FROM outbox o WHERE o.topic = 'order.placed' AND o.published_at IS NOT NULL AND o.seq > 0 ORDER BY o.seq LIMIT 500`,
      ),
    ).toContain('outbox_topic_seq_idx');
    expect(
      await planOf(
        `SELECT store_id, payload->>'customer_id' FROM outbox WHERE topic = 'customer.erased'`,
      ),
    ).toContain('outbox_topic_seq_idx');
  });
});

// ---- live: the scrubbed order on a real broker (prefixed topic, self-cleaning; skipped when the broker is down) ----

async function probeBroker(): Promise<string | null> {
  const [hostPort] = brokersFromEnv();
  const [host, port] = hostPort!.split(':');
  return new Promise((done) => {
    const sock = net.connect({
      host: host === 'localhost' ? '127.0.0.1' : host!,
      port: Number(port),
      timeout: 1500,
    });
    sock.once('connect', () => (sock.destroy(), done(null)));
    sock.once('error', (e) =>
      done(`${hostPort}: ${(e as NodeJS.ErrnoException).code ?? e.message}`),
    );
    sock.once('timeout', () => (sock.destroy(), done(`${hostPort}: timeout`)));
  });
}
const brokerDown = await probeBroker();
if (brokerDown)
  console.warn(
    `replay-erasure.test: broker ${brokerDown} — the live scrub case is skipped (pnpm compose:up)`,
  );

describe.runIf(brokerDown === null)(
  'the scrubbed order.placed on the local Redpanda (#629)',
  () => {
    const prefix = `t-${Math.random().toString(36).slice(2, 8)}.`;
    const kafka = createKafka({ clientId: 'replay-erasure-test' });

    afterAll(async () => {
      const admin = kafka.admin();
      await admin.connect();
      try {
        const mine = (await admin.listTopics()).filter((t) => t.startsWith(prefix));
        if (mine.length) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
        const groups = (await admin.listGroups()).groups
          .map((g) => g.groupId)
          .filter((g) => g.startsWith(prefix));
        if (groups.length) await admin.deleteGroups(groups).catch(() => {});
        console.info(`replay-erasure.test: deleted ${mine.length} topic(s) with prefix ${prefix}`);
      } finally {
        await admin.disconnect();
      }
    }, 60_000);

    it('the replay puts the scrubbed v2 on the wire: version header and envelope 2, identifiers null, event_id kept, @2 schema id', async () => {
      const admin = kafka.admin();
      await admin.connect();
      await ensureTopics(
        admin,
        planTopics(
          {
            environments: { t: { partitions: 1, replication: 1 } },
            retention: { forever: [], days_30: ['order.'] },
            dlq: { prefix: 'dlq.', consumer_groups: [] },
          },
          { environment: 't', prefix, topics: ['order.placed'] },
        ),
      );
      await admin.disconnect();
      const publisher = createKafkaPublisher(kafka, { retries: 1 });
      await publisher.connect();
      try {
        expect(
          await replayOutbox(hq, publisher, {
            organizationId: ORG,
            topic: 'order.placed',
            topicPrefix: prefix,
            schemaIds: { 'order.placed@1': 101, 'order.placed@2': 202 },
            log: quiet,
          }),
        ).toMatchObject({ published: 4, erased_scrubbed: { 'order.placed': 2 } });
      } finally {
        await publisher.disconnect();
      }
      const read = await readTopicToEnd(kafka, `${prefix}order.placed`, `${prefix}reader`, 20_000, {
        strict: true,
      });
      expect(read).toHaveLength(4);
      const decoded = read.map((m) =>
        decodeMessage({ key: m.key, value: m.value, headers: m.headers }),
      );
      for (const id of [orderXv1, guestOrderX]) {
        const d = decoded.find((x) => x.outboxId === id)!;
        expect(d.headers.version).toBe('2');
        expect(d.schemaId).toBe(202);
        expect(d.envelope).toMatchObject({
          event_id: id,
          version: 2,
          payload: { customer_id: null, email_hash: null },
        });
      }
      expect(read.map((m) => m.value!.toString()).filter((val) => val.includes(X))).toEqual([]);
    }, 90_000);
  },
);
