// Erasure on replay (#629, #703). Which payloads name a customer, the erased customers per store, and the two checks
// every replay runs before it hands a message on: the core's outbox replay (apps/core/src/outbox/replay.ts) before it
// republishes, replayFromDlq (./dlq.ts) before it reruns a handler. A row that names an erased customer of its store
// is skipped; an envelope actor that is one loses its id (v1 allows a null id). customer.erased itself is never
// skipped: it is the erasure, and every consumer needs it. test/erasure.test.ts walks every schema and fails when one
// that names a customer has no rule here.
import type { EventEnvelopeV1Base } from './generated/types.js';

type Payload = Record<string, unknown>;

/** Where a topic's payload names a customer: the customer ids and the e-mail hashes it carries. */
export interface ErasureRule {
  customerIds: (p: Payload) => unknown[];
  emailHashes: (p: Payload) => unknown[];
}

const byCustomer = (p: Payload): unknown[] => [p.customer_id];
const byHash = (p: Payload): unknown[] => [p.email_hash];
const none = (): unknown[] => [];

/** Every topic whose payload names a customer (#629). */
export const ERASURE_RULES: Readonly<Record<string, ErasureRule>> = {
  'order.placed': { customerIds: byCustomer, emailHashes: byHash },
  'cart.abandoned': { customerIds: byCustomer, emailHashes: byHash },
  'customer.created': { customerIds: byCustomer, emailHashes: byHash },
  'customer.updated': { customerIds: byCustomer, emailHashes: byHash },
  'customer.export_requested': { customerIds: byCustomer, emailHashes: none },
  'customer.export_ready': { customerIds: byCustomer, emailHashes: none },
  'review.published': { customerIds: byCustomer, emailHashes: none },
  'referral.converted': {
    customerIds: (p) => [p.referrer_customer_id, p.referee_customer_id],
    emailHashes: none,
  },
};

/** The erased customers one replay knows about, per store. */
export interface ErasedSet {
  /** Erasure records read (customer.erased rows or messages; a republished one counts again). */
  readonly customers: number;
  /** `<store>|c:<customer_id>` and `<store>|h:<email_hash>` */
  readonly keys: ReadonlySet<string>;
}

/** One erasure as a customer.erased row or message carries it (v1 has no email_hash; v2 does). */
export interface ErasureRecord {
  storeId: string | null;
  customerId: unknown;
  emailHash: unknown;
}

const erasedKey = (storeId: string | null, kind: 'c' | 'h', id: unknown): string | null =>
  typeof id === 'string' && id !== '' ? `${storeId ?? 'organization'}|${kind}:${id}` : null;

export function erasedSetFrom(records: Iterable<ErasureRecord>): ErasedSet {
  const keys = new Set<string>();
  let customers = 0;
  for (const r of records) {
    customers += 1;
    for (const k of [
      erasedKey(r.storeId, 'c', r.customerId),
      erasedKey(r.storeId, 'h', r.emailHash),
    ])
      if (k) keys.add(k);
  }
  return { customers, keys };
}

/** Whether a row of `topic` names an erased customer of its own store. */
export function namesErased(
  topic: string,
  storeId: string | null,
  payload: Payload,
  erased: ErasedSet,
): boolean {
  const rule = ERASURE_RULES[topic];
  if (!rule || erased.keys.size === 0) return false;
  return [
    ...rule.customerIds(payload).map((id) => erasedKey(storeId, 'c', id)),
    ...rule.emailHashes(payload).map((h) => erasedKey(storeId, 'h', h)),
  ].some((k) => k !== null && erased.keys.has(k));
}

/** Whether the envelope's actor is an erased customer of the row's store (#700 review). */
export function actorErased(
  storeId: string | null,
  actor: EventEnvelopeV1Base['actor'] | undefined,
  erased: ErasedSet,
): boolean {
  if (!actor || actor.type !== 'customer') return false;
  const k = erasedKey(storeId, 'c', actor.id);
  return k !== null && erased.keys.has(k);
}
