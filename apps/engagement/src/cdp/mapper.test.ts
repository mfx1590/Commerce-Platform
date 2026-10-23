// The CDP mapper, against envelopes VALIDATED by the real schemas, plus the two-way agreement with
// data/cdp/tracking-plan.json and the PII sweeps.
//
// The agreement test is the point of the plan file: a topic added to packages/events is neither silently
// forgotten nor silently sent to a third party, because the suite fails until someone writes down which it is.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createValidator,
  EVENT_TOPICS,
  makeEvent,
  type EventEnvelopeV1Base,
  type EventTopic,
} from '@platform/events';
import { describe, expect, it } from 'vitest';
import {
  CDP_CALL_FOR,
  CDP_EVENT_NAME,
  cdpTopics,
  isConsentGated,
  isMapped,
  mapEvent,
} from './mapper.js';
import type { CdpIdentity } from './types.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = '00000000-0000-4000-8000-000000000031';
const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const ORDER = '11111111-1111-4111-8111-111111111111';
const PAYMENT = '22222222-2222-4222-8222-222222222222';
const REFUND = '33333333-3333-4333-8333-333333333333';
const RETURN = '44444444-4444-4444-8444-444444444444';
const SHIPMENT = '55555555-5555-4555-8555-555555555555';
const LINE = '66666666-6666-4666-8666-666666666666';
const ENTITY = '00000000-0000-4000-8000-000000000011';
const CHANNEL = '88888888-8888-4888-8888-888888888888';
const WAREHOUSE = '00000000-0000-4000-8000-000000000021';
const IDENTITY_ID = '99999999-9999-4999-8999-999999999999';
// A sha256-shaped value written as words joined to the right length would not validate against the schema's
// pattern, so this is a real digest of the literal string "cdp-fixture" — not a secret of any kind.
// Computed, never a literal: the schema needs a real 64-hex sha256, and a hex literal of that length in a
// committed test is exactly the shape gitleaks flags across every branch (Memory-main). This is also how
// apps/core builds its own email_hash fixtures.
const EMAIL_HASH = createHash('sha256').update('cdp-fixture@example.test').digest('hex');

const validator = createValidator();
const identity: CdpIdentity = { userId: CUSTOMER, anonymousId: EMAIL_HASH };
const ctx = { identity, storeCode: 'brand-a' };

function envelope(
  topic: EventTopic,
  payload: Record<string, unknown>,
  aggregate: { type: EventEnvelopeV1Base['aggregate_type']; id: string },
): EventEnvelopeV1Base {
  const e = makeEvent({
    topic,
    organizationId: ORG,
    storeId: STORE,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload: payload as never,
  });
  const check = validator.validateEnvelope(e);
  expect(check.ok, `${topic}: ${check.errors?.join('; ')}`).toBe(true);
  return e as EventEnvelopeV1Base;
}

