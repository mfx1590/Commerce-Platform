// Replay from the dead-letter queue (issue #533).
//
// readDeadLetters(groupId) reads `dlq.<groupId>` from the beginning and keeps the latest record per outbox id
// (a null value is a tombstone: the entry was replayed successfully). replayFromDlq re-fetches every original
// message by (topic, partition, offset), runs the handler with the same retries, and writes a tombstone on
// success; a failure writes a fresh record (attempts + 1) so the entry stays visible.
import type { Kafka, KafkaMessage } from 'kafkajs';
import {
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

/** Every message of a topic up to its current high watermarks (bounded by `timeoutMs`). */
async function readTopicToEnd(
  kafka: Kafka,
  topic: string,
  groupId: string,
  timeoutMs: number,
): Promise<KafkaMessage[]> {
  const admin = kafka.admin();
  await admin.connect();
  let total: number;
  try {
    const offsets = await admin.fetchTopicOffsets(topic);
    total = offsets.reduce((n, p) => n + (Number(p.high) - Number(p.low)), 0);
  } finally {
    await admin.disconnect();
  }
  const out: KafkaMessage[] = [];
  if (total === 0) return out;
  const consumer = kafka.consumer({ groupId, sessionTimeout: 10_000 });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`read ${out.length} of ${total} message(s) of ${topic} within ${timeoutMs} ms`),
        ),
      timeoutMs,
    );
    consumer
      .run({
        eachMessage: async ({ message }) => {
          out.push(message);
          if (out.length >= total) {
            clearTimeout(timer);
            resolve();
          }
        },
      })
      .catch(reject);
  }).finally(() => consumer.disconnect().catch(() => {}));
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
                throw new Error(
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
