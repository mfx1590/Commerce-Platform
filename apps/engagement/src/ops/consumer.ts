// The ops-alerts consumer: bus -> rules -> rate limit -> transport.
//
// Group `engagement.ops`, built on the events-v1 consumer SDK (#533). The SDK gives us at-least-once delivery,
// retries, `dlq.engagement.ops` for a poison message, and skipping of unknown topics and newer versions.
//
// EXACTLY WHAT IS GUARANTEED, because a Slack post is not transactional:
//
//   * A REDELIVERED message sends nothing. The SDK checks the shared `consumer_processed` table (db 0202,
//     group `engagement.ops`, key = outbox id) before it runs the handler, so a rebalance, a restart or a
//     replay of a message this group already finished is a no-op. That is the dedupe #553 asks for.
//   * A CRASH BETWEEN the post and the mark can repeat one alert. The post is a network call and cannot join
//     the transaction that writes the mark, so the order is: post, then mark. The other order (mark first)
//     would LOSE the alert on the same crash, and a duplicate ops alert is cheap while a missing one is the
//     incident nobody hears about. This is the deliberate difference from apps/notifications, which must never
//     send a second e-mail and therefore never retries a stuck row.
//   * THE SDK WRITES THE MARK, not this handler. `createConsumer` marks through the processed store after a
//     handler returns without throwing (`if (!marked) await processed.markProcessed(...)`), which is exactly
//     post-then-mark. `ctx.markProcessed(tx)` exists for a handler whose side effects are DATABASE writes, so
//     the mark commits with them; ours is an HTTP post, so there is no transaction for it to join and calling
//     the store ourselves would only add a second INSERT of the same row (#562 review).
//
// The mark is written through the organization-scoped client: `consumer_processed` is RLS kind
// `organization_only`, so a store-scoped session would read and write none of it, and `organization_id`
// defaults to the session's organization (the SDK's two-column INSERT is enough).

import type { ScopedClient } from '@platform/db';
import {
  createConsumer,
  createPgProcessedStore,
  errorClassOf,
  type createKafka,
  type EventConsumer,
  type EventEnvelopeV1Base,
} from '@platform/events';

/** kafkajs is not a dependency of this app: the client type comes from the SDK's own factory. */
export type Kafka = ReturnType<typeof createKafka>;
import type { Alert, EngagementLogLine } from '../types.js';
import type { AlertTransport } from '../transport/types.js';
import { createRateLimiter, rateLimitKey, type RateLimiter } from './rate-limit.js';
import { evaluateRules, OPS_RULES, ruleTopics, type Rule } from './rules.js';
import { createStoreCodes, type StoreCodes } from './store-codes.js';

export const OPS_GROUP_ID = 'engagement.ops';
/** The shared processed table (packages/db 0202). Every Phase 4 consumer group writes its own rows here. */
export const PROCESSED_TABLE = 'consumer_processed';

export interface OpsConsumerOptions {
  /** Organization-scoped client on the `platform_app` role (RLS applies). */
  hq: ScopedClient;
  transport: AlertTransport;
  rateLimit: { max: number; windowMs: number };
  rules?: readonly Rule[];
  kafka?: Kafka;
  /** Test seam: prefixes both the event topics and the DLQ, so a live test is self-contained. */
  topicPrefix?: string;
  retries?: number;
  log?: (line: EngagementLogLine) => void;
  /** Test seam, forwarded to the rate limiter. */
  now?: () => number;
  /** Test seam: start at the latest offset instead of the beginning. */
  fromBeginning?: boolean;
  /**
   * The consumer group, for a one-off run that must not disturb the real one (#594, Integration 4): a
   * FRESH group re-reads the topics from the beginning without touching the live group's offsets or its
   * marks. Default: the module's own constant. Must match the `consumer_processed.group_id` CHECK.
   */
  groupId?: string;
  /** Per-batch hook, used by the drain mode to tell "still arriving" from "idle". */
  onBatch?: (batch: { topic: string; partition: number; first: string; last: string }) => void;
}

