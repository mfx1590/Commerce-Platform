// Public API of @platform/events. Nothing outside this package may import from src/* directly.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { COMMON_SCHEMA, ENVELOPE_SCHEMA, EVENT_SCHEMAS, EVENT_TOPICS, LATEST_VERSION } from './generated/schemas.js';
import type { EventEnvelopeV1Base, EventPayloads, LatestPayloads } from './generated/types.js';

export { EVENT_TOPICS, LATEST_VERSION, EVENT_SCHEMAS, ENVELOPE_SCHEMA, COMMON_SCHEMA };
export type * from './generated/types.js';

export type EventTopic = (typeof EVENT_TOPICS)[number];
export type EventKey = keyof EventPayloads; // 'order.placed@1'
export type AggregateType = EventEnvelopeV1Base['aggregate_type'];

/** A typed envelope: `EventEnvelope<'order.placed'>` narrows `payload` to the latest version of that topic. */
export type EventEnvelope<T extends EventTopic = EventTopic> = Omit<EventEnvelopeV1Base, 'topic' | 'payload'> & {
  topic: T;
  payload: LatestPayloads[T];
};

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

/**
 * Compiles every schema once. Use one instance per process.
 * `validateEnvelope` checks the envelope AND the payload against `schemas/<topic>/v<version>.json`.
 */
export function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  // ajv-formats ships a CJS default export; under NodeNext ESM it may arrive wrapped.
  const applyFormats = ((addFormats as unknown as { default?: unknown }).default ?? addFormats) as (a: Ajv2020) => void;
  applyFormats(ajv);
  ajv.addSchema(COMMON_SCHEMA as unknown as object);
  const envelopeFn = ajv.compile(ENVELOPE_SCHEMA as unknown as object);
  const payloadFns = new Map<string, ValidateFunction>();
  for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
    payloadFns.set(key, ajv.compile(schema as unknown as object));
  }

  const validatePayload = (topic: string, version: number, payload: unknown): ValidationResult => {
    const fn = payloadFns.get(`${topic}@${version}`);
    if (!fn) return { ok: false, errors: [`unknown event ${topic}@${version}`] };
    const ok = fn(payload);
    return { ok: ok === true, errors: ok ? [] : formatErrors(fn.errors) };
  };

  const validateEnvelope = (event: unknown): ValidationResult => {
    const ok = envelopeFn(event);
    if (!ok) return { ok: false, errors: formatErrors(envelopeFn.errors) };
    const e = event as EventEnvelopeV1Base;
    const p = validatePayload(e.topic, e.version, e.payload);
    return p.ok ? p : { ok: false, errors: p.errors.map((m) => `/payload${m}`) };
  };

  return { validateEnvelope, validatePayload, ajv };
}

export type Validator = ReturnType<typeof createValidator>;

/** Builds a well-formed envelope for the latest version of `topic`. Producers use this before writing to `outbox`. */
export function makeEvent<T extends EventTopic>(input: {
  topic: T;
  organizationId: string;
  storeId: string | null;
  aggregateType: AggregateType;
  aggregateId: string;
  payload: LatestPayloads[T];
  actor?: EventEnvelopeV1Base['actor'];
  trace?: EventEnvelopeV1Base['trace'];
  eventId?: string;
  occurredAt?: Date;
}): EventEnvelope<T> {
  return {
    event_id: input.eventId ?? crypto.randomUUID(),
    topic: input.topic,
    version: LATEST_VERSION[input.topic],
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    organization_id: input.organizationId,
    store_id: input.storeId,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    actor: input.actor ?? { type: 'system', id: null },
    ...(input.trace ? { trace: input.trace } : {}),
    payload: input.payload,
  };
}

/** Column list of the outbox row an envelope maps to (see migrations/0100_outbox.sql). */
export function toOutboxRow(e: EventEnvelope): {
  id: string;
  organization_id: string;
  store_id: string | null;
  topic: string;
  version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  headers: unknown;
  occurred_at: string;
} {
  return {
    id: e.event_id,
    organization_id: e.organization_id,
    store_id: e.store_id,
    topic: e.topic,
    version: e.version,
    aggregate_type: e.aggregate_type,
    aggregate_id: e.aggregate_id,
    payload: e.payload,
    headers: { actor: e.actor, trace: e.trace ?? {} },
    occurred_at: e.occurred_at,
  };
}
