// The five ledger topics (ADR 0003 item 6) and the dispatcher: envelope + the order projection it may need → the
// entries to write and the projection changes to persist. Pure: no I/O, no clock.
import type { EventEnvelope, EventEnvelopeV1Base } from '@platform/events';
import { DuplicateOrderPlacedError, UnsupportedTopicError } from '../errors.js';
import { finalizeEntries } from './balance.js';
import { postOrderCancelled } from './order-cancelled.js';
import { postOrderPlaced } from './order-placed.js';
import { postPaymentCaptured } from './payment-captured.js';
import { postRefundIssued } from './refund-issued.js';
import { postShipmentShipped } from './shipment-shipped.js';
import type { OrderProjection, PostingResult } from './types.js';

export const LEDGER_TOPICS = [
  'order.placed',
  'order.cancelled',
  'payment.captured',
  'refund.issued',
  'shipment.shipped',
] as const;
export type LedgerTopic = (typeof LEDGER_TOPICS)[number];

export function isLedgerTopic(topic: string): topic is LedgerTopic {
  return (LEDGER_TOPICS as readonly string[]).includes(topic);
}

/** Every ledger payload carries the order id; it keys the projection the posting may need. */
export function orderIdOf(e: EventEnvelopeV1Base): string {
  const id = (e.payload as { order_id?: unknown }).order_id;
  if (typeof id !== 'string') throw new TypeError(`${e.topic} ${e.event_id} has no order_id`);
  return id;
}

/** The legal entity of the fact: every ledger payload carries it. */
export function legalEntityIdOf(e: EventEnvelopeV1Base): string {
  const id = (e.payload as { legal_entity_id?: unknown }).legal_entity_id;
  if (typeof id !== 'string')
    throw new TypeError(`${e.topic} ${e.event_id} has no legal_entity_id`);
  return id;
}

/**
 * Whether the posting needs the order projection to exist: shipments, cancellations and refunds other than
 * `cancellation` do; the handler PARKS such an event when the order has not arrived yet (cross-topic lag).
 */
export function needsOrderProjection(e: EventEnvelopeV1Base): boolean {
  switch (e.topic) {
    case 'shipment.shipped':
    case 'order.cancelled':
      return true;
    case 'refund.issued':
      return (e.payload as { reason?: unknown }).reason !== 'cancellation';
    default:
      return false;
  }
}

/**
 * Posts one event. `order` is the current projection of the event's order (null when none exists yet). A redelivered
 * order.placed (same event id as the projection's source) posts nothing; a second, different order.placed for the
 * same order is a producer defect.
 */
export function postEvent(e: EventEnvelopeV1Base, order: OrderProjection | null): PostingResult {
  let result: PostingResult;
  switch (e.topic) {
    case 'order.placed': {
      if (order) {
        if (order.source_event_id === e.event_id) return { entries: [] };
        throw new DuplicateOrderPlacedError(order.order_id, order.source_event_id, e.event_id);
      }
      result = postOrderPlaced(e as unknown as EventEnvelope<'order.placed'>);
      break;
    }
    case 'order.cancelled':
      result = postOrderCancelled(e as unknown as EventEnvelope<'order.cancelled'>, order);
      break;
    case 'payment.captured':
      result = postPaymentCaptured(e as unknown as EventEnvelope<'payment.captured'>);
      break;
    case 'refund.issued':
      result = postRefundIssued(e as unknown as EventEnvelope<'refund.issued'>, order);
      break;
    case 'shipment.shipped':
      result = postShipmentShipped(e as unknown as EventEnvelope<'shipment.shipped'>, order);
      break;
    default:
      throw new UnsupportedTopicError(e.topic);
  }
  return { ...result, entries: finalizeEntries(result.entries) };
}

export {
  postOrderPlaced,
  postOrderCancelled,
  postPaymentCaptured,
  postRefundIssued,
  postShipmentShipped,
};
export * from './types.js';
export {
  aggregateLines,
  assertBalanced,
  dateOf,
  finalizeEntries,
  finalizeEntry,
  line,
  proportion,
  roundShare,
} from './balance.js';
