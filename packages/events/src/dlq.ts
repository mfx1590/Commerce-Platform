// Replay from the dead-letter queue (issue #533).
//
// readDeadLetters(groupId) reads `dlq.<groupId>` from the beginning and keeps the latest record per outbox id
// (a null value is a tombstone: the entry was replayed successfully). replayFromDlq re-fetches every original
// message by (topic, partition, offset), runs the handler with the same retries, and writes a tombstone on
// success; a failure writes a fresh record (attempts + 1) so the entry stays visible.
import type { Kafka, KafkaMessage } from 'kafkajs';
import {
  ConsumerConfigurationError,
  createMemoryProcessedStore,
  errorClassOf,
  type DeadLetter,
  type EventHandler,
  type ProcessedQueryable,
  type ProcessedStore,
} from './consumer.js';
import { decodeMessage, HEADER_OUTBOX_ID } from './relay-message.js';
import { createKafka, dlqTopicName } from './topics.js';

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The live (not tombstoned) entries of a group's DLQ, latest per outbox id. */
export async function readDeadLetters(
  groupId: string,
  opts: { kafka?: Kafka; topicPrefix?: string; timeoutMs?: number } = {},
): Promise<DeadLetter[]> {
  const kafka = opts.kafka ?? createKafka({ clientId: `dlq-reader-${groupId}` });
  const topic = `${opts.topicPrefix ?? ''}${dlqTopicName(groupId)}`;
  const entries = await readTopicToEnd(
    kafka,
    topic,
    `${opts.topicPrefix ?? ''}dlq-read-${groupId}-${Math.random().toString(36).slice(2, 8)}`,
    opts.timeoutMs ?? 15_000,
  );
  const latest = new Map<string, DeadLetter | null>();
  for (const m of entries) {
    const key = m.key?.toString();
    if (!key) continue;
    latest.set(key, m.value ? (JSON.parse(m.value.toString()) as DeadLetter) : null);
  }
  return [...latest.values()].filter((v): v is DeadLetter => v !== null);
}

/** The slice of a kafkajs client this reader needs (a test feeds it a fake with offset gaps). */
export interface TopicReaderClient {
  admin(): {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    fetchTopicOffsets(topic: string): Promise<{ partition: number; low: string; high: string }[]>;
  };
  consumer(config: { groupId: string; sessionTimeout?: number }): {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    subscribe(s: { topic: string; fromBeginning: boolean }): Promise<void>;
    run(cfg: {
      eachMessage: (payload: { partition: number; message: KafkaMessage }) => Promise<void>;
    }): Promise<void>;
  };
}

/**
 * Every message of a topic up to its current high watermarks, bounded by `timeoutMs`. A partition is finished
 * once the consumed offset reaches `high − 1` (or it is empty, `high === low`); the message COUNT is only an upper
 * bound, because a compacted topic (every DLQ is one) has offset gaps where compaction removed records and
 * tombstones — counting to Σ(high − low) would never finish after the first replay. And `high − 1` itself may be
 * gone (the last record was a tombstone that compaction removed after a segment roll), so a partition that stays
 * silent for `idleMs` after its last message is done too. A partition that never delivers anything only ends by
 * the overall timeout, which names it.
 */
export async function readTopicToEnd(
  kafka: TopicReaderClient,
  topic: string,
  groupId: string,
  timeoutMs: number,
  /** A partition that received a message and then nothing for this long is done (its last record may have been a tombstone compaction removed). */
  idleMs = 1_500,
): Promise<KafkaMessage[]> {
  const admin = kafka.admin();
  await admin.connect();
  const lastOffset = new Map<number, number>(); // partition → high − 1, for the partitions that have messages
  try {
    for (const p of await admin.fetchTopicOffsets(topic)) {
      if (Number(p.high) > Number(p.low)) lastOffset.set(p.partition, Number(p.high) - 1);
    }
  } finally {
    await admin.disconnect();
  }
  const out: KafkaMessage[] = [];
  if (lastOffset.size === 0) return out;
  const pending = new Set(lastOffset.keys());
  const idleTimers = new Map<number, NodeJS.Timeout>();
  const consumer = kafka.consumer({ groupId, sessionTimeout: 10_000 });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `read ${out.length} message(s) of ${topic} within ${timeoutMs} ms; partition(s) still short of their high watermark: ${[...pending].join(', ')}`,
          ),
        ),
      timeoutMs,
    );
    consumer
      .run({
        eachMessage: async ({ partition, message }) => {
          out.push(message);
          const done = () => {
            pending.delete(partition);
            clearTimeout(idleTimers.get(partition));
            idleTimers.delete(partition);
            if (pending.size === 0) {
              clearTimeout(timer);
              resolve();
            }
          };
          if (Number(message.offset) >= (lastOffset.get(partition) ?? -1)) {
            done();
          } else {
            // high − 1 may never arrive (a compacted tombstone was the last record): idle after the last message = done
            clearTimeout(idleTimers.get(partition));
            idleTimers.set(partition, setTimeout(done, idleMs));
          }
        },
      })
      .catch(reject);
  }).finally(() => {
    for (const t of idleTimers.values()) clearTimeout(t);
    return consumer.disconnect().catch(() => {});
  });
  return out;
}

