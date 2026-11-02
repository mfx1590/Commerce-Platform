// The erasure-aware replay (#629). The outbox keeps every payload, so a replay must not hand an erased customer's ids
// back to the bus: per store, rows that name an erased customer are skipped, and order.placed (the ledger needs it)
// goes out as order.placed@2 with customer_id and email_hash null. order.placed@2 arrives with #696; until then these
// tests use a local mock of it (v2 = v1 with email_hash nullable) and check that the real contract refuses instead.
import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import {
  createValidator,
  EVENT_SCHEMAS,
  EVENT_TOPICS,
  type EventEnvelope,
  type RelayMessage,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore } from '../modules/registry';
import { buildEvent, withEvents } from './index';
import { runRelayLoop } from './relay';
import {
  ERASURE_RULES,
  HEADER_ERASED,
  namesErased,
  ReplayErasureUnsupported,
  replayOutbox,
  type ReplayContract,
} from './replay';

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

/** The local mock of #696: order.placed@2 = v1 with email_hash nullable; everything else is the real contract. */
const real = createValidator();
const mockV2: ReplayContract = {
  has: (topic, version) =>
    (topic === 'order.placed' && version === 2) || `${topic}@${version}` in EVENT_SCHEMAS,
  validateEnvelope: (e) => {
    const env = e as EventEnvelope;
    if (env.topic !== 'order.placed' || env.version !== 2) return real.validateEnvelope(e);
    const p = env.payload as Record<string, unknown>;
    return real.validateEnvelope({
      ...env,
      version: 1,
      payload: { ...p, email_hash: p.email_hash ?? '0'.repeat(64) },
    });
  },
};

