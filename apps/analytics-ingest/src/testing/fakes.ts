// Test doubles: an in-memory raw_events with ReplacingMergeTree semantics (every insert is kept, as in an
// unmerged part; `countFinal` folds on (topic, event_id) the way `count() FINAL` does), a recording DLQ, and the
// wire form of an envelope as the relay publishes it.
import { envelopeToMessage, type DeadLetter, type EventEnvelopeV1Base } from '@platform/events';
import type { RowSink } from '../batcher.js';
import type { DeadLetterSink } from '../ingest.js';
import type { RawEventRow, WireMessage } from '../rows.js';

export class FakeRawEvents implements RowSink<RawEventRow> {
  readonly parts: RawEventRow[][] = [];
  failNext: Error | null = null;
  onInsert?: (rows: readonly RawEventRow[]) => void;

  async insert(rows: readonly RawEventRow[]): Promise<void> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.parts.push([...rows]);
    this.onInsert?.(rows);
  }

  /** Physical rows: what `count()` without FINAL sees before a merge. */
  get countRaw(): number {
    return this.parts.reduce((n, p) => n + p.length, 0);
  }

  /** `count() FINAL`. */
  get countFinal(): number {
    return this.final().length;
  }

  /** `SELECT * FINAL`: the latest `ingested_at` per (topic, event_id). */
  final(): RawEventRow[] {
    const byKey = new Map<string, RawEventRow>();
    for (const r of this.parts.flat()) {
      const k = `${r.topic}\u0000${r.event_id}`;
      const prev = byKey.get(k);
      if (!prev || prev.ingested_at <= r.ingested_at) byKey.set(k, r);
    }
    return [...byKey.values()];
  }
}

export class FakeDlq implements DeadLetterSink {
  readonly letters: DeadLetter[] = [];
  failNext: Error | null = null;
  async send(letters: readonly DeadLetter[]): Promise<void> {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    this.letters.push(...letters);
  }
}

export function toWire(
  envelope: EventEnvelopeV1Base,
  offset: number,
  publishedAt = Date.parse('2026-10-25T09:00:00.000Z'),
): WireMessage {
  const m = envelopeToMessage(envelope, 'core-outbox-relay/test');
  return {
    key: m.key,
    value: m.value,
    headers: m.headers,
    offset: String(offset),
    timestamp: String(publishedAt),
  };
}
