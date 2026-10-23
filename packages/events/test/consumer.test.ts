// Consumer SDK + DLQ (#533): the processed stores (pure) and the live block against the local Redpanda on
// prefixed topics and groups (self-cleaning; skipped with a printed reason when the broker is down).
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  brokersFromEnv,
  createConsumer,
  createKafka,
  createKafkaPublisher,
  createMemoryProcessedStore,
  createPgProcessedStore,
  dlqTopicName,
  ensureTopics,
  envelopeToMessage,
  makeEvent,
  planTopics,
  readDeadLetters,
  readTopicToEnd,
  replayFromDlq,
  type ConsumerLogLine,
  type DecodedMessage,
  type DeadLetter,
  type EventConsumer,
  type TopicPolicy,
  type TopicReaderClient,
} from '../src/index.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = '00000000-0000-4000-8000-000000000031';

describe('processed stores', () => {
  it('memory store: has/mark, bounded, oldest out first', async () => {
    const s = createMemoryProcessedStore(2);
    expect(await s.has('g', 'a')).toBe(false);
    await s.markProcessed('g', 'a');
    await s.markProcessed('g', 'b');
    expect(await s.has('g', 'a')).toBe(true);
    expect(await s.has('other', 'a')).toBe(false);
    await s.markProcessed('g', 'c');
    expect(await s.has('g', 'a')).toBe(false); // evicted
    expect(await s.has('g', 'c')).toBe(true);
  });

  it('pg store: parameterised queries on the consumer-owned table, name validated', async () => {
    const calls: { text: string; params: unknown[] | undefined }[] = [];
    const db = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        return { rows: text.startsWith('SELECT') && params?.[1] === 'known' ? [1] : [] };
      },
    };
    const s = createPgProcessedStore(db, 'billing_processed');
    expect(await s.has('g', 'known')).toBe(true);
    expect(await s.has('g', 'new')).toBe(false);
    await s.markProcessed('g', 'new');
    expect(calls.map((c) => c.text)).toEqual([
      'SELECT 1 FROM billing_processed WHERE group_id = $1 AND outbox_id = $2',
      'SELECT 1 FROM billing_processed WHERE group_id = $1 AND outbox_id = $2',
      'INSERT INTO billing_processed (group_id, outbox_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    ]);
    expect(calls[2]!.params).toEqual(['g', 'new']);
    expect(() => createPgProcessedStore(db, 'bad;drop')).toThrow(/invalid processed table name/);
  });
});

