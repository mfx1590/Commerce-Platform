// The ops consumer: the decision path on a real database, then a live block against the local Redpanda.
//
// The database part builds its own throwaway database through @platform/db/testing, which applies every
// packages/db migration — `consumer_processed` among them since db 0.3.16 (migration 0202, PR #557, merged
// 2026-10-23). The `consumer_processed` block below asserts the guarantees this consumer depends on, from the
// consumer's side: packages/db has its own RLS tests for the table itself.
//
// The live block publishes schema-valid envelopes to PREFIXED topics with the real wire format and runs the
// real consumer, so the dedupe #553 asks for is proven against the broker rather than against a fake. It is
// skipped with a printed reason when the broker is down.

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
  dlqTopicName,
  ensureTopics,
  envelopeToMessage,
  makeEvent,
  planTopics,
  readDeadLetters,
  createValidator,
  type EventEnvelopeV1Base,
  type TopicPolicy,
} from '@platform/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Alert, EngagementLogLine } from '../types.js';
import type { AlertTransport } from '../transport/types.js';
import { TransportError } from '../transport/types.js';
import { createOpsConsumer, handleEvent, OPS_GROUP_ID, PROCESSED_TABLE } from './consumer.js';
import { createRateLimiter } from './rate-limit.js';
import { createStoreCodes } from './store-codes.js';

const ORG = SEED_IDS.organization;
const STORE_A = SEED_IDS.stores.brandA;
const STORE_B = SEED_IDS.stores.brandB;
const ORDER = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '22222222-2222-4222-8222-222222222222';

const validator = createValidator();

class RecordingTransport implements AlertTransport {
  readonly name = 'recording';
  readonly sent: Alert[] = [];
  failWith: Error | null = null;
  async send(alert: Alert): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(alert);
  }
}

function paymentFailedEvent(
  storeId: string = STORE_A,
  reason = 'insufficient_funds',
): EventEnvelopeV1Base {
  const e = makeEvent({
    topic: 'payment.failed',
    organizationId: ORG,
    storeId,
    aggregateType: 'payment',
    aggregateId: PAYMENT,
    payload: {
      payment_id: PAYMENT,
      order_id: ORDER,
      provider: 'stripe',
      provider_payment_id: 'pi-alpha',
      amount_minor: 10494,
      currency: 'EUR',
      failure_reason: reason,
      failed_at: '2026-10-23T10:00:00.000Z',
    } as never,
  });
  const check = validator.validateEnvelope(e);
  expect(check.ok, check.errors?.join('; ')).toBe(true);
  return e as EventEnvelopeV1Base;
}

let db: TestDatabase;
let hq: ScopedClient;

beforeAll(async () => {
  db = await createTestDatabase('platform_engagement');
  await seed(db.owner);
  hq = createOrganizationClient(db.app, { organizationId: ORG });
}, 120_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.owner.query(`DELETE FROM ${PROCESSED_TABLE}`);
});

