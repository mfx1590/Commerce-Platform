// DLQ depth watch (#553): every consumer group's dead-letter queue, against a threshold from config.
//
// A dead letter means a message that failed every retry and was parked so the partition could continue — the
// one failure mode of the bus that is otherwise completely silent. `readDeadLetters` returns the LIVE entries
// of `dlq.<group>` (tombstoned ones, replayed successfully, are already gone), so its length IS the depth.
//
// A poll, not a consumer: the DLQ is compacted and read from the beginning, so there is no offset to keep and
// nothing to dedupe on. The rate limiter keeps a standing backlog from alerting every poll — a group stuck at
// 7 entries announces itself once per window, not every `ENGAGEMENT_DLQ_POLL_MS`.

import { readDeadLetters, type DeadLetter } from '@platform/events';
import type { Alert, EngagementLogLine } from '../types.js';
import type { AlertTransport } from '../transport/types.js';
import { rateLimitKey, type RateLimiter } from './rate-limit.js';

/** The reader seam: the real `readDeadLetters`, or a fake in a test with no broker. */
export type DeadLetterReader = (groupId: string) => Promise<DeadLetter[]>;

export const DLQ_RULE = 'dlq-depth';
/** Not an event topic — the pseudo-topic a poll alert reports, so `Alert.topic` is never empty-looking. */
export const DLQ_PSEUDO_TOPIC = 'engagement.dlq-watch';

export interface DlqWatchOptions {
  /** Consumer groups to watch, e.g. `['engagement.ops', 'accounting', 'engagement.cdp']`. */
  groups: readonly string[];
  /** Alert when the live depth is >= this. Must be >= 1. */
  threshold: number;
  organizationId: string;
  read?: DeadLetterReader;
  now?: () => string;
  log?: (line: EngagementLogLine) => void;
}

/**
 * One pass over every group. Returns the alerts the threshold produced — the caller rate-limits and sends them,
 * so this function stays pure enough to test with a fake reader.
 *
 * A group whose DLQ cannot be read (topic absent because the group never dead-lettered anything, broker down)
 * is reported as depth 0 and logged, never an alert and never a throw: the watch must not become the thing
 * that takes the service down.
 */
export async function pollDeadLetters(opts: DlqWatchOptions): Promise<Alert[]> {
  if (!Number.isInteger(opts.threshold) || opts.threshold < 1) {
    throw new Error(`dlq watch: threshold must be an integer >= 1 (got ${opts.threshold})`);
  }
  const read = opts.read ?? ((groupId: string) => readDeadLetters(groupId));
  const now = opts.now ?? (() => new Date().toISOString());
  const alerts: Alert[] = [];

  for (const groupId of opts.groups) {
    let entries: DeadLetter[];
    try {
      entries = await read(groupId);
    } catch (err) {
      opts.log?.({
        service: 'engagement',
        module: 'ops',
        event: 'dlq_poll',
        group_id: groupId,
        depth: 0,
        threshold: opts.threshold,
        error_class: err instanceof Error ? err.name : 'Error',
      });
      continue;
    }
    const depth = entries.length;
    opts.log?.({
      service: 'engagement',
      module: 'ops',
      event: 'dlq_poll',
      group_id: groupId,
      depth,
      threshold: opts.threshold,
    });
    if (depth < opts.threshold) continue;

    // The error CLASSES present, counted. The DLQ carries no payload, so this is all there is to say — and all
    // an operator needs to tell "one poison message retried" from "the downstream API is down".
    const byClass = new Map<string, number>();
    for (const e of entries) byClass.set(e.error_class, (byClass.get(e.error_class) ?? 0) + 1);
    const classes = [...byClass.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => `${name}=${n}`)
      .join(' ');
    const topics = [...new Set(entries.map((e) => e.event_topic))].sort().join(',');

    alerts.push({
      rule: DLQ_RULE,
      severity: 'critical',
      title: `Dead letters piling up in ${groupId}`,
      fields: {
        group: groupId,
        depth,
        threshold: opts.threshold,
        error_classes: classes,
        event_topics: topics,
      },
      organizationId: opts.organizationId,
      storeId: null,
      // The depth is a property of the group, not of a store; the rate-limit key is therefore per group.
      storeCode: groupId,
      topic: DLQ_PSEUDO_TOPIC,
      outboxId: '',
      occurredAt: now(),
      suppressed: 0,
    });
  }
  return alerts;
}

/** A poll plus the rate limit and the transport — what the `once` script and the interval both call. */
export async function runDlqWatch(
  opts: DlqWatchOptions & { limiter: RateLimiter; transport: AlertTransport },
): Promise<{ sent: Alert[]; suppressed: number }> {
  const alerts = await pollDeadLetters(opts);
  const sent: Alert[] = [];
  let suppressed = 0;
  for (const alert of alerts) {
    const decision = opts.limiter.check(rateLimitKey(alert.rule, alert.storeCode));
    if (!decision.allowed) {
      suppressed += 1;
      opts.log?.({
        service: 'engagement',
        module: 'ops',
        event: 'alert_suppressed',
        rule: alert.rule,
        group_id: alert.storeCode,
        suppressed: decision.suppressed,
      });
      continue;
    }
    const toSend: Alert = { ...alert, suppressed: decision.suppressed };
    await opts.transport.send(toSend);
    sent.push(toSend);
    opts.log?.({
      service: 'engagement',
      module: 'ops',
      event: 'alert_sent',
      rule: toSend.rule,
      severity: toSend.severity,
      group_id: toSend.storeCode,
      depth: Number(toSend.fields.depth),
      threshold: opts.threshold,
      suppressed: toSend.suppressed,
    });
  }
  return { sent, suppressed };
}
