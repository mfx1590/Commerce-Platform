// The ONLY place in apps/core that inserts into `outbox` (ADR 0003). Every state change calls `withEvents` inside
// the same transaction as its writes; the relay (window 14, Phase 4) publishes. Never publish to the bus directly.
// Task 1.5 hardens this (README, rollback + validation tests, lint guard); task 1.2 needs the write itself.
import type * as PlatformEvents from '@platform/events';
import type { AggregateType, EventEnvelope, EventTopic, LatestPayloads } from '@platform/events';
import type { Queryable } from '@platform/db';
import type { Actor } from '../lib/audit';

type EventsModule = typeof PlatformEvents;

let mod: EventsModule | undefined;
let validator: PlatformEvents.Validator | undefined;

/** @platform/events is ESM-only; this CommonJS app loads it once with import() (same reason as src/lib/db.ts). */
export async function eventsModule(): Promise<EventsModule> {
  mod ??= await import('@platform/events');
  return mod;
}

async function getValidator(): Promise<PlatformEvents.Validator> {
  validator ??= (await eventsModule()).createValidator();
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

/** Envelope `actor` from our audit actor. */
export function eventActor(actor: Actor): EventEnvelope['actor'] {
  return { type: actor.type, id: actor.id };
}

/**
 * Builds an envelope for the latest version of `topic` (thin wrapper over `makeEvent` so services need no
 * dynamic import of their own).
 */
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

export async function buildEvent<T extends EventTopic>(
  input: BuildEventInput<T>,
): Promise<EventEnvelope<T>> {
  const { makeEvent } = await eventsModule();
  return makeEvent(input);
}

/**
 * Validates every envelope (envelope + payload JSON Schema) and inserts the rows into `outbox` on the caller's
 * transaction. A failing envelope throws before any insert, which aborts the caller's transaction — so an
 * invalid event can never leave a half-committed state change behind.
 */
export async function withEvents(tx: Queryable, events: EventEnvelope[]): Promise<void> {
  if (events.length === 0) return;
  const { toOutboxRow } = await eventsModule();
  const v = await getValidator();
  for (const e of events) {
    const r = v.validateEnvelope(e);
    if (!r.ok) throw new InvalidEventError(e.topic, r.errors);
  }
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
}
