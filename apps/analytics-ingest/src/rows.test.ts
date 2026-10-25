import { createValidator, type EventEnvelopeV1Base } from '@platform/events';
import { describe, expect, it } from 'vitest';
import { classify, toClickHouseTime } from './rows.js';
import { toWire } from './testing/fakes.js';
import { generateMonth } from './testing/month.js';

const validator = createValidator();
const now = new Date('2026-10-25T09:00:01.500Z');
const ctx = { groupId: 'analytics.raw', validator, now };
const batch = { topic: 'order.placed', partition: 3 };
const month = generateMonth({ perKey: 2 });
const placed = month.events.find((e) => e.topic === 'order.placed')!;

const DEAD_LETTER_KEYS = [
  'attempts',
  'error_class',
  'event_topic',
  'event_version',
  'failed_at',
  'group_id',
  'offset',
  'outbox_id',
  'partition',
  'topic',
].sort();

function mutate(e: EventEnvelopeV1Base, patch: Record<string, unknown>): EventEnvelopeV1Base {
  return { ...e, ...patch } as EventEnvelopeV1Base;
}

describe('classify', () => {
  it('maps a valid envelope to a raw_events row (envelope columns, payload as JSON text, Kafka time as published_at)', () => {
    const c = classify(toWire(placed, 7), batch, ctx);
    expect(c.kind).toBe('row');
    if (c.kind !== 'row') return;
    expect(c.row).toEqual({
      topic: 'order.placed',
      version: placed.version,
      event_id: placed.event_id,
      organization_id: placed.organization_id,
      store_id: placed.store_id,
      aggregate_type: placed.aggregate_type,
      aggregate_id: placed.aggregate_id,
      occurred_at: toClickHouseTime(new Date(placed.occurred_at)),
      published_at: '2026-10-25 09:00:00.000',
      payload: JSON.stringify(placed.payload),
      ingested_at: '2026-10-25 09:00:01.500',
    });
    expect(JSON.parse(c.row.payload)).toEqual(placed.payload);
  });

  it('sends an unknown VERSION of a known topic to the DLQ (the SDK would skip it; the raw store must not)', () => {
    const c = classify(toWire(mutate(placed, { version: 99 }), 8), batch, ctx);
    expect(c.kind).toBe('dead');
    if (c.kind !== 'dead') return;
    expect(c.letter).toMatchObject({
      outbox_id: placed.event_id,
      group_id: 'analytics.raw',
      topic: 'order.placed',
      partition: 3,
      offset: '8',
      event_topic: 'order.placed',
      event_version: 99,
      error_class: 'UnknownEventError',
    });
  });

  it('sends an unknown TOPIC to the DLQ', () => {
    const c = classify(toWire(mutate(placed, { topic: 'order.teleported' }), 9), batch, ctx);
    expect(c.kind === 'dead' && c.letter.error_class).toBe('UnknownEventError');
  });

  it('sends an envelope that fails its schema to the DLQ', () => {
    const bad = mutate(placed, { payload: { ...(placed.payload as object), surprise: 1 } });
    const c = classify(toWire(bad, 10), batch, ctx);
    expect(c.kind === 'dead' && c.letter.error_class).toBe('InvalidEventError');
    const noStore = mutate(placed, { organization_id: 'not-a-uuid' });
    const d = classify(toWire(noStore, 11), batch, ctx);
    expect(d.kind === 'dead' && d.letter.error_class).toBe('InvalidEventError');
  });

  it('sends a message that does not decode to the DLQ, keyed by its outbox_id header', () => {
    const wire = { ...toWire(placed, 12), value: 'not json' };
    const c = classify(wire, batch, ctx);
    expect(c.kind).toBe('dead');
    if (c.kind !== 'dead') return;
    expect(c.letter.error_class).toBe('UndecodableMessageError');
    expect(c.letter.outbox_id).toBe(placed.event_id);
    const noHeader = classify({ value: null, offset: '13', timestamp: '0' }, batch, ctx);
    expect(noHeader.kind === 'dead' && noHeader.letter.outbox_id).toBe(
      'undecodable:order.placed:3:13',
    );
  });

  it('dead letters carry exactly the SDK DeadLetter fields — no payload', () => {
    for (const wire of [
      toWire(mutate(placed, { version: 99 }), 1),
      { ...toWire(placed, 2), value: '{}' },
    ]) {
      const c = classify(wire, batch, ctx);
      if (c.kind !== 'dead') throw new Error('expected a dead letter');
      expect(Object.keys(c.letter).sort()).toEqual(DEAD_LETTER_KEYS);
      expect(JSON.stringify(c.letter)).not.toContain('"payload"');
    }
  });

  it('accepts every topic and version the registry knows (the generated month)', () => {
    const rows = month.events.map((e, i) => classify(toWire(e, i), batch, ctx));
    expect(rows.filter((r) => r.kind === 'dead')).toEqual([]);
    expect(new Set(month.events.map((e) => `${e.topic}@${e.version}`)).size).toBe(
      Object.keys(month.perKey).length,
    );
  });

  it('dead-letters a schema-valid event whose row ClickHouse would refuse (insert_rejected), instead of stalling', () => {
    const farFuture = mutate(placed, { occurred_at: '2400-01-01T00:00:00.000Z' });
    expect(validator.validateEnvelope(farFuture).ok).toBe(true);
    const c = classify(toWire(farFuture, 14), batch, ctx);
    expect(c.kind === 'dead' && c.letter.error_class).toBe('InsertRejectedError');
  });

  it('formats DateTime64 text in UTC with milliseconds', () => {
    expect(toClickHouseTime(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01 00:00:00.000');
    expect(() => toClickHouseTime(new Date('nope'))).toThrow(RangeError);
  });
});
