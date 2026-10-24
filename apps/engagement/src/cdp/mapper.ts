// bus event -> CDP call. PURE: no clock, no socket, no database, so the whole mapping is tested against
// schema-validated fixtures (the shape ops/rules.ts established in #553).
//
// `data/cdp/tracking-plan.json` is the written contract for what follows, and `mapper.test.ts` asserts the two
// agree in BOTH directions: every mapped topic here has a plan entry with the same call and name, every plan
// entry has a mapping here, and the plan's mapped + unmapped lists together cover every topic in the events
// contract exactly once. A new topic in `packages/events` therefore fails the suite until someone writes down
// whether it goes to the CDP — it can be neither silently forgotten nor silently sent.
//
// What is deliberately NOT forwarded, though the payloads carry it: `shipment.shipped.tracking_number` (it
// identifies a parcel at a carrier and buys an audience nothing), `return.requested.reason` (free text a person
// typed — the #553 rule), and `order.placed`'s per-line titles and SKUs (reduced to counts).

import type { EventEnvelopeV1Base, EventTopic } from '@platform/events';
import type { CdpCall, CdpIdentity } from './types.js';

/** What the mapper needs besides the envelope: the resolved identity and the store's code. */
export interface MapContext {
  identity: CdpIdentity;
  storeCode: string;
}

/** The plan's `call` for a topic, so the consumer can tell a gated call from an erasure before mapping. */
export const CDP_CALL_FOR: Readonly<
  Partial<Record<EventTopic, 'identify' | 'track' | 'suppress'>>
> = {
  'customer.created': 'identify',
  'customer.updated': 'identify',
  'customer.erased': 'suppress',
  'order.placed': 'track',
  'order.cancelled': 'track',
  'payment.captured': 'track',
  'refund.issued': 'track',
  'shipment.shipped': 'track',
  'return.requested': 'track',
};

/** The plan's `name` for each tracked topic. */
export const CDP_EVENT_NAME: Readonly<Partial<Record<EventTopic, string>>> = {
  'order.placed': 'Order Completed',
  'order.cancelled': 'Order Cancelled',
  'payment.captured': 'Payment Captured',
  'refund.issued': 'Order Refunded',
  'shipment.shipped': 'Order Shipped',
  'return.requested': 'Product Returned',
};

/** Every topic the CDP consumer subscribes to. */
export function cdpTopics(): EventTopic[] {
  return Object.keys(CDP_CALL_FOR) as EventTopic[];
}

/** Is this topic mapped at all? The consumer skips anything else without touching the adapter. */
export function isMapped(topic: string): topic is EventTopic {
  return topic in CDP_CALL_FOR;
}

/** `customer.erased` is the one call that is not consent-gated (see the tracking plan). */
export function isConsentGated(topic: EventTopic): boolean {
  return CDP_CALL_FOR[topic] !== 'suppress';
}

/** Drops nulls and undefineds, so a property is absent rather than `null` in the CDP. */
function defined<T extends Record<string, unknown>>(o: T): Record<string, never> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Record<string, never>;
}

/**
 * The mapping. Returns `null` for a topic with no mapping — the consumer logs and skips, never crashes
 * (the SDK rule for unknown topics).
 */
