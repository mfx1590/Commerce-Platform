// The erasure-aware replay (#629). The outbox keeps every payload, so a replay must not hand an erased customer's ids
// back to the bus: per store, every row that names an erased customer is skipped, order.placed included (until
// order.placed@2, #696, lets the replay send it without the ids), customer.erased keeps its payload, and on every
// topic an envelope actor that is an erased customer of the store loses its id (#700 review: a signed-in checkout
// stamps the customer as the actor of payment.authorized, order.confirmed, …).
import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import {
  EVENT_SCHEMAS,
  EVENT_TOPICS,
  type EventEnvelope,
  type RelayMessage,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore } from '../modules/registry';
import { buildEvent, withEvents } from './index';
import { runRelayLoop } from './relay';
import { actorErased, ERASURE_RULES, namesErased, replayOutbox } from './replay';

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

  const events = [
    await orderPlaced(storeA, X, HX), // X's own order: skipped
    await orderPlaced(storeA, null, HX), // X's guest order before registering: skipped by the hash
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

describe('ERASURE_RULES', () => {
  it('covers every schema that names a customer anywhere in it (customer_id, *_customer_id, email_hash, identity_id, requested_by), except customer.erased', () => {
    // recursive: nested properties, array items and oneOf/anyOf/allOf branches count too (#700 review)
    const propertyNames = (s: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(s)) for (const x of s) propertyNames(x, out);
      else if (s && typeof s === 'object') {
        const o = s as Record<string, unknown>;
        for (const [k, v] of Object.entries((o.properties as object) ?? {})) {
          out.add(k);
          propertyNames(v, out);
        }
        for (const k of ['items', 'prefixItems', 'oneOf', 'anyOf', 'allOf'])
          propertyNames(o[k], out);
      }
      return out;
    };
    const NAMES_CUSTOMER = /(^|_)customer_id$|^email_hash$|^identity_id$|^requested_by$/;
    const naming = Object.entries(EVENT_SCHEMAS)
      .filter(([, s]) => [...propertyNames(s)].some((k) => NAMES_CUSTOMER.test(k)))
      .map(([key]) => key.split('@')[0]!);
    // the walker reaches nested names (order.placed's line items) and branches (cart.abandoned's nullable hash)
    expect(propertyNames(EVENT_SCHEMAS['order.placed@1'])).toContain('order_line_item_id');
    const topics = [...new Set(naming)].filter((t) => t !== 'customer.erased').sort();
    expect(Object.keys(ERASURE_RULES).sort()).toEqual(topics);
    for (const t of Object.keys(ERASURE_RULES)) expect(EVENT_TOPICS).toContain(t);
  });

  it('matches per store, by customer id or e-mail hash, and every referral party', () => {
    const erased = { customers: 1, keys: new Set([`s1|c:${X}`, `s1|h:${HX}`]) };
    expect(namesErased('order.placed', 's1', { customer_id: null, email_hash: HX }, erased)).toBe(
      true,
    );
    expect(namesErased('order.placed', 's2', { customer_id: X, email_hash: HX }, erased)).toBe(
      false,
    );
    expect(
      namesErased(
        'referral.converted',
        's1',
        { referrer_customer_id: Y, referee_customer_id: X },
        erased,
      ),
    ).toBe(true);
    expect(namesErased('customer.erased', 's1', { customer_id: X }, erased)).toBe(false);
    expect(namesErased('payment.captured', 's1', { customer_id: X }, erased)).toBe(false);
    // the envelope actor: a customer erased in that store, never a staff id that happens to match
    expect(actorErased('s1', customerActor(X), erased)).toBe(true);
    expect(actorErased('s2', customerActor(X), erased)).toBe(false);
    expect(actorErased('s1', { type: 'staff', id: X }, erased)).toBe(false);
    expect(actorErased('s1', customerActor(null), erased)).toBe(false);
  });
});

describe('replayOutbox with an erased customer (database, recording publisher)', () => {
  it('skips the erased customer’s order.placed in that store only, by id and by hash, and counts it per type', async () => {
    const r = recorder();
    const summary = await replayOutbox(hq, r.publisher, {
      organizationId: ORG,
      topic: 'order.placed',
      log: quiet,
    });
    expect(summary).toMatchObject({
      rows: 4,
      published: 2,
      erased_customers: 1,
      erased_skipped: { 'order.placed': 2 },
    });
    const out = r.envelopes();
    expect(out.map((e) => [e.store_id, (e.payload as { email_hash: string }).email_hash])).toEqual([
      [storeA, HY],
      [storeB, HX],
    ]);
    // nothing on the wire carries the erased customer's id, or their hash in store A
    const wire = r.sent.flatMap((s) => s.messages.map((m) => m.value));
    expect(wire.filter((v) => v.includes(X))).toEqual([]);
    expect(wire.filter((v) => v.includes(HX) && v.includes(storeA))).toEqual([]);

    // the skipped rows were the erased customer's; the actor of Y's order is Y
    expect(summary.erased_actors).toBe(0);

    // a store without erased customers replays as before
    expect(
      await replayOutbox(hq, recorder().publisher, {
        organizationId: ORG,
        topic: 'order.placed',
        storeId: storeB,
        log: quiet,
      }),
    ).toMatchObject({ published: 1, erased_customers: 0, erased_skipped: { 'order.placed': 0 } });
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
    ).toMatchObject({ rows: 2, published: 1, erased_skipped: { 'cart.abandoned': 1 } });
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