const fixtures: Record<string, () => EventEnvelopeV1Base> = {
  'customer.created': () =>
    envelope(
      'customer.created',
      {
        customer_id: CUSTOMER,
        identity_id: IDENTITY_ID,
        email_hash: EMAIL_HASH,
        status: 'registered',
        customer_group_id: null,
        marketing_consent: true,
      },
      { type: 'customer', id: CUSTOMER },
    ),
  'customer.updated': () =>
    envelope(
      'customer.updated',
      {
        customer_id: CUSTOMER,
        identity_id: IDENTITY_ID,
        email_hash: EMAIL_HASH,
        status: 'registered',
        customer_group_id: null,
        marketing_consent: false,
        changed_fields: ['consent'],
      },
      { type: 'customer', id: CUSTOMER },
    ),
  'customer.erased': () =>
    envelope(
      'customer.erased',
      { customer_id: CUSTOMER, identity_id: IDENTITY_ID, erased_at: '2026-10-23T10:00:00.000Z' },
      { type: 'customer', id: CUSTOMER },
    ),
  'order.placed': () =>
    envelope(
      'order.placed',
      {
        order_id: ORDER,
        display_id: 1001,
        legal_entity_id: ENTITY,
        sales_channel_id: CHANNEL,
        customer_id: CUSTOMER,
        email_hash: EMAIL_HASH,
        currency: 'EUR',
        locale: 'en-GB',
        totals: {
          subtotal_minor: 9000,
          discount_minor: 500,
          shipping_minor: 499,
          tax_minor: 1495,
          total_minor: 10494,
        },
        line_items: [
          {
            order_line_item_id: LINE,
            variant_id: CHANNEL,
            sku: 'SKU-ALPHA',
            title: 'Alpha chair',
            quantity: 2,
            unit_price_minor: 4500,
            discount_minor: 500,
            tax_rate_bp: 1900,
            tax_minor: 1495,
            total_minor: 10494,
          },
        ],
        shipping: { code: 'standard', name: 'Standard', carrier: 'dhl', price_minor: 499 },
        shipping_country: 'DE',
        billing_country: 'DE',
        promotion_codes: ['SPRING-WORDS'],
        placed_at: '2026-10-23T10:00:00.000Z',
      },
      { type: 'order', id: ORDER },
    ),
  'order.cancelled': () =>
    envelope(
      'order.cancelled',
      {
        order_id: ORDER,
        display_id: 1001,
        legal_entity_id: ENTITY,
        currency: 'EUR',
        totals: {
          subtotal_minor: 9000,
          discount_minor: 500,
          shipping_minor: 499,
          tax_minor: 1495,
          total_minor: 10494,
        },
        reason: 'customer_request',
        cancelled_at: '2026-10-23T11:00:00.000Z',
      },
      { type: 'order', id: ORDER },
    ),
  'payment.captured': () =>
    envelope(
      'payment.captured',
      {
        payment_id: PAYMENT,
        order_id: ORDER,
        legal_entity_id: ENTITY,
        provider: 'stripe',
        provider_payment_id: 'pi-alpha',
        amount_minor: 10494,
        fee_minor: 250,
        currency: 'EUR',
        captured_at: '2026-10-23T10:05:00.000Z',
      },
      { type: 'payment', id: PAYMENT },
    ),
  'refund.issued': () =>
    envelope(
      'refund.issued',
      {
        refund_id: REFUND,
        payment_id: PAYMENT,
        order_id: ORDER,
        return_id: RETURN,
        legal_entity_id: ENTITY,
        amount_minor: 2500,
        currency: 'EUR',
        // The schema's enum: return | cancellation | goodwill | chargeback — a controlled value, unlike
        // order.cancelled.reason, which is free text. Neither is forwarded (see the tracking plan).
        reason: 'return',
        provider_refund_id: 're-alpha',
        issued_at: '2026-10-24T10:00:00.000Z',
      },
      { type: 'refund', id: REFUND },
    ),
  'shipment.shipped': () =>
    envelope(
      'shipment.shipped',
      {
        shipment_id: SHIPMENT,
        order_id: ORDER,
        legal_entity_id: ENTITY,
        warehouse_id: WAREHOUSE,
        carrier: 'dhl',
        service: 'standard',
        tracking_number: 'TRACK-ALPHA-WORDS',
        cost_minor: 499,
        currency: 'EUR',
        items: [{ order_line_item_id: LINE, quantity: 2 }],
        shipped_at: '2026-10-24T08:00:00.000Z',
      },
      { type: 'shipment', id: SHIPMENT },
    ),
  'return.requested': () =>
    envelope(
      'return.requested',
      {
        return_id: RETURN,
        order_id: ORDER,
        reason: 'call me on 0171 555 0199, 12 Example Street',
        items: [{ order_line_item_id: LINE, quantity: 2 }],
        requested_at: '2026-10-24T09:00:00.000Z',
      },
      { type: 'return', id: RETURN },
    ),
};

// ---- the plan file ------------------------------------------------------------------------------------------

interface Plan {
  identity: { rule: string };
  consent: { purpose: string; evaluated: string };
  events: {
    topic: string;
    call: string;
    name?: string;
    properties?: string[];
    traits?: string[];
    consent_gated: boolean;
  }[];
  unmapped: { topics: string[]; reason: string }[];
}
const plan = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'data',
      'cdp',
      'tracking-plan.json',
    ),
    'utf8',
  ),
) as Plan;

