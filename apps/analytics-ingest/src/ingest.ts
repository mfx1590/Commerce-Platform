// The ingest loop (#600). One kafkajs consumer in group `config.groupId` reads every topic of @platform/events
// from the beginning. Per partition batch:
//   1. every message is classified (rows.ts): a raw_events row, or a dead letter;
//   2. the rows go into the shared insert buffer and the dead letters to `dlq.<group>` (acks = all), in parallel;
//   3. only when BOTH are acknowledged is the batch's offset committed.
// A crash anywhere before 3 redelivers the batch; its rows are inserted again with the same (topic, event_id)
// and ReplacingMergeTree folds them. Nothing is committed for a message that is neither in ClickHouse nor in
// the DLQ, so nothing is silently dropped.
import type { EachBatchPayload, Kafka, Producer } from 'kafkajs';
import {
  createValidator,
  ensureTopics,
  EVENT_TOPICS,
  HEADER_OUTBOX_ID,
  planTopics,
  type DeadLetter,
  type TopicPolicy,
  type Validator,
} from '@platform/events';
import { createBatcher, type Batcher, type RowSink } from './batcher.js';
import type { IngestConfig } from './config.js';
import { createIngestMetrics, type IngestMetrics } from './metrics.js';
import type { ChClient } from './clickhouse.js';
import {
  applyErasure,
  createErasureIndex,
  erasedCustomerOf,
  loadErasures,
  type ErasedCustomer,
  type ErasureIndex,
} from './erasure.js';
import { classify, type RawEventRow, type WireBatch } from './rows.js';

export interface IngestLogLine {
  service: 'analytics-ingest';
  group_id: string;
  event:
    'started' | 'stopped' | 'batch' | 'dead_lettered' | 'crashed_before_commit' | 'batch_failed';
  topic?: string;
  partition?: number;
  first?: string | undefined;
  last?: string;
  rows?: number;
  dead?: number;
  event_topic?: string;
  event_version?: number;
  outbox_id?: string;
  error_class?: string;
}

export type Log = (line: IngestLogLine) => void;
export const consoleLog: Log = (line) => console.info(JSON.stringify(line));

export interface DeadLetterSink {
  send(letters: readonly DeadLetter[]): Promise<void>;
}

export interface BatchDeps {
  groupId: string;
  batcher: Pick<Batcher<RawEventRow>, 'add'>;
  dlq: DeadLetterSink;
  validator: Validator;
  commit(topic: string, partition: number, nextOffset: string): Promise<void>;
  metrics?: IngestMetrics;
  log?: Log;
  now?: () => Date;
  /** Test seam: called after the insert and the DLQ were acknowledged, before the commit. Throw = a crash. */
  onBeforeCommit?: ((batch: WireBatch) => Promise<void> | void) | undefined;
  /** #623: scrubs identifiers of erased customers at classification. */
  erasures?: ErasureIndex | undefined;
  /** #623: applied for each customer.erased of the batch, after its insert is acknowledged, before the commit. */
  erase?: ((c: ErasedCustomer) => Promise<unknown>) | undefined;
}

/** Thrown by an `onBeforeCommit` seam to simulate a crash: the ingest stops taking batches, nothing is committed. */
export class SimulatedCrash extends Error {
  constructor(message = 'simulated crash between insert and commit') {
    super(message);
    this.name = 'SimulatedCrash';
  }
}

export interface BatchResult {
  rows: number;
  dead: number;
  committed: string | null;
  /** Rows per EVENT topic (unprefixed). */
  byTopic: Record<string, number>;
}

/** Steps 1–3 for one partition batch. Throws (without committing) when the insert, the DLQ or the seam fails. */
export async function processBatch(batch: WireBatch, deps: BatchDeps): Promise<BatchResult> {
  if (batch.messages.length === 0) return { rows: 0, dead: 0, committed: null, byTopic: {} };
  const now = deps.now?.() ?? new Date();
  const rows: RawEventRow[] = [];
  const letters: DeadLetter[] = [];
  const erased: ErasedCustomer[] = [];
  for (const m of batch.messages) {
    const c = classify(m, batch, {
      groupId: deps.groupId,
      validator: deps.validator,
      now,
      erasures: deps.erasures,
    });
    if (c.kind === 'row') {
      rows.push(c.row);
      const e = erasedCustomerOf(c.envelope);
      if (e) erased.push(e);
    } else letters.push(c.letter);
  }
  await Promise.all([
    rows.length > 0 ? deps.batcher.add(rows) : Promise.resolve(),
    letters.length > 0 ? deps.dlq.send(letters) : Promise.resolve(),
  ]);

  const ackedAt = (deps.now?.() ?? new Date()).getTime();
  for (const m of batch.messages) {
    const ts = Number(m.timestamp);
    if (Number.isFinite(ts)) deps.metrics?.delay(ackedAt - ts);
  }
  const perTopic = new Map<string, number>();
  for (const r of rows) perTopic.set(r.topic, (perTopic.get(r.topic) ?? 0) + 1);
  for (const [topic, n] of perTopic) deps.metrics?.inserted(topic, n);
  for (const l of letters) {
    deps.metrics?.deadLettered(l.event_topic, l.error_class);
    deps.log?.({
      service: 'analytics-ingest',
      group_id: deps.groupId,
      event: 'dead_lettered',
      topic: l.topic,
      partition: l.partition,
      outbox_id: l.outbox_id,
      event_topic: l.event_topic,
      event_version: l.event_version,
      error_class: l.error_class,
    });
  }

  // #623: erasures are part of the batch: nothing is committed until every one of them is applied
  for (const e of erased) {
    if (!deps.erase)
      throw new Error('customer.erased without an erasure handler: refusing to commit');
    await deps.erase(e);
  }
  await deps.onBeforeCommit?.(batch);
  const last = batch.messages[batch.messages.length - 1]!.offset;
  const next = String(BigInt(last) + 1n);
  await deps.commit(batch.topic, batch.partition, next);
  return {
    rows: rows.length,
    dead: letters.length,
    committed: next,
    byTopic: Object.fromEntries(perTopic),
  };
}

