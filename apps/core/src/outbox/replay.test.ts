// The replay CLI and the 10,000-order replay test (#534). Database part always (throwaway database); the bus
// part skips itself with the reason when the local Redpanda is down (CI runs it in the live job).
//
// The 10k test: 10,000 orders over three stores = 30,000 outbox rows (order.placed, payment.authorized,
// order.confirmed) seeded through withEvents, drained by the relay into prefixed 3-partition topics, consumed by
// the SDK (every event once, per store and per topic in seq order), then order.placed replayed from the outbox
// (10,000 rows) and consumed again: the handler count stays, duplicates = 10,000. Durations are printed and
// bounded. REPLAY_TEST_ORDERS overrides the order count (default 10000).
import net from 'node:net';
import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import {
  brokersFromEnv,
  createConsumer,
  createKafka,
  createKafkaPublisher,
  createMemoryProcessedStore,
  ensureTopics,
  planTopics,
  type DecodedMessage,
  type EventEnvelope,
  type TopicPolicy,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore } from '../modules/registry';
import { buildEvent, withEvents } from './index';
import { runRelayLoop, type RelayPassResult } from './relay';
import { describeReplay, HEADER_REPLAY, replayOutbox } from './replay';
import { parseReplayArgs } from './replay-cli';

const ORG = '32000000-0000-4000-8000-000000000001';
const LE = '32000000-0000-4000-8000-000000000011';
const ORDERS = Number(process.env.REPLAY_TEST_ORDERS ?? 10_000);
const TOPICS = ['order.placed', 'payment.authorized', 'order.confirmed'] as const;
const quiet = () => {};

let db: TestDatabase;
let hq: ReturnType<typeof createOrganizationClient>;
const stores: string[] = [];
let brokerDown: string | null = 'not probed yet';

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

const uuid = () => crypto.randomUUID();
const HASH = 'b'.repeat(64);

/** The three events of one order, occurred_at strictly increasing with the order index. */
async function orderEvents(i: number, storeId: string, base: Date): Promise<EventEnvelope[]> {
  const orderId = uuid();
  const at = (ms: number) => new Date(base.getTime() + i * 3 + ms);
  const common = {
    organizationId: ORG,
    storeId,
    aggregateType: 'order' as const,
    aggregateId: orderId,
  };
  return [
    await buildEvent({
      ...common,
      topic: 'order.placed',
      occurredAt: at(0),
      payload: {
        order_id: orderId,
        display_id: i,
        legal_entity_id: LE,
        sales_channel_id: uuid(),
        customer_id: null,
        email_hash: HASH,
        currency: 'EUR',
        locale: 'en-GB',
        totals: {
          subtotal_minor: 1999,
          discount_minor: 0,
          shipping_minor: 499,
          tax_minor: 420,
          total_minor: 2918,
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
            tax_rate_bp: 2100,
            tax_minor: 420,
            total_minor: 2419,
          },
        ],
        shipping: {
          shipping_option_id: null,
          code: 'standard',
          name: 'Standard',
          carrier: 'manual',
          price_minor: 499,
        },
        shipping_country: 'NL',
        billing_country: 'NL',
        promotion_codes: [],
        placed_at: at(0).toISOString(),
      },
    }),
    await buildEvent({
      ...common,
      topic: 'payment.authorized',
      aggregateType: 'payment',
      aggregateId: uuid(),
      occurredAt: at(1),
      payload: {
        payment_id: uuid(),
        order_id: orderId,
        legal_entity_id: LE,
        provider: 'manual',
        provider_payment_id: null,
        amount_minor: 2918,
        currency: 'EUR',
        authorized_at: at(1).toISOString(),
      },
    }),
    await buildEvent({
      ...common,
      topic: 'order.confirmed',
      occurredAt: at(2),
      payload: { order_id: orderId, display_id: i, confirmed_at: at(2).toISOString() },
    }),
  ];
}

