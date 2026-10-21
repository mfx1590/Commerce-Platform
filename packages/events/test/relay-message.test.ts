// The wire format (#531): outbox row → envelope → Kafka message → decoded envelope, one definition for everybody.
import { describe, expect, it } from 'vitest';
import {
  createValidator,
  decodeMessage,
  envelopeToMessage,
  HEADER_OUTBOX_ID,
  HEADER_STORE_ID,
  makeEvent,
  outboxRowToEnvelope,
  toOutboxRow,
  type OutboxRow,
} from '../src/index.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = '00000000-0000-4000-8000-000000000031';
const ACTOR = '00000000-0000-4000-8000-000000000077';

const event = makeEvent({
  topic: 'store.updated',
  organizationId: ORG,
  storeId: STORE,
  aggregateType: 'store',
  aggregateId: STORE,
  actor: { type: 'staff', id: ACTOR },
  trace: { request_id: 'req-1', trace_id: null, correlation_id: null, causation_id: null },
  payload: { store_id: STORE, code: 'brand-a', status: 'draft', changed_fields: ['name'] },
});

/** What pg hands the relay: jsonb parsed, timestamptz as Date. */
function asDbRow(e: typeof event): OutboxRow {
  const r = toOutboxRow(e);
  return { ...r, occurred_at: new Date(r.occurred_at) };
}

describe('outboxRowToEnvelope', () => {
  it('is the inverse of toOutboxRow and validates against the envelope schema', () => {
    const back = outboxRowToEnvelope(asDbRow(event));
    expect(back).toEqual(event);
    expect(createValidator().validateEnvelope(back)).toEqual({ ok: true, errors: [] });
  });

  it('defaults a missing actor to system and leaves an empty trace out', () => {
    const row = { ...asDbRow(event), headers: {} };
    const back = outboxRowToEnvelope(row);
    expect(back.actor).toEqual({ type: 'system', id: null });
    expect('trace' in back).toBe(false);
    expect(createValidator().validateEnvelope(back).ok).toBe(true);
    expect(outboxRowToEnvelope({ ...row, headers: null }).actor).toEqual({
      type: 'system',
      id: null,
    });
  });

  it('keeps a string occurred_at as it is', () => {
    expect(
      outboxRowToEnvelope({ ...asDbRow(event), occurred_at: '2026-10-20T10:00:00.000Z' })
        .occurred_at,
    ).toBe('2026-10-20T10:00:00.000Z');
  });
});

describe('envelopeToMessage / decodeMessage', () => {
  it('key = store_id, value = the envelope JSON, headers carry the outbox id and the routing facts', () => {
    const m = envelopeToMessage(event, 'core-outbox-relay/1');
    expect(m.key).toBe(STORE);
    expect(JSON.parse(m.value)).toEqual(event);
    expect(m.headers).toEqual({
      outbox_id: event.event_id,
      event_id: event.event_id,
      topic: 'store.updated',
      version: '1',
      organization_id: ORG,
      store_id: STORE,
      occurred_at: event.occurred_at,
      producer: 'core-outbox-relay/1',
    });
  });

  it('an organization-scope event is keyed by the organization and has no store_id header', () => {
    const m = envelopeToMessage({ ...event, store_id: null }, 'p');
    expect(m.key).toBe(ORG);
    expect(m.headers[HEADER_STORE_ID]).toBeUndefined();
  });

  it('round-trips through Buffers the way kafkajs delivers them', () => {
    const m = envelopeToMessage(event, 'p');
    const d = decodeMessage({
      key: Buffer.from(m.key),
      value: Buffer.from(m.value),
      headers: Object.fromEntries(Object.entries(m.headers).map(([k, v]) => [k, Buffer.from(v)])),
    });
    expect(d.envelope).toEqual(event);
    expect(d.outboxId).toBe(event.event_id);
    expect(d.headers).toEqual(m.headers);
  });

  it('falls back to the envelope event_id when the outbox_id header is missing, and rejects what is not an envelope', () => {
    const m = envelopeToMessage(event, 'p');
    const headers = { ...m.headers };
    delete headers[HEADER_OUTBOX_ID];
    expect(decodeMessage({ value: m.value, headers }).outboxId).toBe(event.event_id);
    expect(() => decodeMessage({ value: null })).toThrow('no value');
    expect(() => decodeMessage({ value: '{not json' })).toThrow('not JSON');
    expect(() => decodeMessage({ value: '{"a":1}' })).toThrow('not an event envelope');
    expect(() => decodeMessage({ value: '42' })).toThrow('not an event envelope');
  });
});
