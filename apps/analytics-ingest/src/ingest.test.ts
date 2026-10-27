// processBatch without a broker: the order "insert acknowledged AND dead letters written → commit", what happens
// when either fails, and exactly-once in effect (a replay and a crash between insert and commit both fold).
import { createValidator, type EventEnvelopeV1Base } from '@platform/events';
import { describe, expect, it } from 'vitest';
import { createBatcher } from './batcher.js';
import { processBatch, SimulatedCrash, type BatchDeps } from './ingest.js';
import type { RawEventRow, WireBatch } from './rows.js';
import { FakeDlq, FakeRawEvents, toWire } from './testing/fakes.js';
import { generateMonth } from './testing/month.js';

const validator = createValidator();
const month = generateMonth({ perKey: 5 });

function harness(opts: { batchSize?: number } = {}) {
  const clickhouse = new FakeRawEvents();
  const dlq = new FakeDlq();
  const trail: string[] = [];
  const commits: { topic: string; partition: number; offset: string }[] = [];
  clickhouse.onInsert = (rows) => trail.push(`insert:${rows.length}`);
  const batcher = createBatcher<RawEventRow>({
    sink: clickhouse,
    batchSize: opts.batchSize ?? 1,
    flushMs: 5,
  });
  let tick = 0;
  const deps: BatchDeps = {
    groupId: 'analytics.raw',
    batcher,
    dlq,
    validator,
    // a later ingested_at on every call, as on a real clock
    now: () => new Date(Date.parse('2026-10-25T09:00:00Z') + tick++),
    // #623: erasures are recorded here (the real handler is exercised in erasure.test.ts)
    erase: async (c) => {
      trail.push(`erase:${c.eventId}`);
    },
    commit: async (topic, partition, offset) => {
      trail.push(`commit:${offset}`);
      commits.push({ topic, partition, offset });
    },
  };
  return { clickhouse, dlq, trail, commits, deps };
}

function batchOf(events: readonly EventEnvelopeV1Base[], from = 0): WireBatch {
  return {
    topic: 'order.placed',
    partition: 0,
    messages: events.map((e, i) => toWire(e, from + i)),
  };
}

describe('processBatch', () => {
  it('commits the next offset only after ClickHouse acknowledged the insert', async () => {
    const h = harness({ batchSize: 3 });
    const r = await processBatch(batchOf(month.events.slice(0, 3), 40), h.deps);
    expect(h.trail).toEqual(['insert:3', 'commit:43']);
    expect(r).toMatchObject({ rows: 3, dead: 0, committed: '43' });
  });

  it('commits nothing when the insert fails (the batch is redelivered)', async () => {
    const h = harness();
    h.clickhouse.failNext = new Error('connect ECONNREFUSED');
    await expect(processBatch(batchOf(month.events.slice(0, 1)), h.deps)).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(h.commits).toEqual([]);
  });

  it('commits nothing when the dead letter cannot be written', async () => {
    const h = harness();
    h.dlq.failNext = new Error('broker down');
    const bad = { ...month.events[0]!, version: 99 } as EventEnvelopeV1Base;
    await expect(processBatch(batchOf([month.events[1]!, bad]), h.deps)).rejects.toThrow(
      'broker down',
    );
    expect(h.commits).toEqual([]);
  });

  it('inserts the valid events, dead-letters the rest, then commits past both', async () => {
    const h = harness({ batchSize: 2 });
    const unknown = { ...month.events[0]!, version: 99 } as EventEnvelopeV1Base;
    const r = await processBatch(
      batchOf([month.events[0]!, unknown, month.events[1]!], 10),
      h.deps,
    );
    expect(r).toMatchObject({ rows: 2, dead: 1, committed: '13' });
    expect(h.clickhouse.countFinal).toBe(2);
    expect(h.dlq.letters.map((l) => [l.offset, l.error_class])).toEqual([
      ['11', 'UnknownEventError'],
    ]);
  });

  it('a replay of the same batch changes no count() FINAL (ReplacingMergeTree on (topic, event_id))', async () => {
    const h = harness({ batchSize: 50 });
    const events = month.events.slice(0, 50);
    await processBatch(batchOf(events), h.deps);
    const before = h.clickhouse.countFinal;
    await processBatch(batchOf(events), h.deps);
    expect(before).toBe(50);
    expect(h.clickhouse.countRaw).toBe(100);
    expect(h.clickhouse.countFinal).toBe(before);
  });

  it('a crash between insert and commit duplicates rows that FINAL folds', async () => {
    const h = harness({ batchSize: 10 });
    const events = month.events.slice(0, 10);
    const crashing = {
      ...h.deps,
      onBeforeCommit: () => {
        throw new SimulatedCrash();
      },
    };
    await expect(processBatch(batchOf(events), crashing)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(h.commits).toEqual([]);
    expect(h.clickhouse.countRaw).toBe(10); // inserted, not committed
    // the restarted process gets the same batch again
    await processBatch(batchOf(events), h.deps);
    expect(h.commits.map((c) => c.offset)).toEqual(['10']);
    expect(h.clickhouse.countRaw).toBe(20);
    expect(h.clickhouse.countFinal).toBe(10);
  });

  it('a whole generated month over every topic lands once per (topic, event_id)', async () => {
    const h = harness({ batchSize: 64 });
    const size = 25;
    for (let i = 0; i < month.events.length; i += size) {
      await processBatch(batchOf(month.events.slice(i, i + size), i), h.deps);
    }
    const final = h.clickhouse.final();
    expect(final.length).toBe(month.events.length);
    const perTopic: Record<string, number> = {};
    for (const r of final)
      perTopic[`${r.topic}@${r.version}`] = (perTopic[`${r.topic}@${r.version}`] ?? 0) + 1;
    expect(perTopic).toEqual(month.perKey);
    expect(h.dlq.letters).toEqual([]);
  });

  it('a row ClickHouse would refuse is dead-lettered and the rest of the batch still lands and commits', async () => {
    const h = harness({ batchSize: 2 });
    const bad = {
      ...month.events[2]!,
      occurred_at: '1850-06-01T00:00:00.000Z',
    } as EventEnvelopeV1Base;
    const r = await processBatch(batchOf([month.events[0]!, bad, month.events[1]!], 20), h.deps);
    expect(r).toMatchObject({ rows: 2, dead: 1, committed: '23' });
    expect(h.dlq.letters.map((l) => l.error_class)).toEqual(['InsertRejectedError']);
  });

  it('a customer.erased is applied after its insert is acknowledged and before the commit; without a handler nothing commits', async () => {
    const erased = month.events.find((e) => e.topic === 'customer.erased')!;
    const h = harness({ batchSize: 2 });
    await processBatch(batchOf([month.events[0]!, erased], 5), h.deps);
    expect(h.trail).toEqual(['insert:2', `erase:${erased.event_id}`, 'commit:7']);
    const strict = harness();
    const { erase: _erase, ...noHandler } = strict.deps;
    await expect(processBatch(batchOf([erased], 9), noHandler)).rejects.toThrow(
      'refusing to commit',
    );
    expect(strict.commits).toEqual([]);
  });

  it('an empty batch commits nothing', async () => {
    const h = harness();
    expect(await processBatch({ topic: 't', partition: 0, messages: [] }, h.deps)).toEqual({
      rows: 0,
      dead: 0,
      committed: null,
      byTopic: {},
    });
    expect(h.commits).toEqual([]);
  });
});
