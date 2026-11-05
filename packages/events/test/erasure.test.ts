// The erasure rules every replay applies (#629; in this package since #703, shared by the core's outbox replay and
// replayFromDlq). The guard walks every schema: a new topic whose payload names a customer fails here, in the
// package where the schema is added, until it has a rule.
import { describe, expect, it } from 'vitest';
import {
  actorErased,
  createValidator,
  ERASURE_RULES,
  erasedSetFrom,
  makeEvent,
  EVENT_SCHEMAS,
  EVENT_TOPICS,
  namesErased,
  scrubErased,
} from '../src/index.js';

const X = '33000000-0000-4000-8000-000000000001';
const Y = '33000000-0000-4000-8000-000000000002';
const HX = 'a1'.repeat(32);
const customerActor = (id: string | null) => ({ type: 'customer' as const, id });

describe('ERASURE_RULES', () => {
  it('covers every schema that names a customer anywhere in it (customer_id, *_customer_id, email_hash, identity_id, requested_by), except customer.erased', () => {
    // recursive: nested properties, array items and oneOf/anyOf/allOf branches count too (#700 review)
    const propertyNames = (s: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(s)) for (const x of s) propertyNames(x, out);
      else if (s && typeof s === 'object') {
        const o = s as Record<string, unknown>;
        for (const [k, v] of Object.entries((o.properties as object) ?? {})) {
          out.add(k);
          propertyNames(v, out);
        }
        for (const k of ['items', 'prefixItems', 'oneOf', 'anyOf', 'allOf'])
          propertyNames(o[k], out);
      }
      return out;
    };
    const NAMES_CUSTOMER = /(^|_)customer_id$|^email_hash$|^identity_id$|^requested_by$/;
    const naming = Object.entries(EVENT_SCHEMAS)
      .filter(([, s]) => [...propertyNames(s)].some((k) => NAMES_CUSTOMER.test(k)))
      .map(([key]) => key.split('@')[0]!);
    // the walker reaches nested names (order.placed's line items) and branches (cart.abandoned's nullable hash)
    expect(propertyNames(EVENT_SCHEMAS['order.placed@1'])).toContain('order_line_item_id');
    const topics = [...new Set(naming)].filter((t) => t !== 'customer.erased').sort();
    expect(Object.keys(ERASURE_RULES).sort()).toEqual(topics);
    for (const t of Object.keys(ERASURE_RULES)) expect(EVENT_TOPICS).toContain(t);
  });

  it('matches per store, by customer id or e-mail hash, and every referral party', () => {
    const erased = { customers: 1, keys: new Set([`s1|c:${X}`, `s1|h:${HX}`]) };
    expect(namesErased('order.placed', 's1', { customer_id: null, email_hash: HX }, erased)).toBe(
      true,
    );
    expect(namesErased('order.placed', 's2', { customer_id: X, email_hash: HX }, erased)).toBe(
      false,
    );
    expect(
      namesErased(
        'referral.converted',
        's1',
        { referrer_customer_id: Y, referee_customer_id: X },
        erased,
      ),
    ).toBe(true);
    expect(namesErased('customer.erased', 's1', { customer_id: X }, erased)).toBe(false);
    expect(namesErased('payment.captured', 's1', { customer_id: X }, erased)).toBe(false);
    // the envelope actor: a customer erased in that store, never a staff id that happens to match
    expect(actorErased('s1', customerActor(X), erased)).toBe(true);
    expect(actorErased('s2', customerActor(X), erased)).toBe(false);
    expect(actorErased('s1', { type: 'staff', id: X }, erased)).toBe(false);
    expect(actorErased('s1', customerActor(null), erased)).toBe(false);
  });
});

describe('erasedSetFrom', () => {
  it('keys each erasure by store, customer id and (v2) e-mail hash; empty and missing ids add nothing', () => {
    const set = erasedSetFrom([
      { storeId: 's1', customerId: X, emailHash: HX },
      { storeId: 's2', customerId: Y, emailHash: undefined }, // v1: no hash
      { storeId: null, customerId: '', emailHash: null },
    ]);
    expect(set.customers).toBe(3);
    expect([...set.keys].sort()).toEqual([`s1|c:${X}`, `s1|h:${HX}`, `s2|c:${Y}`].sort());
    expect(namesErased('cart.abandoned', 's2', { customer_id: Y, email_hash: HX }, set)).toBe(true);
    expect(namesErased('cart.abandoned', 's2', { customer_id: X, email_hash: HX }, set)).toBe(
      false,
    );
  });
});

describe('scrubErased (#629)', () => {
  const order = (customerId: string | null) =>
    makeEvent({
      topic: 'order.placed',
      organizationId: '33000000-0000-4000-8000-0000000000e1',
      storeId: '33000000-0000-4000-8000-0000000000e2',
      aggregateType: 'order',
      aggregateId: '33000000-0000-4000-8000-0000000000e3',
      actor: customerActor(customerId),
      payload: {
        order_id: '33000000-0000-4000-8000-0000000000e3',
        display_id: 7,
        legal_entity_id: '33000000-0000-4000-8000-0000000000e4',
        sales_channel_id: '33000000-0000-4000-8000-0000000000e5',
        customer_id: customerId,
        email_hash: HX,
        currency: 'EUR',
        locale: 'en-GB',
        totals: {
          subtotal_minor: 1999,
          discount_minor: 0,
          shipping_minor: 0,
          tax_minor: 0,
          total_minor: 1999,
        },
        line_items: [],
        shipping: {
          shipping_option_id: null,
          code: 'standard',
          name: 'Standard',
          carrier: 'manual',
          price_minor: 0,
        },
        shipping_country: 'NL',
        billing_country: 'DE',
        promotion_codes: ['WELCOME10'],
        placed_at: '2026-10-01T10:00:00.000Z',
      },
    });
  const v = createValidator();

  it('order.placed v1 or v2 → v2 with customer_id and email_hash null; everything else, event_id included, unchanged; valid v2', () => {
    for (const original of [{ ...order(X), version: 1 }, order(X), order(null)]) {
      expect(v.validateEnvelope(original).ok).toBe(true);
      const scrubbed = scrubErased(original)!;
      expect(scrubbed).toEqual({
        ...original,
        version: 2,
        payload: { ...original.payload, customer_id: null, email_hash: null },
      });
      expect(v.validateEnvelope(scrubbed)).toEqual({ ok: true, errors: [] });
      // the actor is not the scrub's business: actorErased nulls it separately
      expect(scrubbed.actor).toEqual(original.actor);
    }
    // the input is not mutated
    const o = order(X);
    scrubErased(o);
    expect((o.payload as { customer_id: string }).customer_id).toBe(X);
  });

  it('only order.placed has a scrub rule; every other topic is skipped (null)', () => {
    expect(
      Object.entries(ERASURE_RULES)
        .filter(([, r]) => r.scrub)
        .map(([t]) => t),
    ).toEqual(['order.placed']);
    expect(scrubErased({ ...order(X), topic: 'cart.abandoned' })).toBeNull();
    expect(scrubErased({ ...order(X), topic: 'payment.captured' })).toBeNull();
  });
});
