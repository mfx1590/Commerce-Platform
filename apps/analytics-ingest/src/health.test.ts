// #641 items 2 and 3, without a broker: a fake kafkajs consumer whose instrumentation events the test fires, so the
// health verdict is checked against every state the real consumer can be in; and the DLQ topic createIngest derives.
import type { Kafka } from 'kafkajs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { healthAnswer } from './health.js';
import { createIngest, healthVerdict } from './ingest.js';
import { FakeRawEvents } from './testing/fakes.js';

const EVENTS = {
  GROUP_JOIN: 'consumer.group_join',
  FETCH: 'consumer.fetch',
  REBALANCING: 'consumer.rebalancing',
  CRASH: 'consumer.crash',
  STOP: 'consumer.stop',
  DISCONNECT: 'consumer.disconnect',
} as const;

function fakeKafka() {
  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const consumer = {
    events: EVENTS,
    on(event: string, fn: (e: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => undefined;
    },
  };
  const kafka = { consumer: () => consumer } as unknown as Kafka;
  const fire = (event: keyof typeof EVENTS, payload: unknown = {}) =>
    (handlers.get(EVENTS[event]) ?? []).forEach((fn) => fn({ payload }));
  return { kafka, fire };
}

const config = (groupId = 'analytics.raw', topicPrefix = '') => ({
  groupId,
  topicPrefix,
  batchSize: 10,
  flushMs: 100,
  concurrency: 1,
});
const silent = () => undefined;
const STALE = 60_000;

describe('readiness (#641 item 2): the consumer events behind the verdict', () => {
  it('is not ready before the group join, ready right after it', () => {
    const { kafka, fire } = fakeKafka();
    const ingest = createIngest({
      config: config(),
      kafka,
      sink: new FakeRawEvents(),
      log: silent,
    });
    expect(ingest.health(STALE)).toMatchObject({
      ready: false,
      joined: false,
      progress_age_ms: null,
    });
    fire('GROUP_JOIN');
    expect(ingest.health(STALE)).toMatchObject({
      ready: true,
      joined: true,
      last_commit_age_ms: null,
    });
  });

  it('a quiet bus stays ready: every completed fetch is progress (an idle consumer fetches every few seconds)', () => {
    const { kafka, fire } = fakeKafka();
    const ingest = createIngest({
      config: config(),
      kafka,
      sink: new FakeRawEvents(),
      log: silent,
    });
    fire('GROUP_JOIN');
    const later = Date.now() + STALE + 5_000;
    expect(ingest.health(STALE, later).ready).toBe(false); // nothing since the join: the fetch loop stopped
    fire('FETCH', { numberOfBatches: 0 }); // kafkajs 2 always reports 0
    expect(ingest.health(STALE).ready).toBe(true);
  });

  it.each(['REBALANCING', 'CRASH', 'STOP', 'DISCONNECT'] as const)(
    'leaving the group (%s) is not ready until the next join',
    (event) => {
      const { kafka, fire } = fakeKafka();
      const ingest = createIngest({
        config: config(),
        kafka,
        sink: new FakeRawEvents(),
        log: silent,
      });
      fire('GROUP_JOIN');
      fire(event);
      expect(ingest.health(STALE)).toMatchObject({ ready: false, joined: false });
      fire('GROUP_JOIN');
      expect(ingest.health(STALE).ready).toBe(true);
    },
  );
});

describe('healthVerdict (#641 item 2): every state', () => {
  const NOW = 1_000_000;
  const base = {
    joined: true,
    stopping: false,
    lastProgressAt: NOW - 1_000,
    lastBatchAt: null,
    inFlightSince: [] as number[],
  };

  it('ready: joined, recent progress, nothing in flight too long', () => {
    expect(healthVerdict(base, STALE, NOW)).toEqual({
      ready: true,
      joined: true,
      progress_age_ms: 1_000,
      last_commit_age_ms: null,
      oldest_in_flight_ms: null,
    });
    expect(healthVerdict({ ...base, inFlightSince: [NOW - 2_000] }, STALE, NOW).ready).toBe(true);
  });

  it('a batch in flight longer than the window is NOT ready, even while fetches keep coming', () => {
    const h = healthVerdict(
      { ...base, lastProgressAt: NOW, inFlightSince: [NOW - 500, NOW - STALE - 1] },
      STALE,
      NOW,
    );
    expect(h).toMatchObject({ ready: false, joined: true, oldest_in_flight_ms: STALE + 1 });
  });

  it('no progress within the window is not ready; exactly at the window still is', () => {
    expect(healthVerdict({ ...base, lastProgressAt: NOW - STALE - 1 }, STALE, NOW).ready).toBe(
      false,
    );
    expect(healthVerdict({ ...base, lastProgressAt: NOW - STALE }, STALE, NOW).ready).toBe(true);
  });

  it('not joined, stopping, or never any progress: not ready', () => {
    expect(healthVerdict({ ...base, joined: false }, STALE, NOW).ready).toBe(false);
    expect(healthVerdict({ ...base, stopping: true }, STALE, NOW).ready).toBe(false);
    expect(healthVerdict({ ...base, lastProgressAt: null }, STALE, NOW).ready).toBe(false);
  });

  it('reports the last commit age beside the verdict', () => {
    expect(healthVerdict({ ...base, lastBatchAt: NOW - 42 }, STALE, NOW).last_commit_age_ms).toBe(
      42,
    );
  });
});

describe('GET /health', () => {
  const health = (ready: boolean) => ({
    ready,
    joined: ready,
    progress_age_ms: 1_000,
    last_commit_age_ms: null,
    oldest_in_flight_ms: null,
  });

  it('200 with the verdict while ready, 503 while not; any other path is a 404', () => {
    expect(healthAnswer('/health', 'analytics.raw', health(true))).toEqual({
      status: 200,
      body: JSON.stringify({ ok: true, group_id: 'analytics.raw', ...health(true) }),
    });
    const down = healthAnswer('/health', 'analytics.raw', health(false));
    expect(down.status).toBe(503);
    expect(JSON.parse(down.body)).toMatchObject({ ok: false, joined: false });
    expect(healthAnswer('/metrics', 'analytics.raw', health(true)).status).toBe(404);
  });
});

describe('the DLQ follows the group (#641 item 3)', () => {
  it('createIngest derives <prefix>dlq.<group>, the same name loadConfig derives', () => {
    const { kafka } = fakeKafka();
    const ingest = createIngest({
      config: config('analytics.replay', 't-ab12.'),
      kafka,
      sink: new FakeRawEvents(),
      log: silent,
    });
    expect(ingest.dlqTopic).toBe('t-ab12.dlq.analytics.replay');
    const loaded = loadConfig(
      { ANALYTICS_GROUP_ID: 'analytics.replay', ANALYTICS_TOPIC_PREFIX: 't-ab12.' },
      [],
    );
    expect(ingest.dlqTopic).toBe(loaded.dlqTopic);
  });

  it('a group name the SDK refuses is refused by createIngest too', () => {
    const { kafka } = fakeKafka();
    expect(() =>
      createIngest({
        config: config('no spaces allowed'),
        kafka,
        sink: new FakeRawEvents(),
        log: silent,
      }),
    ).toThrow();
  });
});
