// A LOCAL mock of `order.placed@2` — tests only (#696), after window 16's src/testing/order-placed-v2.ts (#705).
//
// `order.placed@2` is CONTRACT CHANGE #696: v1 with `email_hash` nullable, nothing else; null means the customer
// was erased (the outbox replay scrubs it, #629). It lands in `packages/events` only once every consumer accepts
// v1 AND v2, so this worker has to be provably ready BEFORE the schema exists here.
//
// The mock is DERIVED from the real `order.placed@1` (clone, v2 `$id`, `email_hash` `oneOf [sha256, null]`) so
// it cannot drift into describing a v1 that has since changed. THE REAL ONE WINS: the mock carries the `$id` the
// published schema will have, and `createValidator()` compiles every schema in `EVENT_SCHEMAS` — so the day #696
// lands, the lookup finds the published @2 and the mock is never compiled. Nothing here is imported by `src/`
// code — only by tests; `tsconfig.json` excludes this folder from the build.
import { COMMON_SCHEMA, createValidator, ENVELOPE_SCHEMA, EVENT_SCHEMAS } from '@platform/events';
import type { EventEnvelopeV1Base } from '@platform/events';

/** The version #696 adds. Named so a test reads as "v2", not as a bare `2`. */
export const ORDER_PLACED_V2 = 2;

const SHA256_REF = `${(COMMON_SCHEMA as { $id: string }).$id}#/$defs/sha256`;

/** `order.placed@1` with `email_hash` nullable — the issue's diff expressed as code. */
export function orderPlacedV2Schema(): Record<string, unknown> {
  const v1 = (EVENT_SCHEMAS as Record<string, unknown>)['order.placed@1'];
  if (!v1) {
    throw new Error('order.placed@1 is not in EVENT_SCHEMAS — the mock has nothing to derive from');
  }
  const schema = structuredClone(v1) as Record<string, unknown>;
  schema.$id = 'https://schemas.commerce-platform.dev/events/order.placed/v2.json';
  schema.title = 'order.placed v2 (LOCAL MOCK of CONTRACT CHANGE #696)';
  const properties = schema.properties as Record<string, unknown>;
  // The one change. `required` is untouched: the key must still be PRESENT, and null is what it may hold.
  properties.email_hash = { oneOf: [{ $ref: SHA256_REF }, { type: 'null' }] };
  return schema;
}

let payloadOk: ((payload: unknown) => boolean) | undefined;
let envelopeOk: ((event: unknown) => boolean) | undefined;
let errorsOf: () => string = () => '';

function validators(): void {
  if (payloadOk && envelopeOk) return;
  const { ajv } = createValidator();
  const id = (orderPlacedV2Schema() as { $id: string }).$id;
  const payloadFn = ajv.getSchema(id) ?? ajv.compile(orderPlacedV2Schema());
  const envelopeFn = ajv.getSchema((ENVELOPE_SCHEMA as { $id: string }).$id);
  if (!envelopeFn) throw new Error('the envelope schema is not compiled in this validator');
  payloadOk = (payload) => payloadFn(payload) === true;
  envelopeOk = (event) => envelopeFn(event) === true;
  errorsOf = () =>
    [...(payloadFn.errors ?? []), ...(envelopeFn.errors ?? [])]
      .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
      .join('; ');
}

/** True once `packages/events` publishes @2, i.e. once this mock has been superseded (#696). */
export function orderPlacedV2IsPublished(): boolean {
  return 'order.placed@2' in (EVENT_SCHEMAS as Record<string, unknown>);
}

/** Does this payload satisfy `order.placed@2`? Pins the mock's own behaviour in a test. */
export function validatesAsV2(payload: unknown): boolean {
  validators();
  return payloadOk!(payload);
}

/**
 * An `order.placed@2` envelope from a VALIDATED v1 one: version 2 and `email_hash` set to `emailHash` — null
 * (with `customerId: null`) for the erased-customer case the replay produces. Throws unless the result
 * validates against the real envelope schema and the (mock or real) v2 payload schema.
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
  if (!payloadOk!(payload) || !envelopeOk!(envelope)) {
    throw new Error(`order.placed@2 fixture is invalid: ${errorsOf()}`);
  }
  return envelope;
}