// ---- kafkajs wiring ----------------------------------------------------------------------------------------

/** Thrown when another live member already consumes the group: two replicas would each hold their own erasure index. */
export class SecondReplicaError extends Error {
  constructor(groupId: string, members: number) {
    super(
      `consumer group ${groupId} already has ${members} live member(s): the analytics ingest runs as ONE replica (its erasure index is per process)`,
    );
    this.name = 'SecondReplicaError';
  }
}

/**
 * Phase 5 runs ONE ingest replica: the erasure index is loaded at start and kept in memory, so a second replica
 * would not see the other's erasures until it restarts. Refuses to start when the group already has live members.
 * Best effort by construction: two processes starting in the same instant can both see an empty group (kafkajs
 * offers no atomic "join only if alone"); the multi-replica fix (a periodic index refresh + re-scrub) is on
 * docs/launch-checklist.md.
 */
export async function assertSingleReplica(
  admin: {
    describeGroups(
      groupIds: string[],
    ): Promise<{ groups: { groupId: string; state: string; members: unknown[] }[] }>;
  },
  groupId: string,
): Promise<void> {
  const { groups } = await admin.describeGroups([groupId]);
  const g = groups.find((x) => x.groupId === groupId);
  if (g && g.state !== 'Dead' && g.state !== 'Empty' && g.members.length > 0)
    throw new SecondReplicaError(groupId, g.members.length);
}

export interface IngestStats {
  batches: number;
  rows: number;
  dead_lettered: number;
  rows_by_topic: Record<string, number>;
}

