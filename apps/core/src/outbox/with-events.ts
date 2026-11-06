// The ONLY place in apps/core that inserts into `outbox` (ADR 0003). Every state change calls `withEvents` inside
// the same transaction as its writes; the relay (window 14, Phase 4) publishes. Never publish to the bus directly.
// Guarantees, tests and the lint guard: see README.md in this folder.
import { createValidator, makeEvent, toOutboxRow, type Validator } from '@platform/events';
import type { AggregateType, EventEnvelope, EventTopic, LatestPayloads } from '@platform/events';
import type { Queryable } from '@platform/db';
import type { Actor } from '../lib/audit';
import { currentTraceFields, inSpan } from '../telemetry';

let validator: Validator | undefined;

/** One compiled validator per process (compiles every event schema once). */
function getValidator(): Validator {
  validator ??= createValidator();
  return validator;
}

export class InvalidEventError extends Error {
  constructor(
    readonly topic: string,
    readonly errors: string[],
  ) {
    super(`invalid event ${topic}: ${errors.join('; ')}`);
    this.name = 'InvalidEventError';
  }
}

/**
 * The topic prefixes the bus keeps FOREVER: infra/redpanda/topics.policy.json `retention.forever` (outbox.test.ts pins
 * the two together, so a change to one fails until the other follows). The core never reads that file at runtime.
 */
export const FOREVER_TOPIC_PREFIXES: readonly string[] = ['stock.', 'stock_item.'];

/**
 * #707: an event the bus keeps forever must not carry a customer as its actor WITH an id, because the id would outlive
 * the customer's erasure on the broker (the outbox replay and the DLQ replay null it, the broker's own copy never
 * expires). Every topic a customer flow writes is a 30-day topic; this keeps it that way.
 */
function customerActorOnForeverTopic(e: EventEnvelope): boolean {
  return (
    e.actor.type === 'customer' &&
    e.actor.id !== null &&
    FOREVER_TOPIC_PREFIXES.some((prefix) => e.topic.startsWith(prefix))
  );
}

/** Envelope `actor` from our audit actor. */
export function eventActor(actor: Actor): EventEnvelope['actor'] {
  return { type: actor.type, id: actor.id };
}

export interface BuildEventInput<T extends EventTopic> {
  topic: T;
  organizationId: string;
  storeId: string | null;
  aggregateType: AggregateType;
  aggregateId: string;
  payload: LatestPayloads[T];
  actor?: EventEnvelope['actor'];
  trace?: NonNullable<EventEnvelope['trace']>;
  eventId?: string;
  occurredAt?: Date;
}

/**
 * Builds an envelope for the latest version of `topic` (thin wrapper over `makeEvent`). Kept async so call sites
 * read the same whether the envelope is built here or fetched from elsewhere.
 */
export async function buildEvent<T extends EventTopic>(
  input: BuildEventInput<T>,
): Promise<EventEnvelope<T>> {
  return makeEvent(input);
}

/**
 * Validates every envelope (envelope + payload JSON Schema, and no customer actor id on a forever topic, #707) and
 * inserts the rows into `outbox` on the caller's
 * transaction. A failing envelope throws before any insert, which aborts the caller's transaction — so an
 * invalid event can never leave a half-committed state change behind.
 * An envelope without `trace` gets the current request's `{ trace_id, request_id }` (#729, src/telemetry; nothing
 * outside a request or with telemetry off); a `trace` the caller set is never overwritten.
 */
export async function withEvents(tx: Queryable, input: EventEnvelope[]): Promise<void> {
  if (input.length === 0) return;
  const trace = currentTraceFields();
  const events = trace ? input.map((e) => (e.trace ? e : { ...e, trace })) : input;
  const v = getValidator();
  for (const e of events) {
    const r = v.validateEnvelope(e);
    if (!r.ok) throw new InvalidEventError(e.topic, r.errors);
    if (customerActorOnForeverTopic(e))
      throw new InvalidEventError(e.topic, [
        'actor: a customer id on a topic the bus keeps forever (#707); write the actor with id null, or move the topic to the 30-day class',
      ]);
  }
  await inSpan('outbox.write', { 'outbox.events': events.length }, async () => {
    for (const e of events) {
      const row = toOutboxRow(e);
      await tx.query(
        `INSERT INTO outbox (id, organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload, headers, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id,
          row.organization_id,
          row.store_id,
          row.topic,
          row.version,
          row.aggregate_type,
          row.aggregate_id,
          JSON.stringify(row.payload),
          JSON.stringify(row.headers),
          row.occurred_at,
        ],
      );
    }
  });
}
