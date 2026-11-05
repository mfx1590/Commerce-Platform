// A LOCAL mock of `order.placed@2` — tests only (#696), after window 16's src/testing/order-placed-v2.ts (#705) and
// window 17's (#714).
//
// `order.placed@2` is CONTRACT CHANGE #696: v1 with `email_hash` nullable, nothing else; null means the customer was
// erased (#629). It lands in `packages/events` only once every consumer accepts v1 AND v2, so the ledger has to be
// provably ready BEFORE the schema exists here.
//
// The mock is DERIVED from the real `order.placed@1` (clone, v2 `$id`, `email_hash` `oneOf [sha256, null]`), so it
// cannot drift from a v1 that has since changed. THE REAL ONE WINS: once `EVENT_SCHEMAS` carries `order.placed@2`,
// `v2AwareValidator()` is plain `createValidator()` and the mock is never compiled. Nothing in `src/` imports this
// folder except tests; `tsconfig.json` excludes it from the build.
import {
  COMMON_SCHEMA,
  createValidator,
  ENVELOPE_SCHEMA,
  EVENT_SCHEMAS,
  type EventEnvelopeV1Base,
} from '@platform/events';

/** The version #696 adds. Named so a test reads as "v2", not as a bare `2`. */
export const ORDER_PLACED_V2 = 2;

type Validator = ReturnType<typeof createValidator>;
type Result = ReturnType<Validator['validatePayload']>;

const SHA256_REF = `${(COMMON_SCHEMA as { $id: string }).$id}#/$defs/sha256`;

/** True once `packages/events` publishes @2, i.e. once this mock has been superseded (#696). */
export function orderPlacedV2IsPublished(): boolean {
  return 'order.placed@2' in (EVENT_SCHEMAS as Record<string, unknown>);
}

/** `order.placed@1` with `email_hash` nullable — the issue's diff expressed as code. */
export function orderPlacedV2Schema(): Record<string, unknown> {
  const v1 = (EVENT_SCHEMAS as Record<string, unknown>)['order.placed@1'];
  if (!v1)
    throw new Error('order.placed@1 is not in EVENT_SCHEMAS — the mock has nothing to derive from');
  const schema = structuredClone(v1) as Record<string, unknown>;
  schema.$id = 'https://schemas.commerce-platform.dev/events/order.placed/v2.json';
  schema.title = 'order.placed v2 (LOCAL MOCK of CONTRACT CHANGE #696)';
  // the one change; `required` is untouched: the key must be present, and null is what it may hold
  (schema.properties as Record<string, unknown>).email_hash = {
    oneOf: [{ $ref: SHA256_REF }, { type: 'null' }],
  };
  return schema;
}

/**
 * The validator the ledger runs with once the regenerated `@platform/events` (which knows @2) is deployed:
 * `createValidator()` plus `order.placed@2` from the mock while it is not published. Pass it as
 * `handleLedgerEvent(…, { validator })`. Everything that is not order.placed@2 goes to the real validator.
 */
export function v2AwareValidator(): Validator {
  const base = createValidator();
  if (orderPlacedV2IsPublished()) return base;
  const schema = orderPlacedV2Schema();
  const payloadFn = base.ajv.getSchema(schema.$id as string) ?? base.ajv.compile(schema);
  const envelopeFn = base.ajv.getSchema((ENVELOPE_SCHEMA as { $id: string }).$id);
  if (!envelopeFn) throw new Error('the envelope schema is not compiled in this validator');
  const errors = (fn: { errors?: unknown[] | null }) =>
    (fn.errors ?? []).map((e) => {
      const err = e as { instancePath?: string; message?: string };
      return `${err.instancePath || '/'} ${err.message ?? 'invalid'}`;
    });
  const validatePayload = (topic: string, version: number, payload: unknown): Result => {
    if (topic !== 'order.placed' || version !== ORDER_PLACED_V2)
      return base.validatePayload(topic, version, payload);
    const ok = payloadFn(payload) === true;
    return { ok, errors: ok ? [] : errors(payloadFn) };
  };
  const validateEnvelope = (event: unknown): Result => {
    const e = event as { topic?: string; version?: number; payload?: unknown };
    if (e?.topic !== 'order.placed' || e?.version !== ORDER_PLACED_V2)
      return base.validateEnvelope(event);
    if (envelopeFn(event) !== true) return { ok: false, errors: errors(envelopeFn) };
    return validatePayload('order.placed', ORDER_PLACED_V2, e.payload);
  };
  return { ...base, validatePayload, validateEnvelope };
}

/**
 * An `order.placed@2` envelope from a VALIDATED v1 one: version 2 and `email_hash` set to `emailHash` — null (with
 * `customerId: null`) for the erased-customer case. Throws unless it validates against the envelope schema and the
 * (mock or real) v2 payload schema.
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
  const r = v2AwareValidator().validateEnvelope(envelope);
  if (!r.ok) throw new Error(`order.placed@2 fixture is invalid: ${r.errors.join('; ')}`);
  return envelope;
}
