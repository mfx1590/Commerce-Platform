// A LOCAL mock of `order.placed@2`, for tests only (#696 gate). Nothing in src/ imports it.
//
// CONTRACT CHANGE #696 makes `email_hash` nullable (an erased customer, scrubbed by the outbox replay) and changes
// nothing else. It lands in packages/events only once every consumer accepts v1 AND v2, so this service has to be
// provably ready before the schema exists here. The mock follows window 16's (#705):
//
//   * it is DERIVED from the real `order.placed@1`: a clone with the v2 `$id` and `email_hash` as
//     `oneOf [sha256, null]`. That is the issue's diff as code, so a later change to v1 cannot leave the mock
//     describing a version that no longer exists;
//   * it STEPS ASIDE once @2 is published. `withEventSchemasV2` adds the mock only where the real map has no
//     @2, and `withOrderPlacedV2` asks the validator for the v2 `$id` first (`ajv.getSchema(id) ?? compile`), so
//     the day #696 lands, the published schema validates the fixtures and the mock is never compiled.
//
// When #696 lands this file goes away; the tests keep their assertions.
//
// The derivation takes the real schemas as arguments, with no import from @platform/events, so a test's
// `vi.mock('@platform/events')` factory can call it on the ORIGINAL module without importing itself.
import type { EventEnvelopeV1Base, Validator } from '@platform/events';

export const ORDER_PLACED_V2 = 2;
export const ORDER_PLACED_V2_ID =
  'https://schemas.commerce-platform.dev/events/order.placed/v2.json';

/** `order.placed@1` with `email_hash` nullable, and nothing else changed (#696). */
export function deriveOrderPlacedV2(
  eventSchemas: Readonly<Record<string, unknown>>,
  commonSchema: unknown,
): Record<string, unknown> {
  const v1 = eventSchemas['order.placed@1'];
  if (!v1)
    throw new Error('order.placed@1 is not in EVENT_SCHEMAS: the mock has nothing to derive from');
  const schema = structuredClone(v1) as Record<string, unknown>;
  schema.$id = ORDER_PLACED_V2_ID;
  schema.title = 'order.placed v2 (LOCAL MOCK of CONTRACT CHANGE #696)';
  // `required` is untouched: the key must still be present; null is what it may now hold.
  (schema.properties as Record<string, unknown>).email_hash = {
    oneOf: [{ $ref: `${(commonSchema as { $id: string }).$id}#/$defs/sha256` }, { type: 'null' }],
  };
  return schema;
}

/** EVENT_SCHEMAS plus the mock @2, unless the real map already has one (then it is returned as is). */
export function withEventSchemasV2(
  eventSchemas: Readonly<Record<string, unknown>>,
  commonSchema: unknown,
): Readonly<Record<string, unknown>> {
  if ('order.placed@2' in eventSchemas) return eventSchemas;
  return { ...eventSchemas, 'order.placed@2': deriveOrderPlacedV2(eventSchemas, commonSchema) };
}

/**
 * The validator, able to validate `order.placed@2`: the published schema when the validator has it, the mock
 * otherwise. Every other topic and version goes to the validator unchanged.
 */
export function withOrderPlacedV2(
  validator: Validator,
  eventSchemas: Readonly<Record<string, unknown>>,
  commonSchema: unknown,
  envelopeSchema: unknown,
): Validator {
  const { ajv } = validator;
  // THE REAL ONE WINS: the mock carries the `$id` the published schema will have, so compiling it next to the
  // real one would throw "already exists"
  const payloadFn =
    ajv.getSchema(ORDER_PLACED_V2_ID) ??
    ajv.compile(deriveOrderPlacedV2(eventSchemas, commonSchema));
  const envelopeFn = ajv.getSchema((envelopeSchema as { $id: string }).$id);
  if (!envelopeFn) throw new Error('the envelope schema is not compiled in this validator');
  const errors = (fn: { errors?: { instancePath?: string; message?: string }[] | null }) =>
    (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  const isV2 = (topic: string, version: number) =>
    topic === 'order.placed' && version === ORDER_PLACED_V2;
  const validatePayload: Validator['validatePayload'] = (topic, version, payload) => {
    if (!isV2(topic, version)) return validator.validatePayload(topic, version, payload);
    return payloadFn(payload) ? { ok: true, errors: [] } : { ok: false, errors: errors(payloadFn) };
  };
  const validateEnvelope: Validator['validateEnvelope'] = (event) => {
    const e = event as Partial<EventEnvelopeV1Base>;
    if (!isV2(String(e?.topic), Number(e?.version))) return validator.validateEnvelope(event);
    if (!envelopeFn(event)) return { ok: false, errors: errors(envelopeFn) };
    const p = validatePayload('order.placed', ORDER_PLACED_V2, e.payload);
    return p.ok ? p : { ok: false, errors: p.errors.map((m) => `/payload${m}`) };
  };
  return { ajv, validatePayload, validateEnvelope };
}

/**
 * An `order.placed@2` envelope from a v1 one: version 2 and `email_hash` set (null = the erased customer the
 * replay writes); `customerId` too when given. The caller validates it, so a fixture cannot drift into a shape
 * no producer could write.
 */
export function toOrderPlacedV2(
  v1: EventEnvelopeV1Base,
  over: { emailHash: string | null; customerId?: string | null },
): EventEnvelopeV1Base {
  if (v1.topic !== 'order.placed') throw new Error(`not an order.placed envelope: ${v1.topic}`);
  const payload = {
    ...(v1.payload as unknown as Record<string, unknown>),
    email_hash: over.emailHash,
    ...(over.customerId === undefined ? {} : { customer_id: over.customerId }),
  };
  return { ...v1, version: ORDER_PLACED_V2, payload } as unknown as EventEnvelopeV1Base;
}