/**
 * Fetches specific messages by (topic, partition, offset). Bounded by the partitions' current watermarks: an
 * offset below the low watermark (retention took it) or at/above the high watermark does not exist and is
 * reported as missing without waiting; the read stops once every partition passed its highest wanted offset.
 * A missing original never tombstones its DLQ entry (replayFromDlq reports it per entry and keeps the entry).
 */
async function fetchOriginals(
  kafka: Kafka,
  wanted: DeadLetter[],
  groupId: string,
  timeoutMs: number,
): Promise<{ found: Map<string, KafkaMessage>; missing: Set<string> }> {
  const found = new Map<string, KafkaMessage>();
  const missing = new Set<string>();
  if (wanted.length === 0) return { found, missing };

  // watermarks per (topic, partition)
  const admin = kafka.admin();
  await admin.connect();
  const marks = new Map<string, { low: number; high: number }>();
  try {
    for (const topic of new Set(wanted.map((d) => d.topic))) {
      for (const p of await admin.fetchTopicOffsets(topic)) {
        marks.set(`${topic}:${p.partition}`, { low: Number(p.low), high: Number(p.high) });
      }
    }
  } finally {
    await admin.disconnect();
  }

  const want = new Map<string, Set<number>>(); // `${topic}:${partition}` → offsets that exist
  for (const d of wanted) {
    const k = `${d.topic}:${d.partition}`;
    const m = marks.get(k);
    const offset = Number(d.offset);
    if (!m || offset < m.low || offset >= m.high) {
      missing.add(`${k}:${d.offset}`);
      continue;
    }
    want.set(k, new Set([...(want.get(k) ?? []), offset]));
  }
  if (want.size === 0) return { found, missing };

  const maxWanted = new Map([...want].map(([k, s]) => [k, Math.max(...s)]));
  const done = new Set<string>();
  const topics = [...new Set([...want.keys()].map((k) => k.slice(0, k.lastIndexOf(':'))))];
  const consumer = kafka.consumer({ groupId, sessionTimeout: 10_000 });
  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `fetched ${found.size} of ${wanted.length - missing.size} original message(s) within ${timeoutMs} ms`,
          ),
        ),
      timeoutMs,
    );
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    consumer
      .run({
        eachMessage: async ({ topic, partition, message }) => {
          const k = `${topic}:${partition}`;
          const offset = Number(message.offset);
          if (want.get(k)?.has(offset)) found.set(`${k}:${message.offset}`, message);
          if (offset >= (maxWanted.get(k) ?? -1)) done.add(k);
          if (done.size >= want.size) finish();
        },
      })
      .catch(reject);
    // seek each partition to its lowest wanted offset (after run(): kafkajs applies it on the next fetch)
    for (const [k, offsets] of want) {
      const topic = k.slice(0, k.lastIndexOf(':'));
      const partition = Number(k.slice(k.lastIndexOf(':') + 1));
      consumer.seek({ topic, partition, offset: String(Math.min(...offsets)) });
    }
  }).finally(() => consumer.disconnect().catch(() => {}));
  for (const [k, offsets] of want) {
    for (const o of offsets) if (!found.has(`${k}:${o}`)) missing.add(`${k}:${o}`);
  }
  return { found, missing };
}

export interface ReplayResult {
  entries: number;
  replayed: string[];
  failed: { outbox_id: string; error_class: string }[];
  missing: string[];
}