beforeAll(async () => {
  brokerDown = await probeBroker();
  if (brokerDown)
    console.warn(`replay.test: broker ${brokerDown} — bus part skipped (pnpm compose:up)`);
  db = await createTestDatabase('core_replay');
  const owner = createOrganizationClient(db.owner, { organizationId: ORG });
  await owner.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq-r', 'HQ R')`, [ORG]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le-r', 'LE R', 'NL', 'EUR')`,
      [LE, ORG],
    );
  });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  for (const code of ['brand-a', 'brand-b', 'brand-c']) {
    stores.push(
      (
        await createStore(hq, {
          legal_entity_id: LE,
          code,
          name: code,
          default_currency: 'EUR',
          default_locale: 'en-GB',
          default_country: 'NL',
        })
      ).id,
    );
  }
  // the fixtures' own store.created/updated rows: mark them published through a no-op so the counts below are exact
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
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe('replay-cli arguments', () => {
  it('parses the documented flags and refuses what it cannot use', () => {
    expect(parseReplayArgs(['--topic', 'order.placed'])).toEqual({
      topic: 'order.placed',
      dryRun: false,
      batchSize: 500,
      registry: true,
    });
    expect(
      parseReplayArgs([
        '--topic',
        'order.placed',
        '--from',
        '2026-10-01T00:00:00Z',
        '--to',
        '2026-10-02T00:00:00Z',
        '--store',
        stores[0]!,
        '--dry-run',
        '--batch',
        '50',
        '--no-registry',
      ]),
    ).toEqual({
      topic: 'order.placed',
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-02T00:00:00Z'),
      storeId: stores[0],
      dryRun: true,
      batchSize: 50,
      registry: false,
    });
    expect(() => parseReplayArgs([])).toThrow(/--topic/);
    expect(() => parseReplayArgs(['--topic', 'order.placed', '--from', 'yesterday'])).toThrow(
      /RFC-3339/,
    );
    expect(() => parseReplayArgs(['--topic', 'order.placed', '--batch', '0'])).toThrow(
      /positive integer/,
    );
    expect(() => parseReplayArgs(['--topic'])).toThrow(/needs a value/);
  });
});

describe('replayOutbox (database, recording publisher)', () => {
  it('replays only PUBLISHED rows of one topic in seq order, with the replay headers, and writes nothing to the outbox', async () => {
    const base = new Date('2026-10-01T00:00:00Z');
    const events = [
      ...(await orderEvents(1, stores[0]!, base)),
      ...(await orderEvents(2, stores[1]!, base)),
    ];
    await hq.transaction((tx) => withEvents(tx, events));
    // only one order gets published by "the relay"
    const sent: { topic: string; n: number; first: Record<string, string> }[] = [];
    const publisher = {
      send: async (topic: string, messages: { headers: Record<string, string> }[]) => {
        sent.push({ topic, n: messages.length, first: messages[0]!.headers });
      },
    };
    const unpublished = await replayOutbox(hq, publisher, {
      organizationId: ORG,
      topic: 'order.placed',
      log: quiet,
    });
    expect(unpublished).toMatchObject({ rows: 0, published: 0, batches: 0 }); // nothing published yet
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
    const before = (
      await hq.query<{ attempts: number; published_at: Date }>(
        'SELECT attempts, published_at FROM outbox WHERE topic = $1 ORDER BY seq',
        ['order.placed'],
      )
    ).rows;

    const r = await replayOutbox(hq, publisher, {
      organizationId: ORG,
      topic: 'order.placed',
      log: quiet,
      topicPrefix: 't.',
    });
    expect(r).toMatchObject({
      replay: 'outbox',
      topic: 'order.placed',
      dry_run: false,
      rows: 2,
      published: 2,
      batches: 1,
      per_store: { [stores[0]!]: 1, [stores[1]!]: 1 },
      oldest_occurred_at: new Date(base.getTime() + 3).toISOString(), // order index 1 → base + 3 ms
    });
    expect(sent).toEqual([
      {
        topic: 't.order.placed',
        n: 2,
        first: expect.objectContaining({
          [HEADER_REPLAY]: '1',
          outbox_id: events[0]!.event_id,
          producer: 'core-outbox-replay/1',
        }),
      },
    ]);
    expect(sent[0]!.first.replayed_at).toMatch(/T/);
    const after = (
      await hq.query<{ attempts: number; published_at: Date }>(
        'SELECT attempts, published_at FROM outbox WHERE topic = $1 ORDER BY seq',
        ['order.placed'],
      )
    ).rows;
    expect(after).toEqual(before); // untouched

    // filters: store, window, dry run
    expect(
      await describeReplay(hq, { organizationId: ORG, topic: 'order.placed', storeId: stores[1]! }),
    ).toMatchObject({ rows: 1, per_store: { [stores[1]!]: 1 } });
    expect(
      (
        await replayOutbox(hq, publisher, {
          organizationId: ORG,
          topic: 'order.placed',
          dryRun: true,
          from: new Date(base.getTime() + 4), // after order 1 (base + 3 ms)
          log: quiet,
        })
      ).rows,
    ).toBe(1);
    expect(
      (
        await replayOutbox(hq, publisher, {
          organizationId: ORG,
          topic: 'order.placed',
          dryRun: true,
          to: new Date(base.getTime() + 4), // before order 2 (base + 6 ms)
          log: quiet,
        })
      ).rows,
    ).toBe(1);
    expect(sent).toHaveLength(1); // dry runs sent nothing
    await expect(
      replayOutbox(hq, publisher, { organizationId: ORG, topic: 'invoice.issued', log: quiet }),
    ).rejects.toThrow(/unknown topic/);
    // a send that fails stops the replay with the resume point
    await expect(
      replayOutbox(
        hq,
        {
          send: async () => {
            throw new Error('down');
          },
        },
        { organizationId: ORG, topic: 'order.placed', log: quiet },
      ),
    ).rejects.toThrow(/stopped after 0 row\(s\) in 0 batch\(es\) \(last_seq 0\): Error/);
  });
});

describe('10,000 historical orders through the relay, a consumer and a replay (local Redpanda)', () => {
  const prefix = `t-${Math.random().toString(36).slice(2, 8)}.`;
  const kafka = createKafka({ clientId: 'core-replay-10k' });
  const publisher = createKafkaPublisher(kafka);
  const policy: TopicPolicy = {
    environments: { t: { partitions: 3, replication: 1 } },
    retention: { forever: ['order.', 'payment.'], days_30: [] },
    dlq: { prefix: 'dlq.', consumer_groups: [] },
  };

  afterAll(async () => {
    if (brokerDown) return;
    await publisher.disconnect().catch(() => {});
    const admin = kafka.admin();
    await admin.connect();
    try {
      const mine = (await admin.listTopics()).filter((t) => t.startsWith(prefix));
      if (mine.length) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
      console.info(`replay.test: deleted ${mine.length} test topic(s) with prefix ${prefix}`);
      expect((await admin.listTopics()).filter((t) => t.startsWith(prefix))).toEqual([]);
    } finally {
      await admin.disconnect();
    }
  }, 60_000);

  it(`replays ${ORDERS} orders: every event once per consumer, per store and per topic in order, then a replay dedupes`, async (ctx) => {
    if (brokerDown) return ctx.skip(`broker ${brokerDown}`);
    const t = { insert: 0, relay: 0, consume: 0, replay: 0, replay_consume: 0 };
    const mark = (k: keyof typeof t, from: number) => (t[k] = Date.now() - from);

    // 1. seed: ORDERS orders, 3 stores round robin, 3 events each, 167 orders (501 rows) per transaction
    let t0 = Date.now();
    const base = new Date('2026-09-01T00:00:00Z');
    const window = new Date(base.getTime() + ORDERS * 3); // this test's rows only (the first test left two orders)
    for (let start = 0; start < ORDERS; start += 167) {
      const batch: EventEnvelope[] = [];
      for (let i = start; i < Math.min(ORDERS, start + 167); i++)
        batch.push(...(await orderEvents(i, stores[i % 3]!, base)));
      await hq.transaction((tx) => withEvents(tx, batch));
    }
    mark('insert', t0);
    const rows = Number(
      (
        await hq.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM outbox WHERE published_at IS NULL',
        )
      ).rows[0]!.n,
    );
    expect(rows).toBe(ORDERS * 3);
    // the fixture itself: per store, the outbox holds order.placed in seq order = order index order
    for (const store of stores) {
      const ids = (
        await hq.query<{ d: string }>(
          "SELECT payload->>'display_id' AS d FROM outbox WHERE topic = 'order.placed' AND store_id = $1 AND occurred_at >= $2 AND occurred_at < $3 ORDER BY seq",
          [store, base, window],
        )
      ).rows.map((r) => Number(r.d));
      for (let i = 1; i < ids.length; i++) {
        if (ids[i]! < ids[i - 1]!)
          throw new Error(`seeded out of order for ${store}: ${ids.slice(0, 20).join(' ')}`);
      }
    }

    // 2. topics + consumer (started first, from the beginning)
    const admin = kafka.admin();
    await admin.connect();
    await ensureTopics(
      admin,
      planTopics(policy, { environment: 't', prefix, topics: [...TOPICS] }),
    );
    await admin.disconnect();
    await publisher.connect();
    const batches: string[] = [];
    const seen = new Map<string, string[]>(); // `${store}:${topic}` → `partition@occurred_at` in arrival order
    const consumer = createConsumer({
      groupId: 'tenk',
      topics: [...TOPICS],
      topicPrefix: prefix,
      kafka,
      processed: createMemoryProcessedStore(ORDERS * 4),
      log: quiet,
      onBatch: (b) =>
        batches.push(`${b.topic.slice(prefix.length)}/p${b.partition}[${b.first}..${b.last}]`),
      handler: async (m: DecodedMessage, c) => {
        const k = `${m.envelope.store_id}:${m.envelope.topic}`;
        seen.set(k, [...(seen.get(k) ?? []), `${c.partition}@${m.envelope.occurred_at}`]);
      },
    });
    await consumer.start();

    // 3. relay: drain the outbox into the prefixed topics
    t0 = Date.now();
    const controller = new AbortController();
    const passes: RelayPassResult[] = [];
    const totals = await runRelayLoop(hq, publisher, {
      organizationId: ORG,
      topicPrefix: prefix,
      batchSize: 500,
      intervalMs: 10,
      signal: controller.signal,
      log: (l) => {
        passes.push(l);
        if (l.batch === 0) controller.abort();
      },
    });
    mark('relay', t0);
    expect(totals).toMatchObject({ published: ORDERS * 3, failed: 0, failed_passes: 0 });
    expect(await hq.query('SELECT 1 FROM outbox WHERE published_at IS NULL')).toMatchObject({
      rowCount: 0,
    });

    // 4. consume: every event once
    t0 = Date.now();
    const deadline = Date.now() + 240_000;
    while (consumer.stats.handled < ORDERS * 3 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));
    mark('consume', t0);
    expect(consumer.stats).toMatchObject({
      handled: ORDERS * 3,
      duplicates: 0,
      dead_lettered: 0,
      skipped_unknown: 0,
    });
    expect(seen.size).toBe(3 * TOPICS.length);
    for (const [k, entries] of seen) {
      const storeIdx = stores.indexOf(k.split(':')[0]!);
      const expected = Array.from({ length: ORDERS }, (_, i) => i).filter(
        (i) => i % 3 === storeIdx,
      ).length;
      expect(entries.length, k).toBe(expected);
      const partitions = new Set(entries.map((e) => e.split('@')[0]));
      expect(partitions.size, `one partition for ${k}`).toBe(1);
      const times = entries.map((e) => e.split('@')[1]!);
      for (let i = 1; i < times.length; i++) {
        if (times[i]! < times[i - 1]!) {
          const idx = (t: string) => Math.round((new Date(t).getTime() - base.getTime()) / 3);
          throw new Error(
            `${k}: out of order at ${i} (order ${idx(times[i - 1]!)} then ${idx(times[i]!)}); first 20 arrivals: ${times.slice(0, 20).map(idx).join(' ')}; batches: ${batches.slice(0, 40).join(' ')}`,
          );
        }
      }
    }

    // 5. replay order.placed from the outbox: the consumer sees ORDERS duplicates, handles nothing twice
    t0 = Date.now();
    const r = await replayOutbox(hq, publisher, {
      organizationId: ORG,
      topic: 'order.placed',
      topicPrefix: prefix,
      batchSize: 500,
      from: base,
      to: window,
      log: quiet,
    });
    mark('replay', t0);
    expect(r).toMatchObject({ rows: ORDERS, published: ORDERS, batches: Math.ceil(ORDERS / 500) });
    t0 = Date.now();
    const deadline2 = Date.now() + 120_000;
    while (consumer.stats.duplicates < ORDERS && Date.now() < deadline2)
      await new Promise((r2) => setTimeout(r2, 200));
    mark('replay_consume', t0);
    expect(consumer.stats).toMatchObject({
      handled: ORDERS * 3,
      duplicates: ORDERS,
      dead_lettered: 0,
    });
    await consumer.stop();

    console.info(
      JSON.stringify({
        test: 'replay-10k',
        orders: ORDERS,
        rows: ORDERS * 3,
        relay_passes: passes.length,
        ...Object.fromEntries(Object.entries(t).map(([k, v]) => [`${k}_ms`, v])),
      }),
    );
    // Ceilings only (the real assertions are the counts and the order above): each is at least 5× the local
    // median of three runs on 2026-10-21 (laptop, dev container) — insert 28 s → 150 s, relay 10.5 s → 60 s,
    // consume after the relay 0 s (it kept up) → 120 s, replay 2.6 s → 15 s, replay consumed 0.2 s → 120 s.
    // A bound that flakes on a slow runner reddens every PR; every duration is printed on every run instead.
    expect(t.insert).toBeLessThan(150_000);
    expect(t.relay).toBeLessThan(60_000);
    expect(t.consume).toBeLessThan(120_000);
    expect(t.replay).toBeLessThan(15_000);
    expect(t.replay_consume).toBeLessThan(120_000);
  }, 900_000);
});
