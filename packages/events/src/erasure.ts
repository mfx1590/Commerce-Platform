// Erasure on replay (#629, #703). Which payloads name a customer, the erased customers per store, and the two checks
// every replay runs before it hands a message on: the core's outbox replay (apps/core/src/outbox/replay.ts) before it
// republishes, replayFromDlq (./dlq.ts) before it reruns a handler. A row that names an erased customer of its store
// is SCRUBBED when its topic has a `scrub` rule (order.placed → v2 with customer_id and email_hash null, #629 decision
// 2(i): the ledger keeps the sale, nobody keeps the person) and SKIPPED otherwise; an envelope actor that is one loses
// its id (v1 allows a null id). customer.erased itself is never
// skipped: it is the erasure, and every consumer needs it. test/erasure.test.ts walks every schema and fails when one
// that names a customer has no rule here.
import type { EventEnvelopeV1Base } from './generated/types.js';

type Payload = Record<string, unknown>;

/** Where a topic's payload names a customer: the customer ids and the e-mail hashes it carries. */
export interface ErasureRule {
  customerIds: (p: Payload) => unknown[];
  emailHashes: (p: Payload) => unknown[];
  /** #629: send the row without the identifiers instead of skipping it. Absent = skip. */
  scrub?: (e: EventEnvelopeV1Base) => EventEnvelopeV1Base;
}

const byCustomer = (p: Payload): unknown[] => [p.customer_id];
const byHash = (p: Payload): unknown[] => [p.email_hash];
const none = (): unknown[] => [];

/**
 * order.placed (v1 or v2) → v2 with `customer_id` and `email_hash` null (v2 makes the hash nullable, #696). Everything
 * else is unchanged: event_id (so a consumer that processed the original dedupes it), occurred_at, store, aggregate,
 * actor (actorErased nulls it separately), trace and every other payload field. Nothing else in the payload names the
 * person: no address, name, phone or e-mail; countries only.
 */
const scrubOrderPlaced = (e: EventEnvelopeV1Base): EventEnvelopeV1Base => ({
  ...e,
  version: 2,
  payload: { ...(e.payload as Payload), customer_id: null, email_hash: null },
});

/** Every topic whose payload names a customer (#629). */
export const ERASURE_RULES: Readonly<Record<string, ErasureRule>> = {
  'order.placed': { customerIds: byCustomer, emailHashes: byHash, scrub: scrubOrderPlaced },
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

/**
 * The scrubbed form of an envelope that names an erased customer (#629), or null when its topic has no `scrub` rule
 * (the replay skips it). Validate the result before sending it: it is a different version than the stored row.
 */
export function scrubErased(e: EventEnvelopeV1Base): EventEnvelopeV1Base | null {
  return ERASURE_RULES[e.topic]?.scrub?.(e) ?? null;
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