const orderPlaced = (storeId: string, customerId: string | null, emailHash: string) => {
  const orderId = uuid();
  return buildEvent({
    organizationId: ORG,
    storeId,
    aggregateType: 'order',
    aggregateId: orderId,
    topic: 'order.placed',
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
      sent.flatMap((s) =>
        s.messages.map((m) => ({
          headers: m.headers,
          envelope: JSON.parse(m.value) as EventEnvelope,
        })),
      ),
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
    await orderPlaced(storeA, X, HX), // X's own order: scrubbed
    await orderPlaced(storeA, null, HX), // X's guest order before registering: scrubbed by the hash
    await orderPlaced(storeA, Y, HY), // Y stays
    await orderPlaced(storeB, null, HX), // the same person in another store, not erased there
    await cartAbandoned(storeA, X, HX), // skipped
    await cartAbandoned(storeA, Y, HY),
    await buildEvent({
      organizationId: ORG,
      storeId: storeA,
      aggregateType: 'customer',
      aggregateId: X,
      topic: 'customer.erased',
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
  it('covers every schema that names a customer (customer_id, *_customer_id or email_hash), except customer.erased', () => {
    const naming = Object.entries(EVENT_SCHEMAS)
      .filter(([, s]) =>
        Object.keys((s as { properties?: object }).properties ?? {}).some((k) =>
          /(^|_)customer_id$|^email_hash$/.test(k),
        ),
      )
      .map(([key]) => key.split('@')[0]!);
    const topics = [...new Set(naming)].filter((t) => t !== 'customer.erased').sort();
    expect(Object.keys(ERASURE_RULES).sort()).toEqual(topics);
    for (const t of Object.keys(ERASURE_RULES)) expect(EVENT_TOPICS).toContain(t);
    // only order.placed is scrubbed (the ledger needs it); the rest are skipped
    expect(
      Object.entries(ERASURE_RULES)
        .filter(([, r]) => r.action === 'scrub')
        .map(([t]) => t),
    ).toEqual(['order.placed']);
  });

  it('matches per store, by customer id or e-mail hash, and every referral party', () => {
    const erased = {
      customers: 1,
      keys: new Set([`s1|c:${X}`, `s1|h:${HX}`]),
    };
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
  });
});

describe('replayOutbox with an erased customer (database, recording publisher)', () => {
  it('scrubs the erased customer’s order.placed in that store only, as @2 with the erased header', async () => {
    const r = recorder();
    const summary = await replayOutbox(hq, r.publisher, {
      organizationId: ORG,
      topic: 'order.placed',
      contract: mockV2,
      log: quiet,
    });
    expect(summary).toMatchObject({
      rows: 4,
      published: 4,
      erased_customers: 1,
      erased_scrubbed: 2,
      erased_skipped: 0,
    });
    const out = r.envelopes();
    expect(out).toHaveLength(4);
    const scrubbed = out.filter((o) => o.headers[HEADER_ERASED] === '1');
    expect(scrubbed).toHaveLength(2);
    for (const o of scrubbed) {
      expect(o.envelope).toMatchObject({ topic: 'order.placed', version: 2, store_id: storeA });
      expect(o.envelope.payload).toMatchObject({ customer_id: null, email_hash: null });
      expect(o.headers.version).toBe('2');
    }
    const kept = out.filter((o) => o.headers[HEADER_ERASED] === undefined);
    expect(kept.map((o) => [o.envelope.store_id, o.envelope.version])).toEqual([
      [storeA, 1],
      [storeB, 1],
    ]);
    expect(kept.map((o) => (o.envelope.payload as { email_hash: string }).email_hash)).toEqual([
      HY,
      HX,
    ]);
    // nothing on the wire carries the erased customer's id or their hash in store A
    const wire = r.sent.flatMap((s) => s.messages.map((m) => m.value));
    expect(wire.filter((v) => v.includes(X))).toEqual([]);
    expect(wire.filter((v) => v.includes(HX) && v.includes(storeA))).toEqual([]);
  });

  it('refuses before sending a batch with such a row while @platform/events has no order.placed@2 (#696)', async () => {
    const r = recorder();
    const run = replayOutbox(hq, r.publisher, {
      organizationId: ORG,
      topic: 'order.placed',
      log: quiet,
    });
    if ('order.placed@2' in EVENT_SCHEMAS) {
      // #696 has landed: the real contract carries the scrubbed row
      await expect(run).resolves.toMatchObject({ erased_scrubbed: 2 });
      return;
    }
    await expect(run).rejects.toBeInstanceOf(ReplayErasureUnsupported);
    await expect(
      replayOutbox(hq, r.publisher, { organizationId: ORG, topic: 'order.placed', log: quiet }),
    ).rejects.toThrow(
      /stopped \(0 row\(s\) sent in 0 batch\(es\), last_seq 0; this batch sent nothing\): .*order\.placed@2 \(#696\)/,
    );
    expect(r.sent).toEqual([]);
    // a store without erased customers replays as before
    await expect(
      replayOutbox(hq, r.publisher, {
        organizationId: ORG,
        topic: 'order.placed',
        storeId: storeB,
        log: quiet,
      }),
    ).resolves.toMatchObject({ published: 1, erased_customers: 0, erased_scrubbed: 0 });
  });

  it('skips the erased customer’s cart.abandoned, sends customer.erased whole, and the dry run counts the erased', async () => {
    const carts = recorder();
    expect(
      await replayOutbox(hq, carts.publisher, {
        organizationId: ORG,
        topic: 'cart.abandoned',
        log: quiet,
      }),
    ).toMatchObject({ rows: 2, published: 1, erased_skipped: 1, erased_scrubbed: 0 });
    expect(
      carts.envelopes().map((o) => (o.envelope.payload as { customer_id: string }).customer_id),
    ).toEqual([Y]);

    const erasures = recorder();
    expect(
      await replayOutbox(hq, erasures.publisher, {
        organizationId: ORG,
        topic: 'customer.erased',
        log: quiet,
      }),
    ).toMatchObject({ published: 1, erased_customers: 0, erased_skipped: 0 });
    expect(erasures.envelopes()[0]!.envelope.payload).toMatchObject({
      customer_id: X,
      email_hash: HX,
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
    expect(summary).toMatchObject({ rows: 2, published: 1, batches: 2, erased_skipped: 1 });
    expect(r.sent).toHaveLength(1);
  });
});
