// Consumer SDK with a dead-letter pattern (issue #533).
//
// createConsumer({ groupId, topics, handler }) reads the bus with kafkajs, decodes every message (relay-message.ts),
// skips what it does not know (unknown topic, higher version: logged, never a crash), dedupes on the outbox id
// through a ProcessedStore, runs the handler with bounded retries, and after the last failure writes a
// dead-letter record to `dlq.<groupId>` (compacted; key = outbox id; error class, ids and offsets — never the
// payload) and moves on. The offset is committed only after the handler succeeded or the record is in the DLQ:
// a crash before the commit redelivers, and the processed store turns the redelivery into a no-op.
import type { Admin, Consumer, EachBatchPayload, Kafka, KafkaMessage, Producer } from 'kafkajs';
import { EVENT_SCHEMAS } from './generated/schemas.js';
import { decodeMessage, HEADER_OUTBOX_ID, type DecodedMessage } from './relay-message.js';
import { createKafka } from './topics.js';
import { dlqTopicName, ensureTopics, planTopics, type TopicPolicy } from './topics.js';

// ---- processed store ---------------------------------------------------------------------------------------

/**
 * Where a consumer group remembers the outbox ids it has handled. The in-memory store is for tests and for
 * consumers whose handlers are idempotent anyway; a durable consumer keeps it in its own database table
 * (`createPgProcessedStore`), so a redelivery after a crash is recognised by the restarted process.
 */
export interface ProcessedStore {
  has(groupId: string, outboxId: string): Promise<boolean>;
  markProcessed(groupId: string, outboxId: string): Promise<void>;
  /**
   * Marks through the HANDLER's own transaction (`ctx.markProcessed(tx)`), so the side effects and the processed
   * row commit together — exactly once for what that transaction holds. Without it the mark happens after the
   * handler returned, and a crash in between reruns the handler (at-least-once). The memory store has no such
   * seam: it is at-least-once only.
   */
  markProcessedWith?(q: ProcessedQueryable, groupId: string, outboxId: string): Promise<void>;
}

