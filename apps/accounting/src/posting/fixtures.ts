// Event builders for the tests: real envelopes through packages/events' `makeEvent`, validated against the schemas,
// so a payload change upstream fails these tests rather than the service in production. The envelope occurred_at is
// the fact's own timestamp (as the core stamps it at the state change), so parked events apply in fact order. Ids are the seed's
// (organization, legal entities, stores); everything else is random. No PII anywhere (email_hash is a hash of a
// fixture address).
import { randomUUID, createHash } from 'node:crypto';
import { SEED_IDS } from '@platform/db';
import {
  createValidator,
  makeEvent,
  type EventEnvelope,
  type EventEnvelopeV1Base,
  type LatestPayloads,
} from '@platform/events';

export const ORG = SEED_IDS.organization;
export const LE_A = SEED_IDS.legalEntities.brandA; // EUR
export const LE_B = SEED_IDS.legalEntities.brandB; // GBP
export const STORE_A = SEED_IDS.stores.brandA;
export const STORE_B = SEED_IDS.stores.brandB;

const validator = createValidator();

/** Throws when the envelope or its payload does not match the published schema. */
export function assertValid<T extends EventEnvelopeV1Base>(e: T): T {
  const r = validator.validateEnvelope(e);
  if (!r.ok) throw new Error(`fixture invalid for ${e.topic}: ${r.errors.join('; ')}`);
  return e;
}

export const emailHash = (email: string): string =>
  createHash('sha256').update(email.toLowerCase()).digest('hex');

export interface LineSpec {
  quantity: number;
  unit_price_minor: number;
  discount_minor?: number;
  tax_rate_bp: number;
  /** When omitted: tax on (quantity × unit − discount) at the rate, half up (exclusive mode). */
  tax_minor?: number;
  /** Prices include tax: the line total is subtotal − discount, tax inside. */
  inclusive?: boolean;
  id?: string;
}

export interface OrderSpec {
  orderId?: string;
  displayId?: number;
  legalEntityId?: string;
  storeId?: string;
  currency?: string;
  lines: LineSpec[];
  shipping_minor?: number;
  /** Tax on the shipping (exclusive mode: added to the totals tax; inclusive: inside shipping_minor). */
  shipping_tax_minor?: number;
  inclusive?: boolean;
  placed_at?: string;
  eventId?: string;
}

export const taxOn = (base: number, bp: number): number =>
  Number((BigInt(base) * BigInt(bp) * 2n + 10_000n) / 20_000n);

export function orderPlaced(spec: OrderSpec): EventEnvelope<'order.placed'> {
  const orderId = spec.orderId ?? randomUUID();
  const storeId = spec.storeId ?? STORE_A;
  const inclusive = spec.inclusive ?? false;
  const lines = spec.lines.map((l) => {
    const subtotal = l.quantity * l.unit_price_minor;
    const discount = l.discount_minor ?? 0;
    const tax = l.tax_minor ?? taxOn(subtotal - discount, l.tax_rate_bp);
    const incl = l.inclusive ?? inclusive;
    return {
      order_line_item_id: l.id ?? randomUUID(),
      variant_id: randomUUID(),
      sku: `SKU-${l.quantity}-${l.unit_price_minor}`,
      title: 'Fixture item',
      quantity: l.quantity,
      unit_price_minor: l.unit_price_minor,
      discount_minor: discount,
      tax_rate_bp: l.tax_rate_bp,
      tax_minor: tax,
      total_minor: incl ? subtotal - discount : subtotal - discount + tax,
    };
  });
  const subtotal = lines.reduce((a, l) => a + l.quantity * l.unit_price_minor, 0);
  const discount = lines.reduce((a, l) => a + l.discount_minor, 0);
  const shipping = spec.shipping_minor ?? 0;
  const shippingTax = spec.shipping_tax_minor ?? 0;
  const tax = lines.reduce((a, l) => a + l.tax_minor, 0) + shippingTax;
  const total = inclusive ? subtotal - discount + shipping : subtotal - discount + shipping + tax;
  const payload: LatestPayloads['order.placed'] = {
    order_id: orderId,
    display_id: spec.displayId ?? 1000 + Math.floor(Math.random() * 100_000),
    legal_entity_id: spec.legalEntityId ?? LE_A,
    sales_channel_id: randomUUID(),
    customer_id: null,
    email_hash: emailHash('fixture@example.test'),
    currency: spec.currency ?? 'EUR',
    locale: 'en-GB',
    totals: {
      subtotal_minor: subtotal,
      discount_minor: discount,
      shipping_minor: shipping,
      tax_minor: tax,
      total_minor: total,
    },
    line_items: lines,
    shipping: {
      shipping_option_id: null,
      code: 'standard',
      name: 'Standard',
      carrier: 'manual',
      price_minor: shipping,
    },
    shipping_country: 'NL',
    billing_country: 'NL',
    promotion_codes: [],
    placed_at: spec.placed_at ?? '2026-10-05T10:00:00.000Z',
  };
  return assertValid(
    makeEvent({
      topic: 'order.placed',
      organizationId: ORG,
      storeId,
      aggregateType: 'order',
      aggregateId: orderId,
      occurredAt: new Date(payload.placed_at),
      payload,
      ...(spec.eventId ? { eventId: spec.eventId } : {}),
    }),
  );
}

