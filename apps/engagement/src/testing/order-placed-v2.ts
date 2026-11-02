// A LOCAL mock of `order.placed@2` — tests only, and deliberately not a copy of the schema (#696).
//
// `order.placed@2` is CONTRACT CHANGE #696: v1 with `email_hash` nullable, nothing else. It is window 14's to
// land in `packages/events`, and the manager's gate says it lands only once every consumer accepts v1 AND v2
// — so this service has to be provably ready BEFORE the schema exists here. Until then the SDK skips a v2
// message (`KNOWN` is keyed `topic@version`), which is exactly what the gate relies on.
//
// Two decisions worth knowing:
//
//   * the mock is DERIVED from the real `order.placed@1` schema rather than hand-copied: clone it, give it the
//     v2 `$id`, and make `email_hash` `oneOf [sha256, null]`. That is the issue's diff expressed as code, and
//     it means a later change to v1 cannot leave this mock describing a version that no longer exists. A
//     hand-written copy would silently become fiction.
//   * a v2 FIXTURE is built from an already-validated v1 envelope, so no test duplicates the payload. The
//     field under test is the only difference, which is the whole point of "v2 = v1 with one field nullable".
//
// When #696 lands, this file goes away: `envelopeFor(..., 2)` with the real validator replaces it, and the
// tests that use it keep their assertions. Nothing here is imported by `src/` — only by tests.

import { COMMON_SCHEMA, ENVELOPE_SCHEMA, EVENT_SCHEMAS, createValidator } from '@platform/events';
import type { EventEnvelopeV1Base } from '@platform/events';

/** The version #696 adds. Named so a test reads as "v2", not as a bare `2`. */
export const ORDER_PLACED_V2 = 2;

const SHA256_REF = `${(COMMON_SCHEMA as { $id: string }).$id}#/$defs/sha256`;

/**
 * The mock schema: `order.placed@1` with `email_hash` nullable. Exported so a test can assert the mock is
 * what #696 describes rather than something this file invented.
 */
export function orderPlacedV2Schema(): Record<string, unknown> {
  const v1 = (EVENT_SCHEMAS as Record<string, unknown>)['order.placed@1'];
  if (!v1)
    throw new Error('order.placed@1 is not in EVENT_SCHEMAS — the mock has nothing to derive from');
  const schema = structuredClone(v1) as Record<string, unknown>;
  schema.$id = 'https://schemas.commerce-platform.dev/events/order.placed/v2.json';
  schema.title = 'order.placed v2 (LOCAL MOCK of CONTRACT CHANGE #696)';
  const properties = schema.properties as Record<string, unknown>;
  // The one change. `required` is untouched: the key must still be PRESENT, and null is what it may hold —
  // which is the difference between "an erased customer" and "a producer that forgot the field".
  properties.email_hash = { oneOf: [{ $ref: SHA256_REF }, { type: 'null' }] };
  return schema;
}

let compiled: ((payload: unknown) => boolean) | undefined;
let envelopeCheck: ((event: unknown) => boolean) | undefined;
let errorsOf: () => string;

function validators(): void {
  if (compiled && envelopeCheck) return;
  // One validator instance, which already has COMMON_SCHEMA registered and ENVELOPE_SCHEMA compiled; the mock
  // joins it under the real v2 `$id`, so the `$ref` to common/v1.json resolves exactly as the real schema's
  // does.
  const { ajv } = createValidator();
  // THE REAL ONE WINS (#705 review, must-fix): the mock deliberately carries the `$id` the published schema
  // will have, and `createValidator()` compiles every schema in `EVENT_SCHEMAS` — so the day #696 lands,
  // `ajv.compile(mock)` would throw "already exists" and every test here would fail on a change that is
  // supposed to make them pass. Asking for the id first means this file hands over to the published schema by
  // itself: before #696 the lookup misses and the mock is compiled; after it, the real @2 validates the
  // fixtures and the mock is never used.
  const id = (orderPlacedV2Schema() as { $id: string }).$id;
  const payloadFn = ajv.getSchema(id) ?? ajv.compile(orderPlacedV2Schema());
  const envelopeFn = ajv.getSchema((ENVELOPE_SCHEMA as { $id: string }).$id);
  if (!envelopeFn) throw new Error('the envelope schema is not compiled in this validator');
  compiled = (payload) => payloadFn(payload) === true;
  envelopeCheck = (event) => envelopeFn(event) === true;
  errorsOf = () =>
    [...(payloadFn.errors ?? []), ...(envelopeFn.errors ?? [])]
      .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
      .join('; ');
}

/** True once `packages/events` publishes @2, i.e. once this mock has been superseded (#696). */
export function orderPlacedV2IsPublished(): boolean {
  return 'order.placed@2' in (EVENT_SCHEMAS as Record<string, unknown>);
}

/** Does this payload satisfy `order.placed@2`? Used to pin the mock's own behaviour in a test. */
export function validatesAsV2(payload: unknown): boolean {
  validators();
  return compiled!(payload);
}

/**
 * An `order.placed@2` envelope, from a VALIDATED v1 one: version 2, and `email_hash` set to `hash` — `null`
 * for the erased-customer case the replay produces. Throws unless the result validates against both the real
 * envelope schema and the mock payload schema, so a fixture cannot drift into a shape no producer could write.
 */
export function toOrderPlacedV2(
  v1: EventEnvelopeV1Base,
  over: { emailHash: string | null; customerId?: string | null },
): EventEnvelopeV1Base {
  if (v1.topic !== 'order.placed') throw new Error(`not an order.placed envelope: ${v1.topic}`);
  const payload = {
    ...(v1.payload as Record<string, unknown>),
    email_hash: over.emailHash,
    ...(over.customerId === undefined ? {} : { customer_id: over.customerId }),
  };
  const envelope = { ...v1, version: ORDER_PLACED_V2, payload } as EventEnvelopeV1Base;
  validators();
  if (!compiled!(payload) || !envelopeCheck!(envelope)) {
    throw new Error(`order.placed@2 fixture is invalid: ${errorsOf()}`);
  }
  return envelope;
}