export interface ReplayOptions {
  groupId: string;
  handler: EventHandler;
  kafka?: Kafka;
  processed?: ProcessedStore;
  topicPrefix?: string;
  retries?: number;
  backoff?: { initialMs: number; maxMs: number };
  sleep?: (ms: number) => Promise<void>;
  /** Only these outbox ids. */
  only?: string[];
  /** List what would be replayed; run nothing, write nothing. */
  dryRun?: boolean;
  timeoutMs?: number;
}

/** Reruns the handler for the group's live DLQ entries; a success writes a tombstone, a failure a fresh record. */
export async function replayFromDlq(opts: ReplayOptions): Promise<ReplayResult> {
  const kafka = opts.kafka ?? createKafka({ clientId: `dlq-replay-${opts.groupId}` });
  const prefix = opts.topicPrefix ?? '';
  const processed = opts.processed ?? createMemoryProcessedStore();
  const retries = opts.retries ?? 5;
  const backoff = opts.backoff ?? { initialMs: 200, maxMs: 3_000 };
  const sleep = opts.sleep ?? realSleep;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const dlqTopic = `${prefix}${dlqTopicName(opts.groupId)}`;

  let entries = await readDeadLetters(opts.groupId, { kafka, topicPrefix: prefix, timeoutMs });
  if (opts.only) {
    const only = new Set(opts.only);
    entries = entries.filter((e) => only.has(e.outbox_id));
  }
  const result: ReplayResult = { entries: entries.length, replayed: [], failed: [], missing: [] };
  if (opts.dryRun || entries.length === 0) return result;

  const { found: originals, missing } = await fetchOriginals(
    kafka,
    entries,
    `${prefix}dlq-fetch-${opts.groupId}-${Math.random().toString(36).slice(2, 8)}`,
    timeoutMs,
  );
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    maxInFlightRequests: 1,
    retry: { retries: 3 },
  });
  await producer.connect();
  try {
    for (const entry of entries) {
      const key = `${entry.topic}:${entry.partition}:${entry.offset}`;
      const original = missing.has(key) ? undefined : originals.get(key);
      if (!original) {
        // retention took it, or the entry points nowhere: reported, and the DLQ entry stays (never tombstoned)
        result.missing.push(entry.outbox_id);
        continue;
      }
      let decoded;
      try {
        decoded = decodeMessage({
          key: original.key,
          value: original.value,
          headers: original.headers,
        });
      } catch (err) {
        result.failed.push({ outbox_id: entry.outbox_id, error_class: errorClassOf(err) });
        continue;
      }
      let lastError = '';
      let ok = false;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          let marked = false;
          const markProcessed = async (q?: ProcessedQueryable): Promise<void> => {
            if (q) {
              if (!processed.markProcessedWith) {
                throw new ConsumerConfigurationError(
                  'ctx.markProcessed(tx) needs a processed store with markProcessedWith',
                );
              }
              await processed.markProcessedWith(q, opts.groupId, entry.outbox_id);
            } else {
              await processed.markProcessed(opts.groupId, entry.outbox_id);
            }
            marked = true;
          };
          await opts.handler(decoded, {
            groupId: opts.groupId,
            topic: entry.topic,
            partition: entry.partition,
            offset: entry.offset,
            attempt,
            markProcessed,
          });
          if (!marked) await processed.markProcessed(opts.groupId, entry.outbox_id);
          ok = true;
          break;
        } catch (err) {
          if (err instanceof ConsumerConfigurationError) throw err;
          lastError = errorClassOf(err);
          if (attempt < retries)
            await sleep(Math.min(backoff.maxMs, backoff.initialMs * 2 ** (attempt - 1)));
        }
      }
      if (ok) {
        await producer.send({
          topic: dlqTopic,
          acks: -1,
          messages: [{ key: entry.outbox_id, value: null }],
        });
        result.replayed.push(entry.outbox_id);
      } else {
        const again: DeadLetter = {
          ...entry,
          attempts: entry.attempts + retries,
          error_class: lastError,
          failed_at: new Date().toISOString(),
        };
        await producer.send({
          topic: dlqTopic,
          acks: -1,
          messages: [
            {
              key: entry.outbox_id,
              value: JSON.stringify(again),
              headers: { [HEADER_OUTBOX_ID]: entry.outbox_id },
            },
          ],
        });
        result.failed.push({ outbox_id: entry.outbox_id, error_class: lastError });
      }
    }
  } finally {
    await producer.disconnect().catch(() => {});
  }
  return result;
}
