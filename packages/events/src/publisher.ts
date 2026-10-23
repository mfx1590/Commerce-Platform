// The producer side of the bus (issue #531), behind a narrow interface so apps never import kafkajs.
import { Partitioners, type Kafka, type Producer } from 'kafkajs';
import type { RelayMessage } from './relay-message.js';
import type { TopicAdmin } from './topics.js';

/** What the relay needs from a producer: ordered, acknowledged delivery to one topic per call. */
export interface MessagePublisher {
  /** Resolves once every message is acknowledged by the broker (acks = all); rejects when any is not. */
  send(topic: string, messages: RelayMessage[]): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface KafkaPublisherOptions {
  /** Attempts per send before it rejects (bounded on purpose: a down broker must fail the pass, not hang it). */
  retries?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
}

/**
 * kafkajs producer with the relay's settings: acks = all, one request in flight (per-partition order survives
 * retries), no auto topic creation (the dev container would mint 1-partition/7-day topics), bounded retries.
 * Not the idempotent producer: it insists on unbounded retries, and the outbox id header already gives every
 * consumer exact-once semantics on top of at-least-once delivery.
 */
export function createKafkaPublisher(
  kafka: Kafka,
  opts: KafkaPublisherOptions = {},
): MessagePublisher {
  const producer: Producer = kafka.producer({
    allowAutoTopicCreation: false,
    idempotent: false,
    maxInFlightRequests: 1,
    createPartitioner: Partitioners.DefaultPartitioner,
    retry: { retries: opts.retries ?? 3, initialRetryTime: 300 },
  });
  return {
    async send(topic, messages) {
      await producer.send({
        topic,
        acks: -1,
        timeout: opts.requestTimeoutMs ?? 30_000,
        messages: messages.map((m) => ({ key: m.key, value: m.value, headers: m.headers })),
      });
    },
    connect: () => producer.connect(),
    disconnect: () => producer.disconnect(),
  };
}

/** Throws, naming them, when any of `topics` is missing on the broker. The relay calls this before its first pass. */
export async function assertTopicsPresent(
  admin: Pick<TopicAdmin, 'listTopics'>,
  topics: readonly string[],
): Promise<void> {
  const existing = new Set(await admin.listTopics());
  const missing = topics.filter((t) => !existing.has(t));
  if (missing.length > 0) {
    throw new Error(
      `missing topic(s) on the broker: ${missing.join(', ')} — run infra/redpanda/create-topics.mjs first`,
    );
  }
}
