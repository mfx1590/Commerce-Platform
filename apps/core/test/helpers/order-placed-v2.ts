// A LOCAL, test-only mock of `order.placed@2` (CONTRACT CHANGE #696: v1 with `email_hash` nullable, nothing else),
// so the core can prove its consumer accepts v1 AND v2 before the schema lands in `packages/events` (the gate).
// Window 16's #705 is the pattern:
//
//   * the mock is DERIVED from the real `order.placed@1` (clone, the v2 `$id`, `email_hash` as `oneOf [sha256,
//     null]`) — a later change to v1 cannot leave it describing a version that no longer exists;
//   * the published schema wins: `ajv.getSchema(id) ?? ajv.compile(mock)`. `createValidator()` compiles every
//     schema in `EVENT_SCHEMAS`, so the day #696 lands the real @2 is found by its id and the mock is never
//     compiled (a second compile under the same `$id` would throw "already exists");
//   * a v2 payload is built from a real v1 payload and must validate, so a fixture cannot drift into a shape no
//     producer could write.
//
// When #696 lands this file can go: `validatePayload('order.placed', 2, …)` replaces it. Imported by tests only.
import { COMMON_SCHEMA, EVENT_SCHEMAS, createValidator } from '@platform/events';

export const ORDER_PLACED_V2_ID =
  'https://schemas.commerce-platform.dev/events/order.placed/v2.json';

const SHA256_REF = `${(COMMON_SCHEMA as { $id: string }).$id}#/$defs/sha256`;

/** `order.placed@1` with `email_hash` nullable (`required` untouched: the key stays present, null is its value). */
export function orderPlacedV2Schema(): Record<string, unknown> {
  const v1 = (EVENT_SCHEMAS as Record<string, unknown>)['order.placed@1'];
  if (!v1)
    throw new Error('order.placed@1 is not in EVENT_SCHEMAS: nothing to derive the mock from');
  const schema = structuredClone(v1) as Record<string, unknown>;
  schema.$id = ORDER_PLACED_V2_ID;
  schema.title = 'order.placed v2 (LOCAL MOCK of CONTRACT CHANGE #696)';
  (schema.properties as Record<string, unknown>).email_hash = {
    oneOf: [{ $ref: SHA256_REF }, { type: 'null' }],
  };
  return schema;
}

let check: ((payload: unknown) => { ok: boolean; errors: string }) | undefined;

function v2(): NonNullable<typeof check> {
  if (check) return check;
  const { ajv } = createValidator();
  const fn = ajv.getSchema(ORDER_PLACED_V2_ID) ?? ajv.compile(orderPlacedV2Schema());
  check = (payload) => {
    const ok = fn(payload) === true;
    const errors = (fn.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
      .join('; ');
    return { ok, errors };
  };
  return check;
}

/** True once `packages/events` publishes `order.placed@2` (the mock is then superseded). */
export function orderPlacedV2IsPublished(): boolean {
  return 'order.placed@2' in (EVENT_SCHEMAS as Record<string, unknown>);
}

/** Does this payload satisfy `order.placed@2` (the published schema once it exists, the mock before)? */
export function validatesAsOrderPlacedV2(payload: unknown): boolean {
  return v2()(payload).ok;
}

/**
 * An `order.placed@2` payload from a v1 one: `email_hash` set to `emailHash` (null = an erased customer, what the
 * replay writes) and optionally `customer_id`. Throws unless the result validates as @2.
 */
export function toOrderPlacedV2(
  v1: Record<string, unknown>,
  over: { emailHash: string | null; customerId?: string | null },
): Record<string, unknown> {
  const payload = {
    ...v1,
    email_hash: over.emailHash,
    ...(over.customerId === undefined ? {} : { customer_id: over.customerId }),
  };
  const r = v2()(payload);
  if (!r.ok) throw new Error(`order.placed@2 fixture is invalid: ${r.errors}`);
  return payload;
}