describe('consumer_processed (the shared table, packages/db 0202)', () => {
  it('an organization-scoped client may insert and read its own marks', async () => {
    await hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
      OPS_GROUP_ID,
      ORDER,
    ]);
    const r = await hq.query(
      `SELECT organization_id, group_id, outbox_id FROM ${PROCESSED_TABLE} WHERE group_id = $1`,
      [OPS_GROUP_ID],
    );
    expect(r.rows).toHaveLength(1);
    // organization_id DEFAULTs to the session's organization, so the SDK's two-column INSERT is enough.
    expect(r.rows[0]!).toMatchObject({
      organization_id: ORG,
      group_id: OPS_GROUP_ID,
      outbox_id: ORDER,
    });
  });

  it('the pair (group, outbox id) is the replay guard', async () => {
    const insert = () =>
      hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
        OPS_GROUP_ID,
        ORDER,
      ]);
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i);
    // A different group marks the same event independently.
    await hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
      'engagement.cdp',
      ORDER,
    ]);
    const r = await hq.query(`SELECT count(*)::int AS n FROM ${PROCESSED_TABLE}`);
    expect((r.rows[0] as { n: number }).n).toBe(2);
  });

  it('a store-scoped session reads and writes none of it (RLS kind organization_only)', async () => {
    const store = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    await hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
      OPS_GROUP_ID,
      ORDER,
    ]);
    const r = await store.query(`SELECT * FROM ${PROCESSED_TABLE}`);
    expect(r.rows).toEqual([]);
    // This is exactly why the consumer must run an ORGANIZATION-scoped client.
    await expect(
      store.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
        OPS_GROUP_ID,
        PAYMENT,
      ]),
    ).rejects.toThrow();
  });

  it('a mark is never changed: UPDATE is revoked from the application role', async () => {
    await hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
      OPS_GROUP_ID,
      ORDER,
    ]);
    await expect(
      hq.query(`UPDATE ${PROCESSED_TABLE} SET processed_at = now() WHERE group_id = $1`, [
        OPS_GROUP_ID,
      ]),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('store codes', () => {
  it('resolves a seeded store id to its code, and caches it', async () => {
    const codes = createStoreCodes(hq);
    expect(await codes.codeFor(STORE_A)).toBe('brand-a');
    expect(await codes.codeFor(STORE_B)).toBe('brand-b');
    // Second call: from the cache (no assertion on query count — the value is what matters).
    expect(await codes.codeFor(STORE_A)).toBe('brand-a');
  });

  it('warms every store in one query', async () => {
    const codes = createStoreCodes(hq);
    await codes.warm();
    expect(await codes.codeFor(STORE_A)).toBe('brand-a');
  });

  it('an organization-scope event has no store', async () => {
    const codes = createStoreCodes(hq);
    expect(await codes.codeFor(null)).toBe('organization');
    expect(await codes.codeFor(undefined)).toBe('organization');
  });

  it('falls back to the uuid rather than dropping an alert for an unknown store', async () => {
    const codes = createStoreCodes(hq);
    const ghost = '99999999-9999-4999-8999-999999999999';
    expect(await codes.codeFor(ghost)).toBe(ghost);
  });
});

describe('the suppressed count is FLUSHED, not only carried forward (#657)', () => {
  // The wiring, not the limiter: #599 was wiring that nobody tested, so the consumer's own flush is proven
  // here — it sends through the transport and `stop()` calls it, because the in-memory window dies with the
  // process.
  const recordingTransport = () => {
    const sent: Alert[] = [];
    const transport: AlertTransport = {
      name: 'recording',
      async send(alert) {
        sent.push(alert);
      },
    };
    return { transport, sent };
  };

  const consumerWith = (limiter: ReturnType<typeof createRateLimiter>, t: AlertTransport) =>
    createOpsConsumer({
      hq,
      transport: t,
      rateLimit: { max: 1, windowMs: 60_000 },
      limiter,
      log: () => undefined,
    });

  it('sends one alert per key that had a suppressed count, then reports nothing', async () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
    const key = 'payment-failed:brand-a';
    limiter.check(key);
    limiter.check(key);
    limiter.check(key);

    const { transport, sent } = recordingTransport();
    const consumer = consumerWith(limiter, transport);
    expect(await consumer.flushSuppressed()).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.rule).toBe('payment-failed');
    expect(sent[0]!.storeCode).toBe('brand-a');
    expect(sent[0]!.suppressed).toBe(2);
    expect(sent[0]!.title).toContain('2 payment-failed alert(s) suppressed');
    // Cleared, so a timer does not repeat the same burst every tick.
    expect(await consumer.flushSuppressed()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('never throws when the transport fails: it runs on a timer and at shutdown', async () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => 0 });
    limiter.check('payment-failed:brand-a');
    limiter.check('payment-failed:brand-a');
    const failing: AlertTransport = {
      name: 'failing',
      async send() {
        throw new TransportError('slack refused', { retryable: false });
      },
    };
    const consumer = consumerWith(limiter, failing);
    await expect(consumer.flushSuppressed()).resolves.toBe(1);
  });

  it('reports a count that would otherwise die with the process', async () => {
    // The burst ends inside its window and the process stops: without the flush the count is simply lost.
    const limiter = createRateLimiter({ max: 1, windowMs: 900_000, now: () => 0 });
    limiter.check('refund-failed:brand-b');
    limiter.check('refund-failed:brand-b');
    const { transport, sent } = recordingTransport();
    const consumer = consumerWith(limiter, transport);
    // `stop()` would also stop the SDK consumer, which was never started here; the flush is what this pins.
    await consumer.flushSuppressed();
    expect(sent.map((a) => [a.rule, a.storeCode, a.suppressed])).toEqual([
      ['refund-failed', 'brand-b', 1],
    ]);
  });
});

