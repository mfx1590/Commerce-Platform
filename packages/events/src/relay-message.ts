// The wire format on the bus (issue #531): how an outbox row becomes a Kafka message and back.
// Shared by the relay (apps/core/src/outbox/relay.ts), the consumer SDK (#533) and the replay CLI (#534),
// so there is exactly one definition of the key, the headers and the value.
//
//   key     = partitionKey(row): store_id, or organization_id for organization-scope events (per-store order)
//   value   = the envelope JSON (schemas/envelope/v1.json), event_id = the outbox id
//   headers = outbox_id (the idempotency key every consumer dedupes on), event_id, topic, version,
//             organization_id, store_id (absent when null), occurred_at, producer
import type { EventEnvelopeV1Base } from './generated/types.js';
import { partitionKey } from './topics.js';

/** The columns of one `outbox` row as the relay reads them (payload/headers already parsed by pg). */
export type OutboxRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  topic: string;
  version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  headers: unknown;
  occurred_at: string | Date;
};

/** A message as the relay hands it to the producer and as a consumer receives it. */
export interface RelayMessage {
  key: string;
  value: string;
  headers: Record<string, string>;
}

export const HEADER_OUTBOX_ID = 'outbox_id';
export const HEADER_EVENT_ID = 'event_id';
export const HEADER_TOPIC = 'topic';
export const HEADER_VERSION = 'version';
export const HEADER_ORGANIZATION_ID = 'organization_id';
export const HEADER_STORE_ID = 'store_id';
export const HEADER_OCCURRED_AT = 'occurred_at';
export const HEADER_PRODUCER = 'producer';

type Headers = { actor?: EventEnvelopeV1Base['actor']; trace?: EventEnvelopeV1Base['trace'] };

/** Rebuilds the envelope the producer validated when it wrote the row (`toOutboxRow` is the inverse). */
export function outboxRowToEnvelope(row: OutboxRow): EventEnvelopeV1Base {
  const h = (row.headers && typeof row.headers === 'object' ? row.headers : {}) as Headers;
  const trace = h.trace && Object.keys(h.trace).length > 0 ? { trace: h.trace } : {};
  return {
    event_id: row.id,
    topic: row.topic as EventEnvelopeV1Base['topic'],
    version: row.version,
    occurred_at:
      row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    organization_id: row.organization_id,
    store_id: row.store_id,
    aggregate_type: row.aggregate_type as EventEnvelopeV1Base['aggregate_type'],
    aggregate_id: row.aggregate_id,
    actor: h.actor ?? { type: 'system', id: null },
    ...trace,
    payload: row.payload as EventEnvelopeV1Base['payload'],
  };
}

/** The Kafka message for an envelope. `producer` names the process that published (`core-outbox-relay/0.4.1`). */
export function envelopeToMessage(e: EventEnvelopeV1Base, producer: string): RelayMessage {
  const headers: Record<string, string> = {
    [HEADER_OUTBOX_ID]: e.event_id,
    [HEADER_EVENT_ID]: e.event_id,
    [HEADER_TOPIC]: e.topic,
    [HEADER_VERSION]: String(e.version),
    [HEADER_ORGANIZATION_ID]: e.organization_id,
    [HEADER_OCCURRED_AT]: e.occurred_at,
    [HEADER_PRODUCER]: producer,
  };
  if (e.store_id) headers[HEADER_STORE_ID] = e.store_id;
  return { key: partitionKey(e), value: JSON.stringify(e), headers };
}

export interface DecodedMessage {
  envelope: EventEnvelopeV1Base;
  /** The idempotency key: the `outbox_id` header, falling back to the envelope's event_id. */
  outboxId: string;
  headers: Record<string, string>;
}

/** What a consumer received, as `{ key, value, headers }` with Buffers or strings (kafkajs hands Buffers). */
export interface RawMessage {
  key?: Buffer | string | null;
  value?: Buffer | string | null;
  headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined> | undefined;
}

const text = (v: Buffer | string | (Buffer | string)[] | undefined | null): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return text(v[0]);
  return typeof v === 'string' ? v : v.toString('utf8');
};

/** Parses a received message. Throws on a missing or non-JSON value; a consumer treats that as a poison message. */
export function decodeMessage(m: RawMessage): DecodedMessage {
  const value = text(m.value);
  if (value === undefined) throw new Error('message has no value');
  let envelope: EventEnvelopeV1Base;
  try {
    envelope = JSON.parse(value) as EventEnvelopeV1Base;
  } catch {
    throw new Error('message value is not JSON');
  }
  if (!envelope || typeof envelope !== 'object' || typeof envelope.event_id !== 'string') {
    throw new Error('message value is not an event envelope');
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.headers ?? {})) {
    const s = text(v);
    if (s !== undefined) headers[k] = s;
  }
  return { envelope, outboxId: headers[HEADER_OUTBOX_ID] ?? envelope.event_id, headers };
}