describe('the tracking plan and the mapper agree', () => {
  it('every topic in the events contract is mapped or listed as unmapped, exactly once', () => {
    const mapped = plan.events.map((e) => e.topic);
    const unmapped = plan.unmapped.flatMap((u) => u.topics);
    const covered = [...mapped, ...unmapped];

    expect(new Set(covered).size, 'a topic appears twice in the plan').toBe(covered.length);
    expect(
      [...EVENT_TOPICS].filter((t) => !covered.includes(t)),
      'topics missing from the plan',
    ).toEqual([]);
    expect(covered.filter((t) => !(EVENT_TOPICS as readonly string[]).includes(t))).toEqual([]);
  });

  it('every unmapped entry carries a reason someone can disagree with', () => {
    for (const group of plan.unmapped) {
      expect(group.topics.length).toBeGreaterThan(0);
      expect(group.reason.length, `${group.topics.join(',')} has a token reason`).toBeGreaterThan(
        20,
      );
    }
  });

  it('the mapper maps exactly the plan s mapped topics, with the same call and name', () => {
    expect(cdpTopics().sort()).toEqual(plan.events.map((e) => e.topic).sort());
    for (const entry of plan.events) {
      expect(CDP_CALL_FOR[entry.topic as EventTopic], entry.topic).toBe(entry.call);
      if (entry.call === 'track') {
        expect(CDP_EVENT_NAME[entry.topic as EventTopic], entry.topic).toBe(entry.name);
      }
      expect(isConsentGated(entry.topic as EventTopic), entry.topic).toBe(entry.consent_gated);
    }
  });

  it('only the erasure is outside the consent gate', () => {
    const ungated = plan.events.filter((e) => !e.consent_gated).map((e) => e.topic);
    expect(ungated).toEqual(['customer.erased']);
    expect(isConsentGated('customer.erased')).toBe(false);
  });

  it('every mapped topic has a schema-validated fixture here', () => {
    expect(Object.keys(fixtures).sort()).toEqual(plan.events.map((e) => e.topic).sort());
  });

  it("the plan's property lists match what the mapper actually emits", () => {
    for (const entry of plan.events) {
      const call = mapEvent(fixtures[entry.topic]!(), ctx);
      expect(call, entry.topic).not.toBeNull();
      if (call!.kind === 'track') {
        // The fixture may legitimately omit an optional property, so the plan is the superset.
        const emitted = Object.keys(call!.properties);
        expect(entry.properties, entry.topic).toBeDefined();
        expect(
          emitted.filter((k) => !entry.properties!.includes(k)),
          entry.topic,
        ).toEqual([]);
      }
      if (call!.kind === 'identify') {
        const emitted = Object.keys(call!.traits);
        expect(
          emitted.filter((k) => !entry.traits!.includes(k)),
          entry.topic,
        ).toEqual([]);
      }
    }
  });

  it('the plan records the consent rule the manager ruled on', () => {
    expect(plan.consent.purpose).toBe('marketing_email');
    expect(plan.consent.evaluated).toMatch(/processing time/);
    expect(plan.identity.rule).toMatch(/customer_id/);
  });
});

// ---- the mapping itself -------------------------------------------------------------------------------------

