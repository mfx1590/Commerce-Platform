// The DLQ depth watch, with the reader injected: no broker needed. The live side (a real `dlq.*` topic) is
// covered by the broker block in ops/consumer.test.ts.

import type { DeadLetter } from '@platform/events';
import { describe, expect, it, vi } from 'vitest';
import type { Alert } from '../types.js';
import type { AlertTransport } from '../transport/types.js';
import { createRateLimiter } from './rate-limit.js';
import { DLQ_PSEUDO_TOPIC, DLQ_RULE, pollDeadLetters, runDlqWatch } from './dlq-watch.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-10-23T10:00:00.000Z';

function entry(over: Partial<DeadLetter> = {}): DeadLetter {
  return {
    outbox_id: '11111111-1111-4111-8111-111111111111',
    group_id: 'engagement.ops',
    topic: 'payment.failed',
    partition: 0,
    offset: '7',
    event_topic: 'payment.failed',
    event_version: 1,
    attempts: 5,
    error_class: 'TransportError',
    failed_at: NOW,
    ...over,
  };
}

class RecordingTransport implements AlertTransport {
  readonly name = 'recording';
  readonly sent: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }
}

describe('pollDeadLetters', () => {
  it('says nothing while every group is below the threshold', async () => {
    const read = vi.fn(async () => [entry()]);
    const alerts = await pollDeadLetters({
      groups: ['engagement.ops'],
      threshold: 2,
      organizationId: ORG,
      read,
    });
    expect(alerts).toEqual([]);
    expect(read).toHaveBeenCalledWith('engagement.ops');
  });

  it('alerts at the threshold, counting error classes and naming the topics', async () => {
    const read = async () => [
      entry(),
      entry({ outbox_id: '22222222-2222-4222-8222-222222222222' }),
      entry({
        outbox_id: '33333333-3333-4333-8333-333333333333',
        error_class: 'SyntaxError',
        event_topic: 'refund.failed',
      }),
    ];
    const alerts3 = await pollDeadLetters({
      groups: ['engagement.ops'],
      threshold: 3,
      organizationId: ORG,
      read,
      now: () => NOW,
    });

    const alert = alerts3[0]!;
    expect(alert).toMatchObject({
      rule: DLQ_RULE,
      severity: 'critical',
      topic: DLQ_PSEUDO_TOPIC,
      storeId: null,
      storeCode: 'engagement.ops',
      organizationId: ORG,
      outboxId: '',
      occurredAt: NOW,
      suppressed: 0,
    });
    expect(alert.title).toBe('Dead letters piling up in engagement.ops');
    expect(alert.fields).toEqual({
      group: 'engagement.ops',
      depth: 3,
      threshold: 3,
      // Most frequent first, then alphabetical.
      error_classes: 'TransportError=2 SyntaxError=1',
      event_topics: 'payment.failed,refund.failed',
    });
  });

  it('watches several groups independently', async () => {
    const depths: Record<string, number> = {
      'engagement.ops': 0,
      accounting: 4,
      'engagement.cdp': 1,
    };
    const read = async (g: string) =>
      Array.from({ length: depths[g] ?? 0 }, (_, i) =>
        entry({ outbox_id: `0000000${i}-0000-4000-8000-00000000000${i}`, group_id: g }),
      );
    const alerts = await pollDeadLetters({
      groups: ['engagement.ops', 'accounting', 'engagement.cdp'],
      threshold: 2,
      organizationId: ORG,
      read,
    });
    expect(alerts.map((a) => a.fields.group)).toEqual(['accounting']);
    expect(alerts[0]!.fields.depth).toBe(4);
  });

  it('an unreadable DLQ says UNREADABLE, never an alert and never a throw (#646)', async () => {
    const lines: unknown[] = [];
    const read = async (g: string) => {
      if (g === 'accounting') throw new Error('This server does not host this topic-partition');
      return [];
    };
    const alerts = await pollDeadLetters({
      groups: ['engagement.ops', 'accounting'],
      threshold: 1,
      organizationId: ORG,
      read,
      log: (l) => lines.push(l),
    });
    expect(alerts).toEqual([]);
    expect(lines).toEqual([
      {
        service: 'engagement',
        module: 'ops',
        event: 'dlq_poll',
        group_id: 'engagement.ops',
        depth: 0,
        threshold: 1,
      },
      {
        service: 'engagement',
        module: 'ops',
        event: 'dlq_poll',
        group_id: 'accounting',
        // `depth: 0` alone read as "nothing in the queue", which is the opposite of what happened: the
        // depth is UNKNOWN. The flag says so, and the depth stays a number nothing downstream has to
        // special-case (#646).
        depth: 0,
        unreadable: true,
        threshold: 1,
        error_class: 'Error',
      },
    ]);
  });

  it('refuses a threshold that would alert on an empty queue', async () => {
    await expect(
      pollDeadLetters({ groups: ['g'], threshold: 0, organizationId: ORG, read: async () => [] }),
    ).rejects.toThrow(/threshold must be an integer/);
  });
});

describe('runDlqWatch', () => {
  it('sends an alert and rate-limits a standing backlog to once per window', async () => {
    let t = 1_000_000;
    const transport = new RecordingTransport();
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, now: () => t });
    const read = async () => [
      entry(),
      entry({ outbox_id: '22222222-2222-4222-8222-222222222222' }),
    ];
    const args = {
      groups: ['engagement.ops'],
      threshold: 1,
      organizationId: ORG,
      read,
      limiter,
      transport,
      now: () => NOW,
    };

    const first = await runDlqWatch(args);
    expect(first.sent).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);

    // Three more polls in the same window: the backlog is still there, nobody is paged again.
    for (let i = 0; i < 3; i++) await runDlqWatch(args);
    expect(transport.sent).toHaveLength(1);

    // Next window: one alert again, carrying what it dropped.
    t += 60_000;
    const later = await runDlqWatch(args);
    expect(later.sent).toHaveLength(1);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]!.suppressed).toBe(3);
  });

  it('logs the send with the depth and threshold, and the suppression without them', async () => {
    const t = 1_000_000;
    const lines: { event: string; depth?: number; suppressed?: number }[] = [];
    const args = {
      groups: ['engagement.ops'],
      threshold: 1,
      organizationId: ORG,
      read: async () => [entry()],
      limiter: createRateLimiter({ max: 1, windowMs: 60_000, now: () => t }),
      transport: new RecordingTransport(),
      log: (l: { event: string; depth?: number; suppressed?: number }) => lines.push(l),
    };
    await runDlqWatch(args);
    await runDlqWatch(args);

    expect(lines.filter((l) => l.event === 'alert_sent')).toHaveLength(1);
    expect(lines.find((l) => l.event === 'alert_sent')).toMatchObject({ depth: 1, suppressed: 0 });
    expect(lines.find((l) => l.event === 'alert_suppressed')).toMatchObject({ suppressed: 1 });
  });

  it('carries no PII: a DLQ entry has none, and the alert quotes only ids and classes', async () => {
    const transport = new RecordingTransport();
    await runDlqWatch({
      groups: ['engagement.ops'],
      threshold: 1,
      organizationId: ORG,
      read: async () => [entry()],
      limiter: createRateLimiter({ max: 5, windowMs: 60_000 }),
      transport,
    });
    const text = JSON.stringify(transport.sent[0]!);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(Object.keys(transport.sent[0]!.fields).sort()).toEqual([
      'depth',
      'error_classes',
      'event_topics',
      'group',
      'threshold',
    ]);
  });
});