export interface Ingest {
  readonly groupId: string;
  readonly dlqTopic: string;
  readonly stats: IngestStats;
  /** When the last non-empty batch was committed (ms), null before the first. */
  lastBatchAt(): number | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface IngestOptions {
  config: Pick<
    IngestConfig,
    'groupId' | 'dlqTopic' | 'topicPrefix' | 'batchSize' | 'flushMs' | 'concurrency'
  >;
  kafka: Kafka;
  sink: RowSink<RawEventRow>;
  /** Defaults to every topic of @platform/events. */
  topics?: readonly string[];
  validator?: Validator;
  metrics?: IngestMetrics;
  log?: Log;
  onBeforeCommit?: BatchDeps['onBeforeCommit'];
  /**
   * #623: the erasure key (ANALYTICS_ERASURE_KEY) and the ClickHouse client the erasures are recorded in. Without it a
   * batch holding a customer.erased is never committed (fail closed): every real deployment passes it.
   */
  erasure?: { key: string; ch: ChClient } | undefined;
}

export function createIngest(opts: IngestOptions): Ingest {
  const { config, kafka } = opts;
  const log = opts.log ?? consoleLog;
  const metrics = opts.metrics ?? createIngestMetrics();
  const validator = opts.validator ?? createValidator();
  const topics = (opts.topics ?? EVENT_TOPICS).map((t) => `${config.topicPrefix}${t}`);
  const stats: IngestStats = { batches: 0, rows: 0, dead_lettered: 0, rows_by_topic: {} };
  const erasures = opts.erasure ? createErasureIndex(opts.erasure.key) : undefined;
  const batcher = createBatcher<RawEventRow>({
    sink: opts.sink,
    batchSize: config.batchSize,
    flushMs: config.flushMs,
    onFlushed: (_rows, ms) => metrics.insertDuration(ms),
  });
  const consumer = kafka.consumer({
    groupId: config.groupId,
    allowAutoTopicCreation: false,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });
  let producer: Producer | undefined;
  let stopping = false;
  let lastBatchAt: number | null = null;
  const inFlight = new Set<Promise<unknown>>();

  const dlq: DeadLetterSink = {
    async send(letters) {
      if (!producer) throw new Error('dead letter skipped: the ingest is not running');
      await producer.send({
        topic: config.dlqTopic,
        acks: -1,
        messages: letters.map((l) => ({
          key: l.outbox_id,
          value: JSON.stringify(l),
          headers: { [HEADER_OUTBOX_ID]: l.outbox_id },
        })),
      });
    },
  };

  async function ensureDlq(): Promise<void> {
    // the SDK's own plan for `dlq.<group>` (compacted), under the same prefix the consumer reads
    const policy: TopicPolicy = {
      environments: { consumer: { partitions: 1, replication: 1 } },
      retention: { forever: [], days_30: [] },
      dlq: { prefix: 'dlq.', consumer_groups: [] },
    };
    const plan = planTopics(policy, {
      environment: 'consumer',
      prefix: config.topicPrefix,
      topics: [],
      consumerGroups: [config.groupId],
    });
    const admin = kafka.admin();
    await admin.connect();
    try {
      await ensureTopics(admin, plan);
    } finally {
      await admin.disconnect();
    }
  }

  async function eachBatch(p: EachBatchPayload): Promise<void> {
    const { batch } = p;
    if (stopping || !p.isRunning() || p.isStale() || batch.messages.length === 0) return;
    // keep the group membership alive while the batch waits for the buffer's flush
    const beat = setInterval(() => void p.heartbeat().catch(() => undefined), 2_000);
    const work = processBatch(
      {
        topic: batch.topic,
        partition: batch.partition,
        messages: batch.messages.map((m) => ({
          key: m.key,
          value: m.value,
          headers: m.headers,
          offset: m.offset,
          timestamp: m.timestamp,
        })),
      },
      {
        groupId: config.groupId,
        batcher,
        dlq,
        validator,
        metrics,
        log,
        onBeforeCommit: opts.onBeforeCommit,
        erasures,
        erase: erasures
          ? (c) =>
              applyErasure(
                { ch: opts.erasure!.ch, index: erasures, flush: () => batcher.flush() },
                c,
              )
          : undefined,
        commit: async (topic, partition, offset) => {
          await consumer.commitOffsets([{ topic, partition, offset }]);
          p.resolveOffset(String(BigInt(offset) - 1n));
        },
      },
    );
    inFlight.add(work);
    try {
      const r = await work;
      stats.batches += 1;
      stats.rows += r.rows;
      stats.dead_lettered += r.dead;
      for (const [t, n] of Object.entries(r.byTopic))
        stats.rows_by_topic[t] = (stats.rows_by_topic[t] ?? 0) + n;
      lastBatchAt = Date.now();
      metrics.lag(batch.topic, batch.partition, Number(batch.offsetLag()));
      log({
        service: 'analytics-ingest',
        group_id: config.groupId,
        event: 'batch',
        topic: batch.topic,
        partition: batch.partition,
        first: batch.firstOffset() ?? undefined,
        last: batch.lastOffset(),
        rows: r.rows,
        dead: r.dead,
      });
    } catch (err) {
      const crashed = err instanceof SimulatedCrash;
      log({
        service: 'analytics-ingest',
        group_id: config.groupId,
        event: crashed ? 'crashed_before_commit' : 'batch_failed',
        topic: batch.topic,
        partition: batch.partition,
        error_class: (err as Error).name,
      });
      if (crashed) {
        stopping = true;
        return;
      }
      throw err; // kafkajs restarts the consumer from the last commit: the batch comes back
    } finally {
      clearInterval(beat);
      inFlight.delete(work);
    }
  }

  return {
    groupId: config.groupId,
    dlqTopic: config.dlqTopic,
    stats,
    lastBatchAt: () => lastBatchAt,
    async start() {
      stopping = false;
      if (erasures) {
        // the erasure index is per process (loaded here): one replica only in Phase 5 (README, Erasure)
        const admin = kafka.admin();
        await admin.connect();
        try {
          await assertSingleReplica(admin, config.groupId);
        } finally {
          await admin.disconnect();
        }
        await loadErasures(opts.erasure!.ch, erasures);
      }
      await ensureDlq();
      producer = kafka.producer({ allowAutoTopicCreation: false, maxInFlightRequests: 1 });
      await producer.connect();
      await consumer.connect();
      await consumer.subscribe({ topics, fromBeginning: true });
      await consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        partitionsConsumedConcurrently: config.concurrency,
        eachBatch,
      });
      log({ service: 'analytics-ingest', group_id: config.groupId, event: 'started' });
    },
    async stop() {
      // no new batches; the ones in flight finish (flush, ack, commit) before the connections close
      stopping = true;
      await batcher.flush().catch(() => undefined);
      await Promise.allSettled([...inFlight]);
      await consumer.disconnect().catch(() => undefined);
      await producer?.disconnect().catch(() => undefined);
      log({ service: 'analytics-ingest', group_id: config.groupId, event: 'stopped' });
    },
  };
}