export function orderCancelled(
  placed: EventEnvelope<'order.placed'>,
  opts: { cancelled_at?: string; eventId?: string } = {},
): EventEnvelope<'order.cancelled'> {
  const p = placed.payload;
  return assertValid(
    makeEvent({
      topic: 'order.cancelled',
      organizationId: placed.organization_id,
      storeId: placed.store_id,
      aggregateType: 'order',
      aggregateId: p.order_id,
      occurredAt: new Date(opts.cancelled_at ?? '2026-10-06T09:00:00.000Z'),
      payload: {
        order_id: p.order_id,
        display_id: p.display_id,
        legal_entity_id: p.legal_entity_id,
        currency: p.currency,
        totals: p.totals,
        reason: 'customer_request',
        cancelled_at: opts.cancelled_at ?? '2026-10-06T09:00:00.000Z',
      },
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
    }),
  );
}

export function paymentCaptured(
  placed: EventEnvelope<'order.placed'>,
  opts: {
    amount_minor?: number;
    fee_minor?: number | null;
    paymentId?: string;
    provider_payment_id?: string | null;
    captured_at?: string;
    eventId?: string;
  } = {},
): EventEnvelope<'payment.captured'> {
  const p = placed.payload;
  const paymentId = opts.paymentId ?? randomUUID();
  return assertValid(
    makeEvent({
      topic: 'payment.captured',
      organizationId: placed.organization_id,
      storeId: placed.store_id,
      aggregateType: 'payment',
      aggregateId: paymentId,
      occurredAt: new Date(opts.captured_at ?? '2026-10-05T10:00:05.000Z'),
      payload: {
        payment_id: paymentId,
        order_id: p.order_id,
        legal_entity_id: p.legal_entity_id,
        provider: 'stripe',
        provider_payment_id:
          opts.provider_payment_id === undefined
            ? `pi_fixture_${paymentId.slice(0, 8)}`
            : opts.provider_payment_id,
        amount_minor: opts.amount_minor ?? p.totals.total_minor,
        fee_minor:
          opts.fee_minor === undefined
            ? Math.round(p.totals.total_minor * 0.029) + 25
            : opts.fee_minor,
        currency: p.currency,
        captured_at: opts.captured_at ?? '2026-10-05T10:00:05.000Z',
      },
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
    }),
  );
}

