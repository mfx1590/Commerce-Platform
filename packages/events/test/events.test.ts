import { describe, expect, it } from 'vitest';
import {
  createValidator,
  EVENT_SCHEMAS,
  EVENT_TOPICS,
  LATEST_VERSION,
  makeEvent,
  toOutboxRow,
  type AggregateType,
  type EventEnvelope,
  type EventTopic,
  type OrderPlacedV1,
} from '../src/index.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = '00000000-0000-4000-8000-000000000031';
const ID = '20000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

const orderPlaced: OrderPlacedV1 = {
  order_id: ID,
  display_id: 1000,
  legal_entity_id: ID,
  sales_channel_id: ID,
  customer_id: null,
  email_hash: HASH,
  currency: 'EUR',
  locale: 'en-GB',
  totals: {
    subtotal_minor: 1999,
    discount_minor: 0,
    shipping_minor: 499,
    tax_minor: 420,
    total_minor: 2918,
  },
  line_items: [
    {
      order_line_item_id: ID,
      variant_id: ID,
      sku: 'TEE-M-RED',
      title: 'Tee',
      quantity: 1,
      unit_price_minor: 1999,
      discount_minor: 0,
      tax_rate_bp: 2100,
      tax_minor: 420,
      total_minor: 2419,
    },
  ],
  shipping: {
    shipping_option_id: null,
    code: 'standard',
    name: 'Standard',
    carrier: 'manual',
    price_minor: 499,
  },
  shipping_country: 'NL',
  billing_country: 'NL',
  promotion_codes: [],
  placed_at: '2026-09-04T10:00:00.000Z',
};

const v = createValidator();