export interface OpsConsumer {
  readonly groupId: string;
  readonly dlqTopic: string;
  readonly sent: number;
  readonly suppressed: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Builds the alerts one event produces, applies the rate limit and sends them. Exported on its own so a test
 * (and a future replay from the DLQ) can drive the whole decision path without a broker.
 */
export async function handleEvent(args: {
  envelope: EventEnvelopeV1Base;
  outboxId: string;
  storeCodes: StoreCodes;
  limiter: RateLimiter;
  transport: AlertTransport;
  rules?: readonly Rule[];
  log?: (line: EngagementLogLine) => void;
}): Promise<{ sent: Alert[]; suppressed: number }> {
  const storeCode = await args.storeCodes.codeFor(args.envelope.store_id);
  const alerts = evaluateRules(
    { envelope: args.envelope, outboxId: args.outboxId, storeCode },
    args.rules ?? OPS_RULES,
  );
  const sent: Alert[] = [];
  let suppressed = 0;

  for (const alert of alerts) {
    const decision = args.limiter.check(rateLimitKey(alert.rule, alert.storeCode));
    if (!decision.allowed) {
      suppressed += 1;
      args.log?.({
        service: 'engagement',
        module: 'ops',
        event: 'alert_suppressed',
        rule: alert.rule,
        store_code: alert.storeCode,
        topic: alert.topic,
        outbox_id: alert.outboxId,
        suppressed: decision.suppressed,
      });
      continue;
    }
    const toSend: Alert = { ...alert, suppressed: decision.suppressed };
    await args.transport.send(toSend);
    sent.push(toSend);
    args.log?.({
      service: 'engagement',
      module: 'ops',
      event: 'alert_sent',
      rule: toSend.rule,
      severity: toSend.severity,
      store_code: toSend.storeCode,
      topic: toSend.topic,
      outbox_id: toSend.outboxId,
      suppressed: toSend.suppressed,
    });
  }
  return { sent, suppressed };
}

export function createOpsConsumer(opts: OpsConsumerOptions): OpsConsumer {
  const groupId = opts.groupId ?? OPS_GROUP_ID;
  const rules = opts.rules ?? OPS_RULES;
  const limiter = createRateLimiter({
    ...opts.rateLimit,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const storeCodes = createStoreCodes(opts.hq);
  const processed = createPgProcessedStore(opts.hq, PROCESSED_TABLE);
  let sent = 0;
  let suppressed = 0;

  const consumer: EventConsumer = createConsumer({
    groupId,
    topics: ruleTopics(rules),
    processed,
    ...(opts.kafka ? { kafka: opts.kafka } : {}),
    ...(opts.topicPrefix === undefined ? {} : { topicPrefix: opts.topicPrefix }),
    ...(opts.retries === undefined ? {} : { retries: opts.retries }),
    ...(opts.fromBeginning === undefined ? {} : { fromBeginning: opts.fromBeginning }),
    ...(opts.onBatch ? { onBatch: opts.onBatch } : {}),
    handler: async ({ envelope, outboxId }) => {
      const r = await handleEvent({
        envelope,
        outboxId,
        storeCodes,
        limiter,
        transport: opts.transport,
        rules,
        ...(opts.log ? { log: opts.log } : {}),
      });
      sent += r.sent.length;
      suppressed += r.suppressed;
      // No mark here: the SDK writes it after this handler returns. See the file header.
    },
    log: (line) => {
      if (line.event === 'duplicate') {
        opts.log?.({
          service: 'engagement',
          module: 'ops',
          event: 'duplicate',
          ...(line.event_topic === undefined ? {} : { topic: line.event_topic }),
          ...(line.outbox_id === undefined ? {} : { outbox_id: line.outbox_id }),
          group_id: line.group_id,
        });
      }
      if (line.event === 'dead_lettered') {
        opts.log?.({
          service: 'engagement',
          module: 'ops',
          event: 'alert_failed',
          ...(line.event_topic === undefined ? {} : { topic: line.event_topic }),
          ...(line.outbox_id === undefined ? {} : { outbox_id: line.outbox_id }),
          group_id: line.group_id,
          ...(line.error_class === undefined ? {} : { error_class: line.error_class }),
        });
      }
    },
  });

  return {
    groupId,
    dlqTopic: consumer.dlqTopic,
    get sent() {
      return sent;
    },
    get suppressed() {
      return suppressed;
    },
    async start() {
      await storeCodes.warm();
      await consumer.start();
      opts.log?.({
        service: 'engagement',
        module: 'ops',
        event: 'started',
        group_id: OPS_GROUP_ID,
        transport: opts.transport.name,
      });
    },
    async stop() {
      await consumer.stop();
      opts.log?.({
        service: 'engagement',
        module: 'ops',
        event: 'stopped',
        group_id: OPS_GROUP_ID,
      });
    },
  };
}

export { errorClassOf };