export function refundIssued(
  placed: EventEnvelope<'order.placed'>,
  payment: EventEnvelope<'payment.captured'>,
  opts: {
    amount_minor: number;
    reason?: 'return' | 'cancellation' | 'goodwill' | 'chargeback';
    refundId?: string;
    provider_refund_id?: string | null;
    issued_at?: string;
    eventId?: string;
  },
): EventEnvelope<'refund.issued'> {
  const p = placed.payload;
  const refundId = opts.refundId ?? randomUUID();
  return assertValid(
    makeEvent({
      topic: 'refund.issued',
      organizationId: placed.organization_id,
      storeId: placed.store_id,
      aggregateType: 'refund',
      aggregateId: refundId,
      occurredAt: new Date(opts.issued_at ?? '2026-10-12T15:00:00.000Z'),
      payload: {
        refund_id: refundId,
        payment_id: payment.payload.payment_id,
        order_id: p.order_id,
        return_id: opts.reason === 'return' ? randomUUID() : null,
        legal_entity_id: p.legal_entity_id,
        amount_minor: opts.amount_minor,
        currency: p.currency,
        reason: opts.reason ?? 'return',
        provider_refund_id:
          opts.provider_refund_id === undefined
            ? `re_fixture_${refundId.slice(0, 8)}`
            : opts.provider_refund_id,
        issued_at: opts.issued_at ?? '2026-10-12T15:00:00.000Z',
      },
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
    }),
  );
}

export function shipmentShipped(
  placed: EventEnvelope<'order.placed'>,
  items: { order_line_item_id: string; quantity: number }[],
  opts: {
    cost_minor?: number | null;
    currency?: string;
    shipmentId?: string;
    shipped_at?: string;
    eventId?: string;
  } = {},
): EventEnvelope<'shipment.shipped'> {
  const p = placed.payload;
  const shipmentId = opts.shipmentId ?? randomUUID();
  return assertValid(
    makeEvent({
      topic: 'shipment.shipped',
      organizationId: placed.organization_id,
      storeId: placed.store_id,
      aggregateType: 'shipment',
      aggregateId: shipmentId,
      occurredAt: new Date(opts.shipped_at ?? '2026-10-07T08:00:00.000Z'),
      payload: {
        shipment_id: shipmentId,
        order_id: p.order_id,
        legal_entity_id: p.legal_entity_id,
        warehouse_id: SEED_IDS.warehouses.eu,
        carrier: 'manual',
        service: 'standard',
        tracking_number: null,
        cost_minor: opts.cost_minor === undefined ? 450 : opts.cost_minor,
        currency: opts.currency ?? p.currency,
        items,
        shipped_at: opts.shipped_at ?? '2026-10-07T08:00:00.000Z',
      },
      ...(opts.eventId ? { eventId: opts.eventId } : {}),
    }),
  );
}

/** All line items of an order, fully. */
export const allItems = (placed: EventEnvelope<'order.placed'>) =>
  placed.payload.line_items.map((l) => ({
    order_line_item_id: l.order_line_item_id,
    quantity: l.quantity,
  }));

/** Deterministic PRNG (mulberry32) for the generated streams: the same seed replays the same month. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratedStream {
  events: EventEnvelopeV1Base[];
  orders: number;
  shipments: number;
  captures: number;
  refunds: number;
  cancellations: number;
}

/**
 * A month of activity over two legal entities (A: EUR, B: GBP): orders of 1–4 lines (some discounted, some
 * tax-inclusive), a capture with a fee for most, partial and full shipments, refunds of every reason, cancellations
 * of unshipped and partially shipped orders. Events are emitted per order in the order the facts happen, so a
 * consumer reading them in sequence always has the projection it needs.
 */