/** Bounded, insertion-ordered: the oldest ids fall out first. */
export function createMemoryProcessedStore(max = 10_000): ProcessedStore {
  const seen = new Set<string>();
  return {
    async has(groupId, outboxId) {
      return seen.has(`${groupId}:${outboxId}`);
    },
    async markProcessed(groupId, outboxId) {
      const key = `${groupId}:${outboxId}`;
      seen.delete(key);
      seen.add(key);
      if (seen.size > max) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
  };
}

export interface ProcessedQueryable {
  query(text: string, params?: unknown[]): Promise<{ rowCount?: number | null; rows: unknown[] }>;
}

const TABLE = /^[a-z_][a-z0-9_]*$/;

/**
 * A table the CONSUMER owns, with at least `group_id text` and `outbox_id uuid` and a unique key on the pair
 * (and, recommended, `processed_at timestamptz default now()`). The SDK never creates tables; a shared
 * `consumer_processed` table in packages/db is a CONTRACT CHANGE for the main window when a consumer wants one.
 */
export function createPgProcessedStore(db: ProcessedQueryable, table: string): ProcessedStore {
  if (!TABLE.test(table)) throw new Error(`invalid processed table name "${table}"`);
  return {
    async has(groupId, outboxId) {
      const r = await db.query(`SELECT 1 FROM ${table} WHERE group_id = $1 AND outbox_id = $2`, [
        groupId,
        outboxId,
      ]);
      return r.rows.length > 0;
    },
    async markProcessed(groupId, outboxId) {
      await insert(db, groupId, outboxId);
    },
    async markProcessedWith(q, groupId, outboxId) {
      await insert(q, groupId, outboxId);
    },
  };
  function insert(q: ProcessedQueryable, groupId: string, outboxId: string): Promise<unknown> {
    return q.query(
      `INSERT INTO ${table} (group_id, outbox_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [groupId, outboxId],
    );
  }
}

// ---- dead-letter record ------------------------------------------------------------------------------------

/** What goes to `dlq.<groupId>` (key = outbox id). No payload, no PII: ids, offsets, the error CLASS, counts. */
export interface DeadLetter {
  outbox_id: string;
  group_id: string;
  /** The wire topic the message was read from (prefixed in tests). */
  topic: string;
  partition: number;
  offset: string;
  event_topic: string;
  event_version: number;
  attempts: number;
  error_class: string;
  failed_at: string;
}

export function errorClassOf(err: unknown): string {
  if (!(err instanceof Error)) return 'Error';
  const type = (err as Error & { type?: unknown }).type;
  return typeof type === 'string' && type ? `${err.name}:${type}` : err.name;
}

// ---- consumer ----------------------------------------------------------------------------------------------

export interface HandlerContext {
  groupId: string;
  topic: string;
  partition: number;
  offset: string;
  /** 1 on the first try. */
  attempt: number;
  /**
   * Atomic dedupe: call it INSIDE your transaction with that transaction's client (`await ctx.markProcessed(tx)`)
   * and the processed row commits with your side effects; the SDK then skips its own mark after the handler.
   * Needs a store with `markProcessedWith` (the Postgres store). Without an argument it marks through the store
   * directly (same as not calling it).
   */
  markProcessed(q?: ProcessedQueryable): Promise<void>;
}

export type EventHandler = (message: DecodedMessage, ctx: HandlerContext) => Promise<void>;

export interface ConsumerLogLine {
  consumer: 'events';
  group_id: string;
  event:
    | 'started'
    | 'stopped'
    | 'skipped_unknown'
    | 'duplicate'
    | 'retry'
    | 'dead_lettered'
    | 'crashed_before_commit'
    | 'decode_failed';
  topic?: string;
  partition?: number;
  offset?: string;
  outbox_id?: string;
  event_topic?: string;
  event_version?: number;
  attempt?: number;
  error_class?: string;
}

export interface ConsumerOptions {
  groupId: string;
  /** Event topics to read (`order.placed`); `topicPrefix` is applied to them and to the DLQ (tests). */
  topics: string[];
  handler: EventHandler;
  kafka?: Kafka;
  processed?: ProcessedStore;
  /** Handler attempts per message before the DLQ. Default 5. */
  retries?: number;
  /** Backoff between attempts: initial × 2^n, capped. Default 200 ms → 3 s. */
  backoff?: { initialMs: number; maxMs: number };
  topicPrefix?: string;
  /** The DLQ topic's numbers (the policy's environment numbers in production; 1/1 locally). */
  dlq?: { partitions?: number; replication?: number };
  log?: (line: ConsumerLogLine) => void;
  /**
   * Test seam, called after a message was handled (or dead-lettered) and before its offset is committed. Throwing
   * here simulates a crash: the consumer stops without committing, so the message is redelivered.
   */
  onBeforeCommit?: (ctx: HandlerContext) => Promise<void> | void;
  /**
   * Where a group with NO committed offset starts. Default true (the beginning): a new consumer rebuilds from
   * history (ADR 0003), and a consumer that crashed before its first commit does not lose the messages it saw —
   * with `false` (the latest offset) such a restart would skip them. `false` is for tests and tail-only readers.
   */
  fromBeginning?: boolean;
  /** Test seam: wait between attempts (default: real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** kafkajs group timeouts. Defaults: session 10 s, heartbeat 3 s, rebalance 60 s. */
  sessionTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  rebalanceTimeoutMs?: number;
}

export interface ConsumerStats {
  handled: number;
  duplicates: number;
  skipped_unknown: number;
  retries: number;
  dead_lettered: number;
  decode_failed: number;
}

export interface EventConsumer {
  readonly groupId: string;
  readonly dlqTopic: string;
  readonly stats: ConsumerStats;
  /** Ensures the DLQ topic, connects, subscribes, runs. Resolves once the consumer is running. */
  start(): Promise<void>;
  /** Stops reading, disconnects. Safe to call twice. */
  stop(): Promise<void>;
}

const KNOWN = new Set(Object.keys(EVENT_SCHEMAS));
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createConsumer(opts: ConsumerOptions): EventConsumer {
  const kafka = opts.kafka ?? createKafka({ clientId: `consumer-${opts.groupId}` });
  const prefix = opts.topicPrefix ?? '';
  const processed = opts.processed ?? createMemoryProcessedStore();
  const retries = opts.retries ?? 5;
  const backoff = opts.backoff ?? { initialMs: 200, maxMs: 3_000 };
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? ((line: ConsumerLogLine) => console.info(JSON.stringify(line)));
  const dlqTopic = `${prefix}${dlqTopicName(opts.groupId)}`;
  const wireTopics = opts.topics.map((t) => `${prefix}${t}`);
  const stats: ConsumerStats = {
    handled: 0,
    duplicates: 0,
    skipped_unknown: 0,
    retries: 0,
    dead_lettered: 0,
    decode_failed: 0,
  };

  let consumer: Consumer | undefined;
  let producer: Producer | undefined;
  let stopping = false;

  async function ensureDlq(): Promise<void> {
    const policy: TopicPolicy = {
      environments: {
        consumer: {
          partitions: opts.dlq?.partitions ?? 1,
          replication: opts.dlq?.replication ?? 1,
        },
      },
      retention: { forever: [], days_30: [] },
      dlq: { prefix: 'dlq.', consumer_groups: [] },
    };
    const plan = planTopics(policy, {
      environment: 'consumer',
      prefix,
      topics: [],
      consumerGroups: [opts.groupId],
    });
    const admin: Admin = kafka.admin();
    await admin.connect();
    try {
      await ensureTopics(admin, plan);
    } finally {
      await admin.disconnect();
    }
  }

  async function deadLetter(record: DeadLetter): Promise<void> {
    await producer!.send({
      topic: dlqTopic,
      acks: -1,
      messages: [
        {
          key: record.outbox_id,
          value: JSON.stringify(record),
          headers: { [HEADER_OUTBOX_ID]: record.outbox_id },
        },
      ],
    });
  }

  async function handleOne(payload: EachBatchPayload, message: KafkaMessage): Promise<void> {
    const { batch, heartbeat } = payload;
    const ctxBase = {
      groupId: opts.groupId,
      topic: batch.topic,
      partition: batch.partition,
      offset: message.offset,
    };
    const base = {
      consumer: 'events' as const,
      group_id: opts.groupId,
      topic: batch.topic,
      partition: batch.partition,
      offset: message.offset,
    };

    let decoded: DecodedMessage;
    try {
      decoded = decodeMessage({ key: message.key, value: message.value, headers: message.headers });
    } catch (err) {
      stats.decode_failed += 1;
      const outboxId =
        message.headers?.[HEADER_OUTBOX_ID]?.toString() ??
        `undecodable:${batch.topic}:${batch.partition}:${message.offset}`;
      log({ ...base, event: 'decode_failed', outbox_id: outboxId, error_class: errorClassOf(err) });
      await deadLetter({
        outbox_id: outboxId,
        group_id: opts.groupId,
        topic: batch.topic,
        partition: batch.partition,
        offset: message.offset,
        event_topic: '?',
        event_version: 0,
        attempts: 0,
        error_class: errorClassOf(err),
        failed_at: new Date().toISOString(),
      });
      stats.dead_lettered += 1;
      return;
    }
    const { envelope, outboxId } = decoded;
    const info = {
      outbox_id: outboxId,
      event_topic: envelope.topic,
      event_version: envelope.version,
    };

    if (!KNOWN.has(`${envelope.topic}@${envelope.version}`)) {
      stats.skipped_unknown += 1;
      log({ ...base, ...info, event: 'skipped_unknown' });
      return;
    }
    if (await processed.has(opts.groupId, outboxId)) {
      stats.duplicates += 1;
      log({ ...base, ...info, event: 'duplicate' });
      return;
    }

    for (let attempt = 1; ; attempt++) {
      let marked = false;
      const markProcessed = async (q?: ProcessedQueryable): Promise<void> => {
        if (q) {
          if (!processed.markProcessedWith) {
            throw new Error(
              'ctx.markProcessed(tx) needs a processed store with markProcessedWith (the Postgres store)',
            );
          }
          await processed.markProcessedWith(q, opts.groupId, outboxId);
        } else {
          await processed.markProcessed(opts.groupId, outboxId);
        }
        marked = true;
      };
      try {
        await opts.handler(decoded, { ...ctxBase, attempt, markProcessed });
        if (!marked) await processed.markProcessed(opts.groupId, outboxId);
        stats.handled += 1;
        return;
      } catch (err) {
        const errorClass = errorClassOf(err);
        if (attempt >= retries) {
          stats.dead_lettered += 1;
          log({ ...base, ...info, event: 'dead_lettered', attempt, error_class: errorClass });
          await deadLetter({
            outbox_id: outboxId,
            group_id: opts.groupId,
            topic: batch.topic,
            partition: batch.partition,
            offset: message.offset,
            event_topic: envelope.topic,
            event_version: envelope.version,
            attempts: attempt,
            error_class: errorClass,
            failed_at: new Date().toISOString(),
          });
          return;
        }
        stats.retries += 1;
        log({ ...base, ...info, event: 'retry', attempt, error_class: errorClass });
        await heartbeat();
        await sleep(Math.min(backoff.maxMs, backoff.initialMs * 2 ** (attempt - 1)));
      }
    }
  }

  async function eachBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat, isRunning, isStale } = payload;
    for (const message of batch.messages) {
      if (stopping || !isRunning() || isStale()) return;
      await handleOne(payload, message);
      const ctx = {
        groupId: opts.groupId,
        topic: batch.topic,
        partition: batch.partition,
        offset: message.offset,
        attempt: 0,
        markProcessed: async () => {},
      };
      try {
        await opts.onBeforeCommit?.(ctx);
      } catch (err) {
        // the simulated crash: stop without committing; the message comes back on the next start
        log({
          consumer: 'events',
          group_id: opts.groupId,
          event: 'crashed_before_commit',
          topic: batch.topic,
          partition: batch.partition,
          offset: message.offset,
          error_class: errorClassOf(err),
        });
        stopping = true;
        void stop();
        return;
      }
      resolveOffset(message.offset);
      await consumer!.commitOffsets([
        {
          topic: batch.topic,
          partition: batch.partition,
          offset: String(Number(message.offset) + 1),
        },
      ]);
      await heartbeat();
    }
  }

  async function start(): Promise<void> {
    stopping = false;
    await ensureDlq();
    producer = kafka.producer({
      allowAutoTopicCreation: false,
      maxInFlightRequests: 1,
      retry: { retries: 3 },
    });
    await producer.connect();
    // Timeouts: a message's retries (default 5 attempts, backoff 200 ms → 3 s, ≈ 6 s of waiting) stay inside one
    // session because the loop heartbeats between attempts; the handler itself must return (or throw) well
    // within the session timeout, or raise it here. Rebalance: the time a member has to rejoin.
    consumer = kafka.consumer({
      groupId: `${prefix}${opts.groupId}`,
      sessionTimeout: opts.sessionTimeoutMs ?? 10_000,
      heartbeatInterval: opts.heartbeatIntervalMs ?? 3_000,
      rebalanceTimeout: opts.rebalanceTimeoutMs ?? 60_000,
    });
    await consumer.connect();
    await consumer.subscribe({ topics: wireTopics, fromBeginning: opts.fromBeginning ?? true });
    await consumer.run({ autoCommit: false, eachBatchAutoResolve: false, eachBatch });
    log({ consumer: 'events', group_id: opts.groupId, event: 'started' });
  }

  async function stop(): Promise<void> {
    stopping = true;
    const c = consumer;
    const p = producer;
    consumer = undefined;
    producer = undefined;
    if (c) await c.disconnect().catch(() => {});
    if (p) await p.disconnect().catch(() => {});
    if (c || p) log({ consumer: 'events', group_id: opts.groupId, event: 'stopped' });
  }

  return { groupId: opts.groupId, dlqTopic, stats, start, stop };
}
