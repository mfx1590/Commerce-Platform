// The ledger consumer against the local Redpanda on prefixed topics and a prefixed group (self-cleaning; skipped with
// a printed reason when the broker is down) over a seeded throwaway database: every event once, a redelivered
// outbox_id writes nothing, an unknown version is skipped, a poison message dead-letters with its class and the
// stream continues, and no log line carries anything but ids, counts and classes.
import net from 'node:net';
import {
  brokersFromEnv,
  createKafka,
  createKafkaPublisher,
  dlqTopicName,
  ensureTopics,
  envelopeToMessage,
  planTopics,
  readDeadLetters,
  type EventConsumer,
  type EventEnvelopeV1Base,
  type TopicPolicy,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLedgerConsumer, LEDGER_GROUP, PROCESSED_TABLE } from '../src/consumer.js';
import type { Logger } from '../src/log.js';
import { LEDGER_TOPICS } from '../src/posting/index.js';
import {
  allItems,
  orderPlaced,
  paymentCaptured,
  shipmentShipped,
} from '../src/posting/fixtures.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

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
if (brokerDown)
  console.warn(`consumer-live.test: broker ${brokerDown} — live block skipped (pnpm compose:up)`);

describe.runIf(brokerDown === null)(
  'ledger consumer on the local Redpanda (prefixed, self-cleaning)',
  () => {
    const prefix = `acct-${Math.random().toString(36).slice(2, 8)}.`;
    const groupId = `${prefix}${LEDGER_GROUP}`;
    const kafka = createKafka({ clientId: 'accounting-live-test' });
    const publisher = createKafkaPublisher(kafka, { retries: 1 });
    const policy: TopicPolicy = {
      environments: { t: { partitions: 1, replication: 1 } },
      retention: { forever: ['order.', 'payment.', 'refund.', 'shipment.'], days_30: [] },
      dlq: { prefix: 'dlq.', consumer_groups: [] },
    };
    const LOG_LINES: string[] = [];
    const log: Logger = {
      info: (l) => LOG_LINES.push(JSON.stringify(l)),
      warn: (l) => LOG_LINES.push(JSON.stringify(l)),
      error: (l) => LOG_LINES.push(JSON.stringify(l)),
    };
    let t: AccountingTestDatabase;
    let consumer: EventConsumer;

    const publish = (...events: EventEnvelopeV1Base[]) =>
      Promise.all(
        [...new Set(events.map((e) => e.topic))].map((topic) =>
          publisher.send(
            `${prefix}${topic}`,
            events
              .filter((e) => e.topic === topic)
              .map((e) => envelopeToMessage(e, 'accounting-live-test')),
          ),
        ),
      );
    const until = async (cond: () => boolean, what: string, ms = 30_000) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms)
          throw new Error(`timed out waiting for ${what}: ${JSON.stringify(consumer.stats)}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const count = async (sql: string, params: unknown[] = []) =>
      Number(
        (await t.hq.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!
          .n,
      );

    beforeAll(async () => {
      t = await createAccountingTestDatabase();
      const admin = kafka.admin();
      await admin.connect();
      await ensureTopics(
        admin,
        planTopics(policy, { environment: 't', prefix, topics: [...LEDGER_TOPICS] }),
      );
      await admin.disconnect();
      await publisher.connect();
      consumer = createLedgerConsumer({
        client: t.hq,
        kafka,
        topicPrefix: prefix,
        groupId,
        fromBeginning: true,
        retries: 3,
        sleep: async () => {},
        log,
      });
      await consumer.start();
    }, 180_000);

    afterAll(async () => {
      await consumer?.stop();
      await publisher.disconnect().catch(() => {});
      const admin = kafka.admin();
      await admin.connect();
      try {
        const mine = (await admin.listTopics()).filter((x) => x.startsWith(prefix));
        if (mine.length) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
        const groups = (await admin.listGroups()).groups
          .map((g) => g.groupId)
          .filter((g) => g.startsWith(prefix));
        if (groups.length) await admin.deleteGroups(groups).catch(() => {});
        console.info(
          `consumer-live.test: deleted ${mine.length} topic(s) and ${groups.length} group(s) with prefix ${prefix}`,
        );
      } finally {
        await admin.disconnect();
      }
      await t?.drop();
    }, 120_000);

    it('posts each event once; a redelivery of the same outbox_id writes nothing', async () => {
      const placed = orderPlaced({
        lines: [{ quantity: 2, unit_price_minor: 4_999, tax_rate_bp: 2100 }],
        shipping_minor: 495,
        shipping_tax_minor: 104,
      });
      const pay = paymentCaptured(placed, { fee_minor: 300 });
      await publish(placed, pay);
      await until(() => consumer.stats.handled >= 2, 'the order and the payment');
      const ship = shipmentShipped(placed, allItems(placed), { cost_minor: 450 });
      await publish(ship, placed, pay); // the relay republished both after a crash
      await until(
        () => consumer.stats.handled + consumer.stats.duplicates >= 5,
        'the shipment and two duplicates',
      );
      expect(consumer.stats).toMatchObject({
        handled: 3,
        duplicates: 2,
        dead_lettered: 0,
        skipped_unknown: 0,
      });
      expect(await count('ledger_entry WHERE source_event_id = $1', [placed.event_id])).toBe(4);
      expect(await count('ledger_entry WHERE source_event_id = $1', [pay.event_id])).toBe(3);
      expect(await count('ledger_entry WHERE source_event_id = $1', [ship.event_id])).toBe(6);
      expect(await count(`${PROCESSED_TABLE} WHERE group_id = $1`, [groupId])).toBe(3);
      expect(consumer.dlqTopic).toBe(`${prefix}${dlqTopicName(groupId)}`);
    }, 60_000);

    it('an unknown version is skipped and logged, never a crash, nothing written', async () => {
      const placed = orderPlaced({
        lines: [{ quantity: 1, unit_price_minor: 1_000, tax_rate_bp: 0 }],
      });
      await publish({ ...placed, version: 99 });
      await until(() => consumer.stats.skipped_unknown >= 1, 'the skip');
      expect(await count('ledger_entry WHERE source_event_id = $1', [placed.event_id])).toBe(0);
      expect(
        LOG_LINES.some(
          (l) => l.includes('"event":"sdk.skipped_unknown"') && l.includes(placed.event_id),
        ),
      ).toBe(true);
    }, 60_000);

    it('a shipment that arrives before its order is parked, then applied when the order arrives', async () => {
      const placed = orderPlaced({
        lines: [{ quantity: 1, unit_price_minor: 2_000, tax_rate_bp: 2100 }],
        shipping_minor: 495,
        shipping_tax_minor: 104,
      });
      const early = shipmentShipped(placed, allItems(placed), { cost_minor: 310 });
      const before = consumer.stats.handled;
      await publish(early);
      await until(() => consumer.stats.handled >= before + 1, 'the parked shipment');
      expect(
        await count('accounting_parked_event WHERE order_id = $1', [placed.payload.order_id]),
      ).toBe(1);
      expect(await count('ledger_entry WHERE source_event_id = $1', [early.event_id])).toBe(0);
      await publish(placed);
      await until(() => consumer.stats.handled >= before + 2, 'the order');
      expect(
        await count('accounting_parked_event WHERE order_id = $1', [placed.payload.order_id]),
      ).toBe(0);
      expect(await count('ledger_entry WHERE source_event_id = $1', [placed.event_id])).toBe(4);
      expect(await count('ledger_entry WHERE source_event_id = $1', [early.event_id])).toBe(6);
      expect(
        LOG_LINES.some((l) => l.includes('"event":"parked"') && l.includes(early.event_id)),
      ).toBe(true);
      expect(
        LOG_LINES.some((l) => l.includes(placed.event_id) && l.includes('"applied_parked":1')),
      ).toBe(true);
      expect(consumer.stats.dead_lettered).toBe(0);
    }, 90_000);

    it('a genuinely bad event dead-letters after the retries with its class; the next event posts', async () => {
      const placed = orderPlaced({
        lines: [{ quantity: 1, unit_price_minor: 2_000, tax_rate_bp: 2100 }],
      });
      const lineId = placed.payload.line_items[0]!.order_line_item_id;
      const tooMany = shipmentShipped(placed, [{ order_line_item_id: lineId, quantity: 2 }]);
      const next = orderPlaced({
        lines: [{ quantity: 1, unit_price_minor: 3_000, tax_rate_bp: 2100 }],
      });
      const before = consumer.stats.handled;
      await publish(placed);
      await until(() => consumer.stats.handled >= before + 1, 'the order');
      await publish(tooMany);
      await until(() => consumer.stats.dead_lettered >= 1, 'the dead letter');
      await publish(next);
      await until(() => consumer.stats.handled >= before + 2, 'the next order');
      expect(consumer.stats.retries).toBeGreaterThanOrEqual(2);
      expect(await count('ledger_entry WHERE source_event_id = $1', [tooMany.event_id])).toBe(0);
      expect(await count('ledger_entry WHERE source_event_id = $1', [next.event_id])).toBe(3); // no shipping: 1200, 2200, 2300
      const letters = await readDeadLetters(groupId, { kafka, topicPrefix: prefix });
      expect(letters.map((d) => [d.outbox_id, d.error_class, d.event_topic])).toEqual([
        [tooMany.event_id, 'ShipmentExceedsOrder', 'shipment.shipped'],
      ]);
      expect(
        LOG_LINES.filter(
          (l) => l.includes('"event":"posting_failed"') && l.includes('ShipmentExceedsOrder'),
        ).length,
      ).toBe(3);
    }, 90_000);

    it('log lines carry ids, counts and classes only', () => {
      expect(LOG_LINES.length).toBeGreaterThan(5);
      for (const l of LOG_LINES) {
        expect(l).not.toMatch(/email|line_items|sku|title|@|payload/);
      }
    });
  },
);