describe('event schemas', () => {
  it('covers every topic in plan section 2.7', () => {
    for (const t of [
      'order.placed',
      'payment.captured',
      'refund.issued',
      'shipment.created',
      'stock.moved',
      'customer.updated',
      'product.published',
      'campaign.launched',
      'campaign.ended',
      'feed.published',
      'attribution.recorded',
      'referral.converted',
      'review.published',
      'cart.abandoned',
      'fulfillment.requested',
      'fulfillment.picking',
      'fulfillment.packed',
    ]) {
      expect(EVENT_TOPICS).toContain(t);
    }
    expect(EVENT_TOPICS).toHaveLength(34);
  });

  it('compiles every schema and has a v1 for every topic', () => {
    for (const t of EVENT_TOPICS) {
      expect(LATEST_VERSION[t]).toBeGreaterThanOrEqual(1);
      expect(EVENT_SCHEMAS[`${t}@1` as keyof typeof EVENT_SCHEMAS]).toBeDefined();
    }
  });

  it('every event schema forbids unknown properties (frozen contract)', () => {
    for (const s of Object.values(EVENT_SCHEMAS)) expect(s.additionalProperties).toBe(false);
  });

  it('validates a well-formed order.placed envelope', () => {
    const e = makeEvent({
      topic: 'order.placed',
      organizationId: ORG,
      storeId: STORE,
      aggregateType: 'order',
      aggregateId: ID,
      payload: orderPlaced,
      actor: { type: 'customer', id: null },
    });
    expect(v.validateEnvelope(e)).toEqual({ ok: true, errors: [] });
    expect(toOutboxRow(e).topic).toBe('order.placed');
    expect(toOutboxRow(e).id).toBe(e.event_id);
  });

  it('rejects a payload with a missing field, a float amount, or an extra field', () => {
    const { total_minor: _drop, ...rest } = orderPlaced.totals;
    const missing = { ...orderPlaced, totals: rest };
    expect(v.validatePayload('order.placed', 1, missing).ok).toBe(false);

    const float = { ...orderPlaced, totals: { ...orderPlaced.totals, total_minor: 29.18 } };
    expect(v.validatePayload('order.placed', 1, float).errors.join()).toMatch(/integer/);

    const extra = { ...orderPlaced, customer_email: 'x@example.com' };
    expect(v.validatePayload('order.placed', 1, extra).errors.join()).toMatch(
      /additional properties/,
    );
  });

  it('rejects raw email instead of a sha256 hash (PII guard)', () => {
    const r = v.validatePayload('order.placed', 1, { ...orderPlaced, email_hash: 'x@example.com' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/email_hash/);
  });

  it('rejects an unknown topic or version and a bad envelope', () => {
    expect(v.validatePayload('order.exploded', 1, {}).errors[0]).toMatch(/unknown event/);
    expect(v.validatePayload('order.placed', 99, orderPlaced).ok).toBe(false);
    const bad = { topic: 'order.placed', payload: orderPlaced } as unknown as EventEnvelope;
    expect(v.validateEnvelope(bad).ok).toBe(false);
  });

  it('marketing topics (0.2.0) validate with sample envelopes and stay PII-free', () => {
    const cases: Array<[EventTopic, AggregateType, Record<string, unknown>]> = [
      [
        'campaign.launched',
        'campaign',
        {
          campaign_id: ID,
          name: 'Autumn',
          type: 'paid_social',
          utm_source: 'meta',
          utm_medium: 'paid_social',
          utm_campaign: 'autumn',
          promotion_id: ID,
          budget: { amount_minor: 250000, currency: 'EUR' },
          starts_at: '2026-09-15T00:00:00.000Z',
        },
      ],
      [
        'campaign.ended',
        'campaign',
        {
          campaign_id: ID,
          name: 'Autumn',
          type: 'email',
          utm_source: null,
          utm_medium: null,
          utm_campaign: null,
        },
      ],
      [
        'feed.published',
        'feed',
        {
          feed_id: ID,
          channel: 'google_merchant',
          locale: 'en-GB',
          currency: 'EUR',
          item_count: 120,
          url: 'https://feeds.brand-a.example/google/en-GB.xml',
          published_at: '2026-09-04T10:00:00.000Z',
        },
      ],
      [
        'attribution.recorded',
        'attribution',
        {
          attribution_id: ID,
          order_id: ID,
          cart_id: ID,
          touch: 'first',
          utm_source: 'meta',
          utm_medium: 'paid_social',
          utm_campaign: 'autumn',
          utm_term: null,
          utm_content: null,
          referrer: 'https://www.instagram.com',
          landing_path: '/collections/new',
          campaign_id: ID,
          captured_at: '2026-09-04T09:00:00.000Z',
          recorded_at: '2026-09-04T10:00:00.000Z',
        },
      ],
      [
        'referral.converted',
        'referral',
        {
          referral_id: ID,
          program_id: ID,
          referrer_customer_id: ID,
          referee_customer_id: ID,
          order_id: ID,
          code_hash: HASH,
          converted_at: '2026-09-04T10:00:00.000Z',
        },
      ],
      [
        'review.published',
        'review',
        {
          review_id: ID,
          product_id: ID,
          order_line_item_id: ID,
          rating: 5,
          published_at: '2026-09-04T10:00:00.000Z',
        },
      ],
      [
        'cart.abandoned',
        'cart',
        {
          cart_id: ID,
          customer_id: null,
          email_hash: HASH,
          currency: 'EUR',
          total_minor: 2918,
          line_item_count: 1,
          last_activity_at: '2026-09-04T08:00:00.000Z',
          abandoned_at: '2026-09-04T10:00:00.000Z',
          has_attribution: true,
        },
      ],
    ];
    for (const [topic, aggregateType, payload] of cases) {
      const e = makeEvent({
        topic,
        organizationId: ORG,
        storeId: STORE,
        aggregateType,
        aggregateId: ID,
        payload: payload as never,
      });
      expect(v.validateEnvelope(e), topic).toEqual({ ok: true, errors: [] });
    }

    // PII guards: a review never carries its text, a referral never its plain code, a cart never its email.
    expect(
      v
        .validatePayload('review.published', 1, { ...cases[5]![2], title: 'Great tee' })
        .errors.join(),
    ).toMatch(/additional properties/);
    expect(
      v.validatePayload('referral.converted', 1, { ...cases[4]![2], code_hash: 'JANE10' }).ok,
    ).toBe(false);
    expect(
      v.validatePayload('cart.abandoned', 1, { ...cases[6]![2], email_hash: 'x@example.com' }).ok,
    ).toBe(false);
    expect(v.validatePayload('review.published', 1, { ...cases[5]![2], rating: 6 }).ok).toBe(false);
    expect(v.validatePayload('attribution.recorded', 1, { ...cases[3]![2], touch: 'mid' }).ok).toBe(
      false,
    );
  });

  it('stock.moved and payment.captured validate with nullable fields', () => {
    expect(
      v.validatePayload('stock.moved', 1, {
        stock_movement_id: ID,
        variant_id: ID,
        sku: 'TEE-M-RED',
        warehouse_id: ID,
        delta: -1,
        reason: 'sale',
        reference_type: 'order',
        reference_id: ID,
        on_hand_after: 9,
        reserved_after: 0,
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(
      v.validatePayload('payment.captured', 1, {
        payment_id: ID,
        order_id: ID,
        legal_entity_id: ID,
        provider: 'stripe',
        provider_payment_id: 'pi_123',
        amount_minor: 2918,
        fee_minor: null,
        currency: 'EUR',
        captured_at: '2026-09-04T10:00:00.000Z',
      }),
    ).toEqual({ ok: true, errors: [] });
  });
});
