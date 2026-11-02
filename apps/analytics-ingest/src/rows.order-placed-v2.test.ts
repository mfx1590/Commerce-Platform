// The #696 gate, ingest side: `order.placed` v1 AND v2 (email_hash nullable) are both classified into raw_events, a
// null email_hash stays null (no crash, no placeholder), and the erasure scrub passes over it.
//
// @2 is not published yet, so this file runs the ingest as it will be the day #696 lands: `KNOWN` in rows.ts is
// built from EVENT_SCHEMAS at import, and the mock below adds the derived @2 to it (testing/order-placed-v2.ts).
// Once the real @2 exists the mock steps aside and the same assertions run against the published schema.
// rows.test.ts pins today's behaviour, without the mock: @2 is dead-lettered, not lost and not a crash.
import type * as Events from '@platform/events';
import { createValidator, EVENT_SCHEMAS, type EventEnvelopeV1Base } from '@platform/events';
import { describe, expect, it, vi } from 'vitest';
import { createErasureIndex } from './erasure.js';
import { classify } from './rows.js';
import { toWire } from './testing/fakes.js';
import { generateMonth } from './testing/month.js';
import { ORDER_PLACED_V2, toOrderPlacedV2 } from './testing/order-placed-v2.js';

vi.mock('@platform/events', async (importOriginal) => {
  const real = await importOriginal<typeof Events>();
  const { withEventSchemasV2, withOrderPlacedV2 } = await import('./testing/order-placed-v2.js');
  // every validator in this file (the month generator's included) knows @2
  const createValidator = () =>
    withOrderPlacedV2(
      real.createValidator(),
      real.EVENT_SCHEMAS,
      real.COMMON_SCHEMA,
      real.ENVELOPE_SCHEMA,
    );
  return {
    ...real,
    createValidator,
    EVENT_SCHEMAS: withEventSchemasV2(real.EVENT_SCHEMAS, real.COMMON_SCHEMA),
  };
});

const validator = createValidator();
const now = new Date('2026-11-02T09:00:01.500Z');
const ctx = { groupId: 'analytics.raw', validator, now };
const batch = { topic: 'order.placed', partition: 0 };
const placed = generateMonth({ perKey: 2 }).events.find(
  (e) => e.topic === 'order.placed' && e.version === 1,
)!;
const payloadOf = (e: EventEnvelopeV1Base) => e.payload as unknown as Record<string, unknown>;
// the replay's scrubbed order: nobody to attribute it to
const erased = toOrderPlacedV2(placed, { emailHash: null, customerId: null });

describe('order.placed v1 and v2 (#696 gate)', () => {
  it('pins the mock: @2 is v1 with email_hash nullable — v1 refuses the null, @2 takes it and still takes a hash', () => {
    expect(EVENT_SCHEMAS).toHaveProperty(['order.placed@2']);
    expect(validator.validateEnvelope(placed)).toEqual({ ok: true, errors: [] });
    expect(validator.validateEnvelope(erased)).toEqual({ ok: true, errors: [] });
    const named = toOrderPlacedV2(placed, { emailHash: payloadOf(placed).email_hash as string });
    expect(validator.validateEnvelope(named)).toEqual({ ok: true, errors: [] });
    expect(validator.validateEnvelope({ ...erased, version: 1 }).ok).toBe(false);
    // the key stays required: an erased customer is null, a producer that forgot the field is invalid
    const { email_hash: _gone, ...noKey } = payloadOf(erased);
    expect(validator.validateEnvelope({ ...erased, payload: noKey }).ok).toBe(false);
    expect(
      validator.validateEnvelope({
        ...erased,
        payload: { ...payloadOf(erased), email_hash: 'x@example.test' },
      }).ok,
    ).toBe(false);
  });

  it('classifies v1 and v2 alike: a v2 row differs from the v1 row only in version and the email_hash it carried', () => {
    const v1 = classify(toWire(placed, 1), batch, ctx);
    const named = toOrderPlacedV2(placed, { emailHash: payloadOf(placed).email_hash as string });
    const v2 = classify(toWire(named, 2), batch, ctx);
    expect(v1.kind).toBe('row');
    expect(v2.kind).toBe('row');
    if (v1.kind !== 'row' || v2.kind !== 'row') return;
    expect(v2.row).toEqual({ ...v1.row, version: ORDER_PLACED_V2 });
  });

  it('keeps a null email_hash and a null customer_id as null in raw_events: no crash, no placeholder', () => {
    const c = classify(toWire(erased, 3), batch, ctx);
    expect(c.kind).toBe('row');
    if (c.kind !== 'row') return;
    expect(c.row.version).toBe(ORDER_PLACED_V2);
    const stored = JSON.parse(c.row.payload) as Record<string, unknown>;
    expect(stored.email_hash).toBeNull();
    expect(stored.customer_id).toBeNull();
    // everything else is the order the ledger needs, unchanged
    expect(stored).toEqual({ ...payloadOf(placed), email_hash: null, customer_id: null });
  });

  it('runs the erasure scrub over a null email_hash without touching it (the index has entries)', () => {
    const erasures = createErasureIndex('erasure-test-word-not-a-secret');
    const hash = payloadOf(placed).email_hash as string;
    erasures.add([erasures.digest('*', 'email', hash)]);
    const c = classify(toWire(erased, 4), batch, { ...ctx, erasures });
    expect(c.kind === 'row' && JSON.parse(c.row.payload)).toMatchObject({
      email_hash: null,
      customer_id: null,
    });
    // and the same index still scrubs a v2 order that names the erased customer
    const named = toOrderPlacedV2(placed, { emailHash: hash });
    const d = classify(toWire(named, 5), batch, { ...ctx, erasures });
    expect(d.kind === 'row' && JSON.parse(d.row.payload).email_hash).toBeNull();
  });

  it('still dead-letters an invalid v2 (a raw e-mail as email_hash), as for any version', () => {
    const bad = { ...erased, payload: { ...payloadOf(erased), email_hash: 'x@example.test' } };
    const c = classify(toWire(bad as EventEnvelopeV1Base, 6), batch, ctx);
    expect(c.kind === 'dead' && c.letter.error_class).toBe('InvalidEventError');
  });
});