describe('handleEvent (the decision path)', () => {
  it('sends one alert with the resolved store code', async () => {
    const transport = new RecordingTransport();
    const r = await handleEvent({
      envelope: paymentFailedEvent(),
      outboxId: ORDER,
      storeCodes: createStoreCodes(hq),
      limiter: createRateLimiter({ max: 5, windowMs: 60_000 }),
      transport,
    });
    expect(r.sent).toHaveLength(1);
    expect(transport.sent[0]!).toMatchObject({
      rule: 'payment-failed',
      storeCode: 'brand-a',
      outboxId: ORDER,
      suppressed: 0,
    });
    expect(transport.sent[0]!.fields.store).toBe('brand-a');
  });

  it('rate-limits per store: brand-a is muted while brand-b still alerts', async () => {
    const transport = new RecordingTransport();
    const codes = createStoreCodes(hq);
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
    const args = { storeCodes: codes, limiter, transport };

    await handleEvent({ ...args, envelope: paymentFailedEvent(STORE_A), outboxId: 'a1' });
    const second = await handleEvent({
      ...args,
      envelope: paymentFailedEvent(STORE_A),
      outboxId: 'a2',
    });
    const other = await handleEvent({
      ...args,
      envelope: paymentFailedEvent(STORE_B),
      outboxId: 'b1',
    });

    expect(second.sent).toHaveLength(0);
    expect(second.suppressed).toBe(1);
    expect(other.sent).toHaveLength(1);
    expect(transport.sent.map((a) => a.storeCode)).toEqual(['brand-a', 'brand-b']);
  });

  it('logs the send and the suppression, with ids and no alert fields', async () => {
    const lines: EngagementLogLine[] = [];
    const args = {
      storeCodes: createStoreCodes(hq),
      limiter: createRateLimiter({ max: 1, windowMs: 60_000 }),
      transport: new RecordingTransport(),
      log: (l: EngagementLogLine) => lines.push(l),
    };
    await handleEvent({ ...args, envelope: paymentFailedEvent(), outboxId: 'x1' });
    await handleEvent({ ...args, envelope: paymentFailedEvent(), outboxId: 'x2' });

    expect(lines.map((l) => l.event)).toEqual(['alert_sent', 'alert_suppressed']);
    expect(lines[0]!).toMatchObject({
      service: 'engagement',
      module: 'ops',
      rule: 'payment-failed',
      severity: 'warn',
      store_code: 'brand-a',
      outbox_id: 'x1',
    });
    // A log line never carries the alert's fields (amount, provider, reason).
    expect(JSON.stringify(lines)).not.toContain('insufficient_funds');
    expect(JSON.stringify(lines)).not.toContain('10494');
  });

  it('a transport refusal propagates, so the SDK retries and finally dead-letters', async () => {
    const transport = new RecordingTransport();
    transport.failWith = new TransportError('slack: HTTP 500');
    await expect(
      handleEvent({
        envelope: paymentFailedEvent(),
        outboxId: ORDER,
        storeCodes: createStoreCodes(hq),
        limiter: createRateLimiter({ max: 5, windowMs: 60_000 }),
        transport,
      }),
    ).rejects.toThrow('slack: HTTP 500');
  });
});