export function generateMonth(opts: { orders: number; seed?: number }): GeneratedStream {
  const random = rng(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const events: EventEnvelopeV1Base[] = [];
  let shipments = 0;
  let captures = 0;
  let refunds = 0;
  let cancellations = 0;
  let day = 1;
  for (let i = 0; i < opts.orders; i++) {
    if (i % 7 === 6 && day < 28) day += 1;
    const dd = String(day).padStart(2, '0');
    const entity =
      random() < 0.5
        ? { le: LE_A, store: STORE_A, cur: 'EUR', bp: 2100 }
        : { le: LE_B, store: STORE_B, cur: 'GBP', bp: 2000 };
    const inclusive = random() < 0.3;
    const lines: LineSpec[] = Array.from({ length: int(1, 4) }, () => {
      const quantity = int(1, 5);
      const unit = int(199, 15_999);
      const discount = random() < 0.3 ? int(1, Math.min(quantity * unit, 2_000)) : 0;
      return { quantity, unit_price_minor: unit, discount_minor: discount, tax_rate_bp: entity.bp };
    });
    const shipping = random() < 0.7 ? pick([0, 495, 695, 1_250]) : 0;
    const placed = orderPlaced({
      legalEntityId: entity.le,
      storeId: entity.store,
      currency: entity.cur,
      lines,
      shipping_minor: shipping,
      shipping_tax_minor: inclusive ? 0 : taxOn(shipping, entity.bp),
      inclusive,
      placed_at: `2026-10-${dd}T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
    });
    events.push(placed);
    const total = placed.payload.totals.total_minor;

    let payment: EventEnvelope<'payment.captured'> | null = null;
    if (random() < 0.9) {
      payment = paymentCaptured(placed, {
        fee_minor: random() < 0.1 ? null : Math.round(total * 0.029) + 25,
        captured_at: `2026-10-${dd}T10:${String(i % 60).padStart(2, '0')}:30.000Z`,
      });
      events.push(payment);
      captures += 1;
    }

    const fate = random();
    if (fate < 0.12) {
      // cancelled before anything shipped (+ the refund of the capture, reason cancellation)
      events.push(orderCancelled(placed, { cancelled_at: `2026-10-${dd}T12:00:00.000Z` }));
      cancellations += 1;
      if (payment) {
        events.push(
          refundIssued(placed, payment, {
            amount_minor: total,
            reason: 'cancellation',
            issued_at: `2026-10-${dd}T12:30:00.000Z`,
          }),
        );
        refunds += 1;
      }
      continue;
    }
    // ship: in one go, or split per line / per unit
    const items = allItems(placed);
    const shipDay = String(Math.min(day + int(0, 3), 31)).padStart(2, '0');
    if (fate < 0.5 || items.length === 1) {
      events.push(
        shipmentShipped(placed, items, {
          cost_minor: random() < 0.15 ? null : pick([310, 450, 820, 1_100]),
          shipped_at: `2026-10-${shipDay}T08:00:00.000Z`,
        }),
      );
      shipments += 1;
    } else {
      // partial shipments: first a part of each line, then the rest (sometimes cancelled in between)
      const first = items.map((it) => ({
        ...it,
        quantity: Math.max(1, Math.floor(it.quantity / 2)),
      }));
      events.push(
        shipmentShipped(placed, first, {
          cost_minor: pick([310, 450]),
          shipped_at: `2026-10-${shipDay}T08:00:00.000Z`,
        }),
      );
      shipments += 1;
      const rest = items
        .map((it, k) => ({ ...it, quantity: it.quantity - first[k]!.quantity }))
        .filter((it) => it.quantity > 0);
      if (random() < 0.2) {
        events.push(orderCancelled(placed, { cancelled_at: `2026-10-${shipDay}T18:00:00.000Z` }));
        cancellations += 1;
        if (payment) {
          // the customer gets the unshipped part back
          const refund = Math.floor(total / 2);
          events.push(
            refundIssued(placed, payment, {
              amount_minor: refund,
              reason: 'cancellation',
              issued_at: `2026-10-${shipDay}T18:30:00.000Z`,
            }),
          );
          refunds += 1;
        }
        continue;
      }
      if (rest.length > 0) {
        events.push(
          shipmentShipped(placed, rest, {
            cost_minor: pick([310, 450]),
            shipped_at: `2026-10-${shipDay}T16:00:00.000Z`,
          }),
        );
        shipments += 1;
      }
    }
    // refunds after shipment
    if (payment && random() < 0.25) {
      const reason = pick(['return', 'goodwill', 'chargeback'] as const);
      const amount = random() < 0.5 ? total : int(1, Math.max(1, Math.floor(total / 3)));
      events.push(
        refundIssued(placed, payment, {
          amount_minor: amount,
          reason,
          issued_at: `2026-10-${String(Math.min(day + 7, 31)).padStart(2, '0')}T15:00:00.000Z`,
        }),
      );
      refunds += 1;
    }
  }
  return { events, orders: opts.orders, shipments, captures, refunds, cancellations };
}