describe('readTopicToEnd on a compacted topic (fake client)', () => {
  const fakeClient = (
    offsetsByPartition: Record<number, string[]>,
    highs: Record<number, [string, string]>,
  ) => {
    const client: TopicReaderClient = {
      admin: () => ({
        connect: async () => {},
        disconnect: async () => {},
        fetchTopicOffsets: async () =>
          Object.entries(highs).map(([p, [low, high]]) => ({ partition: Number(p), low, high })),
      }),
      consumer: () => ({
        connect: async () => {},
        disconnect: async () => {},
        subscribe: async () => {},
        run: async ({ eachMessage }) => {
          for (const [p, offsets] of Object.entries(offsetsByPartition)) {
            for (const offset of offsets) {
              await eachMessage({
                partition: Number(p),
                message: {
                  key: Buffer.from('k'),
                  value: Buffer.from(offset),
                  headers: {},
                  offset,
                  timestamp: '0',
                  attributes: 0,
                },
              });
            }
          }
          await new Promise(() => {}); // a real consumer never returns from run(); the reader must resolve on its own
        },
      }),
    };
    return client;
  };

  it('finishes when every non-empty partition reached high − 1, even with compaction gaps; an empty partition needs nothing', async () => {
    const read = await readTopicToEnd(
      fakeClient({ 0: ['0', '1', '4'], 1: [] }, { 0: ['0', '5'], 1: ['3', '3'] }),
      'dlq.x',
      'g',
      2_000,
    );
    expect(read.map((m) => m.offset)).toEqual(['0', '1', '4']); // 3 of an upper bound of 5
  });

  it('an empty topic reads nothing without subscribing', async () => {
    const read = await readTopicToEnd(fakeClient({}, { 0: ['7', '7'] }), 'dlq.x', 'g', 2_000);
    expect(read).toEqual([]);
  });

  it('a partition whose last record was compacted away (high − 1 never arrives) is done after idleMs of silence', async () => {
    const started = Date.now();
    const read = await readTopicToEnd(
      fakeClient({ 0: ['0', '1'] }, { 0: ['0', '5'] }),
      'dlq.x',
      'g',
      5_000,
      200,
    );
    expect(read.map((m) => m.offset)).toEqual(['0', '1']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('times out naming a partition that never delivered anything', async () => {
    await expect(
      readTopicToEnd(
        fakeClient({ 1: ['0'] }, { 0: ['0', '5'], 1: ['0', '1'] }),
        'dlq.x',
        'g',
        400,
        100,
      ),
    ).rejects.toThrow(/partition\(s\) still short of their high watermark: 0/);
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
if (brokerDown)
  console.warn(`consumer.test: broker ${brokerDown} — live block skipped (pnpm compose:up)`);

describe.runIf(brokerDown === null)(
  'consumer SDK against the local Redpanda (prefixed, self-cleaning)',
  () => {
    const prefix = `t-${Math.random().toString(36).slice(2, 8)}.`;
    const kafka = createKafka({ clientId: 'consumer-test' });
    const publisher = createKafkaPublisher(kafka, { retries: 1 });
    const topic = 'store.updated';
    const wire = `${prefix}${topic}`;
    const policy: TopicPolicy = {
      environments: { t: { partitions: 2, replication: 1 } },
      retention: { forever: [], days_30: ['store.'] },
      dlq: { prefix: 'dlq.', consumer_groups: [] },
    };
    const consumers: EventConsumer[] = [];
    const quiet = () => {};
    const noWait = async () => {};

    const event = (tag: string, version = 1) => {
      const e = makeEvent({
        topic,
        organizationId: ORG,
        storeId: STORE,
        aggregateType: 'store',
        aggregateId: STORE,
        payload: { store_id: STORE, code: 'x', status: 'draft', changed_fields: [tag] },
      });
      return { ...e, version };
    };
    const tagOf = (m: DecodedMessage) =>
      (m.envelope.payload as { changed_fields: string[] }).changed_fields[0]!;
    const publish = async (...events: ReturnType<typeof event>[]) =>
      publisher.send(
        wire,
        events.map((e) => envelopeToMessage(e, 'test')),
      );
    const until = async (cond: () => boolean, ms = 20_000, what = 'condition') => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const track = (c: EventConsumer) => (consumers.push(c), c);

    beforeAll(async () => {
      const admin = kafka.admin();
      await admin.connect();
      await ensureTopics(admin, planTopics(policy, { environment: 't', prefix, topics: [topic] }));
      await admin.disconnect();
      await publisher.connect();
    }, 60_000);

    afterAll(async () => {
      for (const c of consumers) await c.stop();
      await publisher.disconnect().catch(() => {});
      const admin = kafka.admin();
      await admin.connect();
      try {
        const mine = (await admin.listTopics()).filter((t) => t.startsWith(prefix));
        if (mine.length) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
        const groups = (await admin.listGroups()).groups
          .map((g) => g.groupId)
          .filter((g) => g.startsWith(prefix));
        if (groups.length) await admin.deleteGroups(groups).catch(() => {});
        console.info(
          `consumer.test: deleted ${mine.length} topic(s) and ${groups.length} group(s) with prefix ${prefix}`,
        );
        expect((await admin.listTopics()).filter((t) => t.startsWith(prefix))).toEqual([]);
      } finally {
        await admin.disconnect();
      }
    }, 60_000);

    it('handles each message once, dedupes a duplicate delivery of the same outbox_id, commits after the handler', async () => {
      const seen: string[] = [];
      const e1 = event('one');
      const e2 = event('two');
      const c = track(
        createConsumer({
          groupId: 'once',
          topics: [topic],
          topicPrefix: prefix,
          kafka,
          fromBeginning: true,
          log: quiet,
          sleep: noWait,
          handler: async (m) => {
            seen.push(tagOf(m));
          },
        }),
      );
      await c.start();
      await publish(e1, e2, e1); // the relay republished e1 after a crash
      await until(() => c.stats.handled + c.stats.duplicates >= 3, 20_000, '3 deliveries');
      expect(seen).toEqual(['one', 'two']);
      expect(c.stats).toMatchObject({ handled: 2, duplicates: 1, dead_lettered: 0 });
      expect(c.dlqTopic).toBe(`${prefix}${dlqTopicName('once')}`);
    }, 60_000);

    it('a poison message lands in the DLQ after N tries with the error class, and the next messages continue', async () => {
      const seen: string[] = [];
      const lines: ConsumerLogLine[] = [];
      const c = track(
        createConsumer({
          groupId: 'poison',
          topics: [topic],
          topicPrefix: prefix,
          kafka,
          fromBeginning: false,
          retries: 3,
          log: (l) => lines.push(l),
          sleep: noWait,
          handler: async (m) => {
            if (tagOf(m) === 'bad') {
              const e = new Error('boom');
              e.name = 'HandlerFailed';
              throw e;
            }
            seen.push(tagOf(m));
          },
        }),
      );
      await c.start();
      await new Promise((r) => setTimeout(r, 1_500)); // the group joins and settles on the end of the topic
      const bad = event('bad');
      await publish(event('before'), bad, event('after'));
      await until(() => seen.includes('after'), 20_000, 'the message after the poison one');
      expect(seen).toEqual(['before', 'after']);
      expect(c.stats).toMatchObject({ handled: 2, retries: 2, dead_lettered: 1 });
      expect(lines.filter((l) => l.event === 'retry').map((l) => l.attempt)).toEqual([1, 2]);
      expect(lines.find((l) => l.event === 'dead_lettered')).toMatchObject({
        outbox_id: bad.event_id,
        attempt: 3,
        error_class: 'HandlerFailed',
        event_topic: topic,
        event_version: 1,
      });

      const dead = await readDeadLetters('poison', { kafka, topicPrefix: prefix });
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({
        outbox_id: bad.event_id,
        group_id: 'poison',
        topic: wire,
        event_topic: topic,
        attempts: 3,
        error_class: 'HandlerFailed',
      });
      expect(JSON.stringify(dead[0])).not.toContain('changed_fields'); // no payload in the DLQ
    }, 60_000);

    it('an unknown version is logged and skipped, never a crash; the consumer keeps going', async () => {
      const seen: string[] = [];
      const lines: ConsumerLogLine[] = [];
      const c = track(
        createConsumer({
          groupId: 'unknown',
          topics: [topic],
          topicPrefix: prefix,
          kafka,
          fromBeginning: false,
          log: (l) => lines.push(l),
          sleep: noWait,
          handler: async (m) => {
            seen.push(tagOf(m));
          },
        }),
      );
      await c.start();
      await new Promise((r) => setTimeout(r, 1_500));
      await publish(event('future', 9), event('now'));
      await until(() => seen.includes('now'), 20_000, 'the known message');
      expect(c.stats).toMatchObject({ handled: 1, skipped_unknown: 1 });
      expect(lines.find((l) => l.event === 'skipped_unknown')).toMatchObject({
        event_topic: topic,
        event_version: 9,
      });
    }, 60_000);

    it('a crash before the commit redelivers the message; the processed store makes the second delivery a no-op', async () => {
      // its own topic (under the test prefix, so the teardown removes it): both consumers read from the
      // beginning, as a real group that never committed does on restart (the SDK default)
      const crashPrefix = `${prefix}crash.`;
      const admin = kafka.admin();
      await admin.connect();
      await ensureTopics(
        admin,
        planTopics(policy, { environment: 't', prefix: crashPrefix, topics: [topic] }),
      );
      await admin.disconnect();
      const processed = createMemoryProcessedStore(); // stands in for the durable store the restarted process reads
      const seen: string[] = [];
      let crashes = 0;
      const first = track(
        createConsumer({
          groupId: 'crash',
          topics: [topic],
          topicPrefix: crashPrefix,
          kafka,
          processed,
          log: quiet,
          sleep: noWait,
          handler: async (m) => {
            seen.push(tagOf(m));
          },
          onBeforeCommit: () => {
            crashes += 1;
            throw new Error('process died before the commit');
          },
        }),
      );
      await first.start();
      await publisher.send(`${crashPrefix}${topic}`, [envelopeToMessage(event('fragile'), 'test')]);
      await until(() => crashes === 1, 20_000, 'the simulated crash');
      await until(() => first.stats.handled === 1, 5_000, 'the handler before the crash');
      await first.stop();

      const second = track(
        createConsumer({
          groupId: 'crash',
          topics: [topic],
          topicPrefix: crashPrefix,
          kafka,
          processed,
          log: quiet,
          sleep: noWait,
          handler: async (m) => {
            seen.push(tagOf(m));
          },
        }),
      );
      await second.start();
      await until(() => second.stats.duplicates === 1, 20_000, 'the redelivery');
      expect(seen).toEqual(['fragile']); // handled once in total
      expect(second.stats).toMatchObject({ handled: 0, duplicates: 1 });
    }, 60_000);

    it('a store without markProcessedWith makes ctx.markProcessed(tx) a configuration error that stops the consumer — never a DLQ record', async () => {
      const errors: string[] = [];
      const c = track(
        createConsumer({
          groupId: 'misconfigured',
          topics: [topic],
          topicPrefix: prefix,
          kafka,
          fromBeginning: false,
          processed: createMemoryProcessedStore(),
          retries: 2,
          log: (l) => {
            if (l.event === 'dead_lettered') errors.push(l.error_class ?? '');
          },
          sleep: noWait,
          handler: async (_m, ctx) => {
            await ctx.markProcessed({ query: async () => ({ rows: [] }) });
          },
        }),
      );
      await c.start();
      await new Promise((r) => setTimeout(r, 1_500));
      await publish(event('cfg'));
      await new Promise((r) => setTimeout(r, 2_500));
      expect(c.stats.dead_lettered).toBe(0);
      expect(errors).toEqual([]);
      expect(await readDeadLetters('misconfigured', { kafka, topicPrefix: prefix })).toEqual([]);
    }, 60_000);

    it('has() is re-checked before every retry: an id another instance marked meanwhile is not retried', async () => {
      const store = createMemoryProcessedStore();
      let attempts = 0;
      const c = track(
        createConsumer({
          groupId: 'raced',
          topics: [topic],
          topicPrefix: prefix,
          kafka,
          fromBeginning: false,
          processed: store,
          retries: 5,
          log: quiet,
          sleep: noWait,
          handler: async (m) => {
            attempts += 1;
            await store.markProcessed('raced', m.outboxId); // "the other instance" won while we were failing
            throw new Error('first attempt fails');
          },
        }),
      );
      await c.start();
      await new Promise((r) => setTimeout(r, 1_500));
      await publish(event('raced'));
      await until(() => c.stats.duplicates === 1, 20_000, 'the duplicate verdict on retry');
      expect(attempts).toBe(1);
      expect(c.stats).toMatchObject({ handled: 0, retries: 1, duplicates: 1, dead_lettered: 0 });
    }, 60_000);

    it("atomic dedupe: ctx.markProcessed(tx) marks through the handler's own client and the SDK does not mark again", async () => {
      const calls: string[] = [];
      const store = {
        has: async () => false,
        markProcessed: async (_g: string, id: string) => {
          calls.push(`sdk:${id}`);
        },
        markProcessedWith: async (
          q: { query(t: string, p?: unknown[]): Promise<{ rows: unknown[] }> },
          _g: string,
          id: string,
        ) => {
          await q.query('INSERT processed', [id]);
          calls.push(`tx:${id}`);
        },
      };
      const tx = {
        query: async (text: string, params?: unknown[]) => {
          calls.push(`q:${text}:${String(params?.[0])}`);
          return { rows: [] };
        },
      };
      const seen: string[] = [];
      const c = track(
        createConsumer({
          groupId: 'atomic',
          topics: [topic],
          topicPrefix: prefix,
          kafka,
          fromBeginning: false,
          processed: store,
          log: quiet,
          sleep: noWait,
          handler: async (m, ctx) => {
            // the real thing: BEGIN; side effects; ctx.markProcessed(tx); COMMIT — all on one client
            if (tagOf(m) === 'atomic') await ctx.markProcessed(tx);
            seen.push(tagOf(m));
          },
        }),
      );
      await c.start();
      await new Promise((r) => setTimeout(r, 1_500));
      const a = event('atomic');
      const b = event('plain');
      await publish(a, b);
      await until(() => seen.length === 2, 20_000, 'both messages');
      expect(calls).toEqual([
        `q:INSERT processed:${a.event_id}`,
        `tx:${a.event_id}`,
        `sdk:${b.event_id}`,
      ]);
      expect(c.stats).toMatchObject({ handled: 2 });
    }, 60_000);

    it('a DLQ entry whose original is gone is reported as missing and kept, never tombstoned', async () => {
      const p = kafka.producer({ allowAutoTopicCreation: false });
      await p.connect();
      const ghost: DeadLetter = {
        outbox_id: '99999999-0000-4000-8000-000000000001',
        group_id: 'ghost',
        topic: wire,
        partition: 0,
        offset: '999999',
        event_topic: topic,
        event_version: 1,
        attempts: 5,
        error_class: 'HandlerFailed',
        failed_at: new Date().toISOString(),
      };
      const admin = kafka.admin();
      await admin.connect();
      await ensureTopics(
        admin,
        planTopics(policy, { environment: 't', prefix, topics: [], consumerGroups: ['ghost'] }),
      );
      await admin.disconnect();
      await p.send({
        topic: `${prefix}${dlqTopicName('ghost')}`,
        messages: [{ key: ghost.outbox_id, value: JSON.stringify(ghost) }],
      });
      await p.disconnect();
      let ran = 0;
      const r = await replayFromDlq({
        groupId: 'ghost',
        topicPrefix: prefix,
        kafka,
        sleep: noWait,
        handler: async () => {
          ran += 1;
        },
      });
      expect(r).toEqual({ entries: 1, replayed: [], failed: [], missing: [ghost.outbox_id] });
      expect(ran).toBe(0);
      expect(await readDeadLetters('ghost', { kafka, topicPrefix: prefix })).toHaveLength(1);
    }, 60_000);

    it('replayFromDlq reruns the handler for the live DLQ entries and tombstones the successes', async () => {
      const dead = await readDeadLetters('poison', { kafka, topicPrefix: prefix });
      expect(dead).toHaveLength(1);
      const dry = await replayFromDlq({
        groupId: 'poison',
        topicPrefix: prefix,
        kafka,
        dryRun: true,
        handler: async () => {},
      });
      expect(dry).toEqual({ entries: 1, replayed: [], failed: [], missing: [] });

      const replayed: string[] = [];
      let attempts = 0;
      const r = await replayFromDlq({
        groupId: 'poison',
        topicPrefix: prefix,
        kafka,
        retries: 2,
        sleep: noWait,
        handler: async (m, ctx) => {
          attempts += 1;
          if (ctx.attempt === 1) throw new Error('still flaky');
          replayed.push(tagOf(m));
        },
      });
      expect(r).toEqual({ entries: 1, replayed: [dead[0]!.outbox_id], failed: [], missing: [] });
      expect(replayed).toEqual(['bad']);
      expect(attempts).toBe(2);
      expect(await readDeadLetters('poison', { kafka, topicPrefix: prefix })).toEqual([]);

      // a replay that keeps failing leaves a fresh record with the attempts added up
      const again: DeadLetter = { ...dead[0]!, attempts: 1 };
      await kafka.producer({ allowAutoTopicCreation: false }).connect();
      const p = kafka.producer({ allowAutoTopicCreation: false });
      await p.connect();
      await p.send({
        topic: `${prefix}${dlqTopicName('poison')}`,
        messages: [{ key: again.outbox_id, value: JSON.stringify(again) }],
      });
      await p.disconnect();
      const r2 = await replayFromDlq({
        groupId: 'poison',
        topicPrefix: prefix,
        kafka,
        retries: 2,
        sleep: noWait,
        handler: async () => {
          const e = new Error('nope');
          e.name = 'StillBroken';
          throw e;
        },
      });
      expect(r2).toEqual({
        entries: 1,
        replayed: [],
        failed: [{ outbox_id: again.outbox_id, error_class: 'StillBroken' }],
        missing: [],
      });
      const left = await readDeadLetters('poison', { kafka, topicPrefix: prefix });
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ attempts: 3, error_class: 'StillBroken' });
    }, 90_000);
  },
);