// ---- live -------------------------------------------------------------------------------------------------

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
  console.warn(`ops/consumer.test: broker ${brokerDown} — live block skipped (pnpm compose:up)`);
}

describe.runIf(brokerDown === null)(
  'ops consumer against the local Redpanda (prefixed, self-cleaning)',
  () => {
    const prefix = `t-eng-${Math.random().toString(36).slice(2, 8)}.`;
    const kafka = createKafka({ clientId: 'engagement-ops-test' });
    const publisher = createKafkaPublisher(kafka, { retries: 1 });
    const topics = ['payment.failed', 'refund.failed', 'return.requested'] as const;
    const policy: TopicPolicy = {
      environments: { t: { partitions: 2, replication: 1 } },
      retention: { forever: [], days_30: ['payment.', 'refund.', 'return.'] },
      dlq: { prefix: 'dlq.', consumer_groups: [] },
    };
    // Every test owns its consumer AND stops it before the next one starts. They all join the real group
    // `engagement.ops`, so two live members share the topic's partitions: a message published by a later test
    // could be delivered to an earlier test's consumer (whose transport behaves differently) and the
    // assertion would be testing the wrong object. `started` is only the afterAll safety net.
    const started: { stop(): Promise<void> }[] = [];
    const run = async (c: { stop(): Promise<void> }, body: () => Promise<void>) => {
      started.push(c);
      try {
        await body();
      } finally {
        await c.stop();
      }
    };

    const until = async (cond: () => boolean, ms = 20_000, what = 'condition') => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    beforeAll(async () => {
      const admin = kafka.admin();
      await admin.connect();
      await ensureTopics(
        admin,
        planTopics(policy, { environment: 't', prefix, topics: [...topics] }),
      );
      await admin.disconnect();
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
        console.info(`ops/consumer.test: deleted ${mine.length} topic(s) with prefix ${prefix}`);
        expect((await admin.listTopics()).filter((t) => t.startsWith(prefix))).toEqual([]);
      } finally {
        await admin.disconnect();
      }
    }, 60_000);

    // Each live test gets its OWN topics under the run's prefix, and stops its consumer before the next test
    // starts, so no two members of the group ever share a partition in here.
    const ensure = async (topicPrefix: string) => {
      const admin = kafka.admin();
      await admin.connect();
      try {
        await ensureTopics(
          admin,
          planTopics(policy, { environment: 't', prefix: topicPrefix, topics: [...topics] }),
        );
      } finally {
        await admin.disconnect();
      }
    };

    it('alerts once per event and sends NOTHING for a redelivery of the same outbox id', async () => {
      const transport = new RecordingTransport();
      const consumer = createOpsConsumer({
        hq,
        transport,
        rateLimit: { max: 100, windowMs: 60_000 },
        topicPrefix: prefix,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();

        const first = paymentFailedEvent(STORE_A, 'card_declined');
        const second = paymentFailedEvent(STORE_B, 'expired_card');
        // The third message is the relay republishing `first` after a crash: at-least-once on the wire.
        await publisher.send(
          `${prefix}payment.failed`,
          [first, second, first].map((e) => envelopeToMessage(e, 'test')),
        );

        await until(() => transport.sent.length >= 2, 30_000, 'two alerts');
        // Give the duplicate a chance to be (wrongly) handled before asserting it was not.
        await new Promise((r) => setTimeout(r, 1500));

        expect(transport.sent).toHaveLength(2);
        expect(transport.sent.map((a) => a.storeCode).sort()).toEqual(['brand-a', 'brand-b']);
        expect(transport.sent.map((a) => a.fields.reason).sort()).toEqual([
          'card_declined',
          'expired_card',
        ]);

        // One mark per (group, outbox id) in the shared table — and the duplicate added none.
        const marks = await hq.query(
          `SELECT outbox_id FROM ${PROCESSED_TABLE} WHERE group_id = $1`,
          [OPS_GROUP_ID],
        );
        expect(marks.rows).toHaveLength(2);
        expect((marks.rows as { outbox_id: string }[]).map((r) => r.outbox_id).sort()).toEqual(
          [first.event_id, second.event_id].sort(),
        );
        expect(consumer.dlqTopic).toBe(`${prefix}${dlqTopicName(OPS_GROUP_ID)}`);
      });
    }, 90_000);

    it('sends nothing for events already marked for this group, however it reaches them', async () => {
      // The dedupe guarantee on its own, with no committed offset in play: fresh topics (so the consumer
      // really does read these messages from the beginning) and the marks written in advance, as a consumer
      // that had already finished them would have left them. This is what makes a replay or a rebuilt
      // consumer silent — distinct from an offset simply never being re-read.
      const replayPrefix = `${prefix}replay.`;
      await ensure(replayPrefix);

      const done = paymentFailedEvent(STORE_A, 'card_declined');
      const fresh = paymentFailedEvent(STORE_B, 'expired_card');
      await hq.query(`INSERT INTO ${PROCESSED_TABLE} (group_id, outbox_id) VALUES ($1, $2)`, [
        OPS_GROUP_ID,
        done.event_id,
      ]);

      const transport = new RecordingTransport();
      const consumer = createOpsConsumer({
        hq,
        transport,
        rateLimit: { max: 100, windowMs: 60_000 },
        topicPrefix: replayPrefix,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();
        await publisher.send(
          `${replayPrefix}payment.failed`,
          [done, fresh].map((e) => envelopeToMessage(e, 'test')),
        );
        // The unmarked one proves the consumer really is reading this topic.
        await until(() => transport.sent.length >= 1, 30_000, 'the unmarked alert');
        await new Promise((r) => setTimeout(r, 1500));

        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]!.outboxId).toBe(fresh.event_id);
        expect(transport.sent[0]!.storeCode).toBe('brand-b');
      });
    }, 90_000);

    it('a transport that keeps refusing dead-letters the message, with the error class and no payload', async () => {
      // Its own topics as well: this consumer's transport refuses everything, and a message of this test
      // reaching another test's consumer (or the reverse) would prove nothing.
      const deadPrefix = `${prefix}dead.`;
      await ensure(deadPrefix);

      const transport = new RecordingTransport();
      transport.failWith = new TransportError('slack: HTTP 500');
      const consumer = createOpsConsumer({
        hq,
        transport,
        rateLimit: { max: 100, windowMs: 60_000 },
        topicPrefix: deadPrefix,
        retries: 2,
        fromBeginning: true,
      });
      await run(consumer, async () => {
        await consumer.start();

        const event = paymentFailedEvent(STORE_A, 'processing_error');
        await publisher.send(`${deadPrefix}payment.failed`, [envelopeToMessage(event, 'test')]);

        // The DLQ is read, not watched: poll it until the entry shows up (or give up with a clear message).
        const deadline = Date.now() + 40_000;
        let entry: Awaited<ReturnType<typeof readDeadLetters>>[number] | undefined;
        while (!entry && Date.now() < deadline) {
          const dead = await readDeadLetters(OPS_GROUP_ID, { kafka, topicPrefix: deadPrefix });
          entry = dead.find((d) => d.outbox_id === event.event_id);
          if (!entry) await new Promise((r) => setTimeout(r, 1000));
        }
        expect(entry, 'the message was not dead-lettered within 40 s').toBeDefined();
        expect(entry).toMatchObject({
          group_id: OPS_GROUP_ID,
          event_topic: 'payment.failed',
          event_version: 1,
          error_class: 'TransportError',
        });
        // The DLQ record carries no payload: nothing of the event's content is in it.
        expect(JSON.stringify(entry)).not.toContain('processing_error');
        expect(transport.sent).toEqual([]);
        // Nothing was marked: the handler never succeeded.
        const marks = await hq.query(
          `SELECT 1 FROM ${PROCESSED_TABLE} WHERE group_id = $1 AND outbox_id = $2`,
          [OPS_GROUP_ID, event.event_id],
        );
        expect(marks.rows).toEqual([]);
      });
    }, 120_000);
  },
);
