// The three pick/pack events, and the seam that carries them until `@platform/events` knows their topics.
//
// Events 0.3.0 (CONTRACT CHANGE #225) shipped the three topics, so they go straight to the outbox through
// `withEvents`, in the caller's transaction (ADR 0003) — and that is what happens today.
//
// The runtime check stays: an envelope whose topic `@platform/events` does not know would fail validation and
// take a correct warehouse operation down with it. If that ever happens — a rolled-back package, a stale build —
// the event is buffered, one warning is logged, and the state change still commits. `pendingLifecycleEvents()`
// should be empty in a healthy process, and a test asserts exactly that.
import { EVENT_TOPICS } from '@platform/events';
import type { EventTopic } from '@platform/events';
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { BoundedTtlMap } from '../shipping';

export const LIFECYCLE_TOPICS = [
  'fulfillment.requested',
  'fulfillment.picking',
  'fulfillment.packed',
] as const;

export type LifecycleTopic = (typeof LIFECYCLE_TOPICS)[number];

export interface LifecycleLine {
  order_line_item_id: string;
  quantity: number;
}

export interface LifecycleEvent {
  topic: LifecycleTopic;
  organizationId: string;
  storeId: string;
  shipmentId: string;
  orderId: string;
  warehouseId: string;
  items: LifecycleLine[];
  occurredAt: string;
  actor: Actor;
  /** `fulfillment.requested` only. */
  provider?: string;
  externalId?: string | null;
  /** `fulfillment.packed` only. */
  parcelCount?: number | null;
}

/** Whether `@platform/events` knows the topic. Read at call time, never cached. True since events 0.3.0. */
export function topicIsKnown(topic: LifecycleTopic): boolean {
  return (EVENT_TOPICS as readonly string[]).includes(topic);
}

function payloadOf(event: LifecycleEvent): Record<string, unknown> {
  const base = {
    shipment_id: event.shipmentId,
    order_id: event.orderId,
    warehouse_id: event.warehouseId,
    items: event.items,
    occurred_at: event.occurredAt,
  };
  if (event.topic === 'fulfillment.requested') {
    return {
      ...base,
      provider: event.provider ?? 'unknown',
      external_id: event.externalId ?? null,
    };
  }
  if (event.topic === 'fulfillment.packed') {
    return { ...base, parcel_count: event.parcelCount ?? null };
  }
  return base;
}

export interface LifecycleEmitter {
  emit(tx: Queryable, event: LifecycleEvent): Promise<void>;
}

/** Events that could not be written because `@platform/events` did not know the topic. Empty in a healthy run. */
const buffered = new BoundedTtlMap<LifecycleEvent>({ maxEntries: 200, ttlMs: 60 * 60_000 });
let warned = false;

export function pendingLifecycleEvents(): LifecycleEvent[] {
  return buffered.values();
}

export function clearPendingLifecycleEvents(): void {
  buffered.clear();
}

/**
 * The only emitter. Writes to the outbox as soon as the topic exists; until then it buffers and warns once, so a
 * missing contract is visible in the logs without failing a warehouse operation that is otherwise correct.
 */
export const lifecycleEmitter: LifecycleEmitter = {
  async emit(tx, event) {
    if (!topicIsKnown(event.topic)) {
      buffered.set(`${event.shipmentId}:${event.topic}:${event.occurredAt}`, event);
      if (!warned) {
        warned = true;
        console.warn(
          `fulfillment: @platform/events does not know ${event.topic}; the event was buffered, not written`,
        );
      }
      return;
    }
    await withEvents(tx, [
      await buildEvent({
        // Safe: `topicIsKnown` just checked that the topic is in EVENT_TOPICS, which is what the type describes.
        topic: event.topic as EventTopic,
        organizationId: event.organizationId,
        storeId: event.storeId,
        aggregateType: 'shipment',
        aggregateId: event.shipmentId,
        actor: eventActor(event.actor),
        payload: payloadOf(event) as never,
      }),
    ]);
  },
};

let emitter: LifecycleEmitter = lifecycleEmitter;

/** Replaces the emitter (tests). Returns the previous one. */
export function setLifecycleEmitter(next: LifecycleEmitter): LifecycleEmitter {
  const previous = emitter;
  emitter = next;
  return previous;
}

export function currentLifecycleEmitter(): LifecycleEmitter {
  return emitter;
}

/** What a caller uses: builds nothing itself, just hands the fact over. */
export async function emitLifecycleEvent(tx: Queryable, event: LifecycleEvent): Promise<void> {
  await emitter.emit(tx, event);
}