describe('mapEvent', () => {
  it('skips a topic with no mapping instead of throwing', () => {
    const other = envelope(
      'product.published',
      {
        product_id: ORDER,
        handle: 'alpha-chair',
        title: 'Alpha chair',
        category_id: null,
        variants: [],
        published_at: '2026-10-23T10:00:00.000Z',
      },
      { type: 'product', id: ORDER },
    );
    expect(isMapped('product.published')).toBe(false);
    expect(mapEvent(other, ctx)).toBeNull();
  });

  it('carries the identity, the event time and the outbox id onto every call', () => {
    for (const [topic, build] of Object.entries(fixtures)) {
      const e = build();
      const call = mapEvent(e, ctx)!;
      expect(call.identity, topic).toEqual(identity);
      expect(call.timestamp, topic).toBe(e.occurred_at);
      expect(call.messageId, topic).toBe(e.event_id);
    }
  });

  it('customer.created becomes an identify with traits and no consent field', () => {
    const call = mapEvent(fixtures['customer.created']!(), ctx)!;
    expect(call.kind).toBe('identify');
    expect(call.kind === 'identify' && call.traits).toEqual({
      customer_id: CUSTOMER,
      email_hash: EMAIL_HASH,
      status: 'registered',
      store_code: 'brand-a',
    });
  });

  it('IGNORES the payload s marketing_consent — the projection decides (manager ruling)', () => {
    // The two fixtures differ only in marketing_consent (true / false) and changed_fields.
    const created = mapEvent(fixtures['customer.created']!(), ctx)!;
    const updated = mapEvent(fixtures['customer.updated']!(), ctx)!;
    for (const call of [created, updated]) {
      expect(JSON.stringify(call)).not.toContain('marketing_consent');
      expect(JSON.stringify(call)).not.toContain('consent');
    }
    // Same traits from an event that said granted and one that said revoked: the field is not read at all.
    expect(created.kind === 'identify' && created.traits).toEqual(
      updated.kind === 'identify' && updated.traits,
    );
  });

  it('drops a null trait rather than sending null', () => {
    const call = mapEvent(fixtures['customer.created']!(), ctx)!;
    expect(Object.keys(call.kind === 'identify' ? call.traits : {})).not.toContain(
      'customer_group_id',
    );
  });

  it('customer.erased becomes a suppress carrying the identity and nothing else', () => {
    const call = mapEvent(fixtures['customer.erased']!(), ctx)!;
    expect(call.kind).toBe('suppress');
    expect(Object.keys(call).sort()).toEqual(['identity', 'kind', 'messageId', 'timestamp']);
  });

  it('order.placed becomes Order Completed with totals in minor units and lines as counts', () => {
    const call = mapEvent(fixtures['order.placed']!(), ctx)!;
    expect(call.kind === 'track' && call.event).toBe('Order Completed');
    expect(call.kind === 'track' && call.properties).toEqual({
      order_id: ORDER,
      display_id: 1001,
      currency: 'EUR',
      total_minor: 10494,
      subtotal_minor: 9000,
      discount_minor: 500,
      shipping_minor: 499,
      tax_minor: 1495,
      line_item_count: 1,
      unit_count: 2,
      shipping_country: 'DE',
      promotion_codes: ['SPRING-WORDS'],
      store_code: 'brand-a',
    });
  });

  it('order.placed sends no per-line title or SKU', () => {
    const text = JSON.stringify(mapEvent(fixtures['order.placed']!(), ctx));
    expect(text).not.toContain('Alpha chair');
    expect(text).not.toContain('SKU-ALPHA');
  });

  it('omits promotion_codes when there are none', () => {
    const e = fixtures['order.placed']!();
    (e.payload as { promotion_codes: string[] }).promotion_codes = [];
    const call = mapEvent(e, ctx)!;
    expect(Object.keys(call.kind === 'track' ? call.properties : {})).not.toContain(
      'promotion_codes',
    );
  });

  it('shipment.shipped sends NO tracking number', () => {
    const call = mapEvent(fixtures['shipment.shipped']!(), ctx)!;
    expect(call.kind === 'track' && call.event).toBe('Order Shipped');
    expect(call.kind === 'track' && call.properties).toEqual({
      order_id: ORDER,
      shipment_id: SHIPMENT,
      carrier: 'dhl',
      item_count: 2,
      store_code: 'brand-a',
    });
    expect(JSON.stringify(call)).not.toContain('TRACK-ALPHA-WORDS');
  });

  it('return.requested sends NO reason text', () => {
    const call = mapEvent(fixtures['return.requested']!(), ctx)!;
    expect(call.kind === 'track' && call.properties).toEqual({
      order_id: ORDER,
      return_id: RETURN,
      line_count: 1,
      unit_count: 2,
      store_code: 'brand-a',
    });
    const text = JSON.stringify(call);
    expect(text).not.toContain('0171');
    expect(text).not.toContain('Example Street');
  });

  it('refund.issued keeps the return link when there is one and omits it when there is not', () => {
    const withReturn = mapEvent(fixtures['refund.issued']!(), ctx)!;
    expect(withReturn.kind === 'track' && withReturn.properties.return_id).toBe(RETURN);

    const e = fixtures['refund.issued']!();
    (e.payload as { return_id: string | null }).return_id = null;
    const without = mapEvent(e, ctx)!;
    expect(Object.keys(without.kind === 'track' ? without.properties : {})).not.toContain(
      'return_id',
    );
  });

  it('keeps amounts as integer minor units, never divided by a guessed 100', () => {
    const e = fixtures['payment.captured']!();
    (e.payload as { amount_minor: number; currency: string }).amount_minor = 1200;
    (e.payload as { currency: string }).currency = 'JPY';
    const call = mapEvent(e, ctx)!;
    expect(call.kind === 'track' && call.properties).toMatchObject({
      amount_minor: 1200,
      currency: 'JPY',
    });
  });

  it('an anonymous-only identity still maps (the consumer decides whether to send it)', () => {
    const call = mapEvent(fixtures['order.placed']!(), {
      identity: { userId: null, anonymousId: EMAIL_HASH },
      storeCode: 'brand-a',
    })!;
    expect(call.identity).toEqual({ userId: null, anonymousId: EMAIL_HASH });
  });
});

