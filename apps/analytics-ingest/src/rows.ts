// One Kafka message → a `raw_events` row, or a dead letter. Pure: no broker, no ClickHouse.
//
// Unlike the SDK's createConsumer (which logs and SKIPS an unknown topic or a higher version, because a ledger
// has nothing to post for it), the raw store must not lose anything silently (#600): an unknown topic/version,
// an envelope that fails its schema and a message that does not decode all go to `dlq.<group>`, in the SDK's
// `DeadLetter` shape (ids, offsets, the error class — never the payload). A deploy that knows the new version
// replays them from there.
import {
  decodeMessage,
  errorClassOf,
  EVENT_SCHEMAS,
  type DeadLetter,
  type EventEnvelopeV1Base,
  type RawMessage,
  type Validator,
} from '@platform/events';
import { scrubPayload, type ErasureIndex } from './erasure.js';

const KNOWN = new Set(Object.keys(EVENT_SCHEMAS));

/** The columns of `raw_events` (data/clickhouse/migrations/0001_raw_events.sql); DateTime64 as ClickHouse text. */
export interface RawEventRow {
  topic: string;
  version: number;
  event_id: string;
  organization_id: string;
  store_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  published_at: string;
  payload: string;
  ingested_at: string;
}

export interface WireMessage extends RawMessage {
  offset: string;
  /** Kafka message timestamp (ms since epoch, as text): the moment the relay published it. */
  timestamp: string;
}

export interface WireBatch {
  /** The wire topic (prefixed in tests). */
  topic: string;
  partition: number;
  messages: readonly WireMessage[];
}

export class UnknownEventError extends Error {
  constructor(topic: string, version: number) {
    super(`unknown event ${topic}@${version}`);
    this.name = 'UnknownEventError';
  }
}

export class InvalidEventError extends Error {
  constructor(eventId: string, errors: readonly string[]) {
    super(`event ${eventId} failed its schema: ${errors.slice(0, 3).join('; ')}`);
    this.name = 'InvalidEventError';
  }
}

export class UndecodableMessageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UndecodableMessageError';
  }
}

/** DateTime64(3) holds 1900-01-01 … 2299-12-31 23:59:59.999; ClickHouse refuses (or clamps) anything outside. */
const DATETIME64_MIN = Date.UTC(1900, 0, 1);
const DATETIME64_MAX = Date.UTC(2299, 11, 31, 23, 59, 59, 999);

/** `2026-10-25 09:30:00.123`: what a DateTime64(3, 'UTC') column takes in JSONEachRow. */
export function toClickHouseTime(d: Date): string {
  const t = d.getTime();
  if (Number.isNaN(t)) throw new RangeError('invalid date');
  if (t < DATETIME64_MIN || t > DATETIME64_MAX)
    throw new RangeError('date outside the DateTime64(3) range');
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * A schema-valid event whose row ClickHouse would refuse (a timestamp outside DateTime64): dead-lettered before it is
 * buffered, because one such row would fail the whole insert and stall every partition in a restart loop.
 */
export class InsertRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InsertRejectedError';
  }
}

export type Classified =
  | { kind: 'row'; row: RawEventRow; envelope: EventEnvelopeV1Base }
  | { kind: 'dead'; letter: DeadLetter; error: Error };

export function classify(
  message: WireMessage,
  batch: Pick<WireBatch, 'topic' | 'partition'>,
  ctx: { groupId: string; validator: Validator; now: Date; erasures?: ErasureIndex | undefined },
): Classified {
  const dead = (
    err: Error,
    outboxId: string,
    eventTopic: string,
    eventVersion: number,
  ): Classified => ({
    kind: 'dead',
    error: err,
    letter: {
      outbox_id: outboxId,
      group_id: ctx.groupId,
      topic: batch.topic,
      partition: batch.partition,
      offset: message.offset,
      event_topic: eventTopic,
      event_version: eventVersion,
      attempts: 1,
      error_class: errorClassOf(err),
      failed_at: ctx.now.toISOString(),
    },
  });

  let decoded: ReturnType<typeof decodeMessage>;
  try {
    decoded = decodeMessage(message);
  } catch (err) {
    const header = message.headers?.outbox_id;
    const id =
      (Array.isArray(header) ? header[0] : header)?.toString() ??
      `undecodable:${batch.topic}:${batch.partition}:${message.offset}`;
    return dead(new UndecodableMessageError((err as Error).message), id, '?', 0);
  }
  const { envelope, outboxId } = decoded;
  const topic = typeof envelope.topic === 'string' ? envelope.topic : '?';
  const version = typeof envelope.version === 'number' ? envelope.version : 0;

  if (!KNOWN.has(`${topic}@${version}`))
    return dead(new UnknownEventError(topic, version), outboxId, topic, version);
  const check = ctx.validator.validateEnvelope(envelope);
  if (!check.ok)
    return dead(new InvalidEventError(outboxId, check.errors), outboxId, topic, version);

  const publishedMs = Number(message.timestamp);
  let row: RawEventRow;
  try {
    row = {
      topic: envelope.topic,
      version: envelope.version,
      event_id: envelope.event_id,
      organization_id: envelope.organization_id,
      store_id: envelope.store_id,
      aggregate_type: envelope.aggregate_type,
      aggregate_id: envelope.aggregate_id,
      occurred_at: toClickHouseTime(new Date(envelope.occurred_at)),
      published_at: toClickHouseTime(
        Number.isFinite(publishedMs) ? new Date(publishedMs) : ctx.now,
      ),
      // an erased customer's identifiers never reach ClickHouse again, replays included (#623)
      payload: JSON.stringify(
        ctx.erasures && ctx.erasures.size > 0
          ? scrubPayload(
              envelope.payload as unknown as Record<string, unknown>,
              envelope.store_id,
              ctx.erasures,
            ).payload
          : envelope.payload,
      ),
      ingested_at: toClickHouseTime(ctx.now),
    };
  } catch (err) {
    return dead(new InsertRejectedError((err as Error).message), outboxId, topic, version);
  }
  return { kind: 'row', envelope, row };
}