export function mapEvent(envelope: EventEnvelopeV1Base, ctx: MapContext): CdpCall | null {
  const topic = envelope.topic;
  if (!isMapped(topic)) return null;

  const base = {
    identity: ctx.identity,
    timestamp: envelope.occurred_at,
    // `event_id` IS the outbox id by contract (ADR 0003 item 2), which is the key the SDK dedupes on, so the
    // CDP can de-duplicate a repeated call on exactly the same key.
    messageId: envelope.event_id,
  };
  const store = { store_code: ctx.storeCode };

  switch (topic) {
    case 'customer.created':
    case 'customer.updated': {
      // Per the schemas: email_hash and status are required and non-nullable; customer_group_id is oneOf
      // uuid|null.
      const p = envelope.payload as {
        customer_id: string;
        email_hash: string;
        status: 'guest' | 'registered' | 'disabled' | 'erased';
        customer_group_id: string | null;
      };
      // `marketing_consent` is in this payload and is NOT read: the consent that counts is the current
      // projection at processing time (manager ruling 2026-10-23). A send can therefore contradict the
      // event's own snapshot — correct, and documented in data/cdp/README.md.
      //
      // IDS ONLY, in BOTH consent modes (#576 ruling): `customer_id`, `email_hash`, store code. `status` and
      // `customer_group_id` were here and are deliberately gone — `status` is not an id, and a customer group
      // is a marketing SEGMENT id, which is exactly the kind of trait an identify must not carry. The CDP can
      // build its own audiences from the tracked events; it does not need our segmentation.
      return {
        kind: 'identify',
        ...base,
        traits: defined({
          customer_id: p.customer_id,
          email_hash: p.email_hash,
          ...store,
        }),
      };
    }

    case 'customer.erased':
      return { kind: 'suppress', ...base };

    case 'order.placed': {
      const p = envelope.payload as {
        order_id: string;
        display_id: number;
        currency: string;
        totals: {
          subtotal_minor: number;
          discount_minor: number;
          shipping_minor: number;
          tax_minor: number;
          total_minor: number;
        };
        line_items: { quantity: number }[];
        shipping_country: string;
        promotion_codes: string[];
      };
      return {
        kind: 'track',
        event: CDP_EVENT_NAME[topic]!,
        ...base,
        properties: defined({
          order_id: p.order_id,
          display_id: p.display_id,
          currency: p.currency,
          total_minor: p.totals.total_minor,
          subtotal_minor: p.totals.subtotal_minor,
          discount_minor: p.totals.discount_minor,
          shipping_minor: p.totals.shipping_minor,
          tax_minor: p.totals.tax_minor,
          // Counts, not the lines: a title or SKU per line buys an audience nothing.
          line_item_count: p.line_items.length,
          unit_count: p.line_items.reduce((n, l) => n + l.quantity, 0),
          shipping_country: p.shipping_country,
          promotion_codes: p.promotion_codes.length ? p.promotion_codes : null,
          ...store,
        }),
      };
    }

    case 'order.cancelled': {
      const p = envelope.payload as {
        order_id: string;
        display_id: number;
        currency: string;
        totals: { total_minor: number };
      };
      return {
        kind: 'track',
        event: CDP_EVENT_NAME[topic]!,
        ...base,
        properties: defined({
          order_id: p.order_id,
          display_id: p.display_id,
          currency: p.currency,
          total_minor: p.totals.total_minor,
          ...store,
        }),
      };
    }

    case 'payment.captured': {
      const p = envelope.payload as {
        payment_id: string;
        order_id: string;
        amount_minor: number;
        currency: string;
      };
      return {
        kind: 'track',
        event: CDP_EVENT_NAME[topic]!,
        ...base,
        properties: defined({
          order_id: p.order_id,
          payment_id: p.payment_id,
          currency: p.currency,
          amount_minor: p.amount_minor,
          ...store,
        }),
      };
    }

    case 'refund.issued': {
      const p = envelope.payload as {
        refund_id: string;
        order_id: string;
        return_id: string | null;
        amount_minor: number;
        currency: string;
      };
      return {
        kind: 'track',
        event: CDP_EVENT_NAME[topic]!,
        ...base,
        properties: defined({
          order_id: p.order_id,
          refund_id: p.refund_id,
          currency: p.currency,
          amount_minor: p.amount_minor,
          return_id: p.return_id,
          ...store,
        }),
      };
    }

    case 'shipment.shipped': {
      const p = envelope.payload as {
        shipment_id: string;
        order_id: string;
        carrier: string;
        items: { quantity: number }[];
      };
      // No tracking_number on purpose (see the file header and the tracking plan).
      return {
        kind: 'track',
        event: CDP_EVENT_NAME[topic]!,
        ...base,
        properties: defined({
          order_id: p.order_id,
          shipment_id: p.shipment_id,
          carrier: p.carrier,
          item_count: p.items.reduce((n, i) => n + i.quantity, 0),
          ...store,
        }),
      };
    }

    case 'return.requested': {
      const p = envelope.payload as {
        return_id: string;
        order_id: string;
        items: { quantity: number }[];
      };
      // No `reason` on purpose: free text a customer or an agent typed (#553's rule).
      return {
        kind: 'track',
        event: CDP_EVENT_NAME[topic]!,
        ...base,
        properties: defined({
          order_id: p.order_id,
          return_id: p.return_id,
          line_count: p.items.length,
          unit_count: p.items.reduce((n, i) => n + i.quantity, 0),
          ...store,
        }),
      };
    }

    default:
      return null;
  }
}