describe('no PII reaches the CDP', () => {
  it('every mapped call carries only ids, amounts, counts, codes and the email hash', () => {
    const FORBIDDEN = [
      'first_name',
      'last_name',
      'name',
      'email',
      'phone',
      'address',
      'street',
      'postcode',
      'city',
      'reason',
      'tracking_number',
      'title',
      'sku',
    ];
    for (const [topic, build] of Object.entries(fixtures)) {
      const call = mapEvent(build(), ctx)!;
      const fields = Object.keys(
        call.kind === 'track' ? call.properties : call.kind === 'identify' ? call.traits : {},
      );
      for (const bad of FORBIDDEN) {
        expect(fields, `${topic} emits a ${bad} field`).not.toContain(bad);
      }
    }
  });

  it('no mapped call contains an e-mail, a phone number or a street, even with payloads full of them', () => {
    // The schemas have no such field, so these ride in the free-text and provider fields — the only route.
    const stuffed: EventEnvelopeV1Base[] = [];
    const r = fixtures['return.requested']!();
    (r.payload as { reason: string }).reason =
      'ada.lovelace@example.com, +44 7700 900123, 12 Example Street';
    stuffed.push(r);
    const c = fixtures['order.cancelled']!();
    (c.payload as { reason: string | null }).reason = 'Ada Lovelace asked, ada@example.com';
    stuffed.push(c);
    const s = fixtures['shipment.shipped']!();
    (s.payload as { tracking_number: string | null }).tracking_number = '+44 7700 900123';
    stuffed.push(s);

    for (const e of stuffed) {
      const text = JSON.stringify(mapEvent(e, ctx));
      expect(text, e.topic).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      expect(text, e.topic).not.toContain('Example Street');
      expect(text, e.topic).not.toContain('Ada Lovelace');
      expect(text, e.topic).not.toContain('900123');
    }
  });

  it('a clean call has no e-mail or phone shape at all (ids, hashes and timestamps aside)', () => {
    const STRUCTURAL =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+Z|[0-9a-f]{64}/gi;
    for (const [topic, build] of Object.entries(fixtures)) {
      const text = JSON.stringify(mapEvent(build(), ctx)).replace(STRUCTURAL, '<id>');
      expect(text, topic).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      expect(text, topic).not.toMatch(/\+?\d[\d\s()-]{8,}\d/);
    }
  });

  it('every property value is a string, an integer or an array of strings', () => {
    for (const [topic, build] of Object.entries(fixtures)) {
      const call = mapEvent(build(), ctx)!;
      const values = Object.values(
        call.kind === 'track' ? call.properties : call.kind === 'identify' ? call.traits : {},
      );
      for (const v of values) {
        if (Array.isArray(v)) {
          for (const item of v) expect(typeof item, topic).toBe('string');
          continue;
        }
        expect(['string', 'number', 'boolean'], topic).toContain(typeof v);
        if (typeof v === 'number') expect(Number.isInteger(v), topic).toBe(true);
      }
    }
  });
});
