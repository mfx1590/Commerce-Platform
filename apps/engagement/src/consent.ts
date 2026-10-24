// Identity resolution and the consent gate — SERVICE-WIDE, not the CDP's.
//
// It lived under `src/cdp/` when #554 built it, because the CDP was the only consumer with a consent question.
// CRM sync (#555) then needed exactly the same gate against exactly the same projection, and two copies of a
// consent rule is how a service ends up with two different answers to "may we contact this person". So it sits
// at the top level and both consumers import it: one rule, one place, one set of tests.
//
// This is the only part of the CDP and CRM paths that touches a database.
//
// MANAGER RULING, 2026-10-23, and the reasons it is worth keeping exactly:
//
//  * Read consent from the `customer.consent` PROJECTION (packages/db 0005, rewritten by the core's consent
//    ledger in the same transaction as each 0194 `customer_consent` row). Never the ledger rows themselves:
//    window 13 owns their semantics, and "the newest row wins" is their rule to change, not ours. If the
//    projection's shape is ever not enough, that is a REQUEST to window 13, never a ledger read here.
//  * READ-ONLY. This service writes neither table.
//  * The consent that counts is the CURRENT one, at processing time — not the `marketing_consent` field that
//    `customer.created` / `customer.updated` carry in their payload. A decision here can therefore contradict
//    the event's own snapshot (the event says granted, the customer revoked in between, nothing is sent). That
//    is the ruling working, not a bug.
//  * Through a tenant client scoped to the EVENT'S OWN store. An organization-scoped client could read every
//    store's `customer` rows (`app.can_access_store` is true for any store in organization scope), so this is
//    least privilege by choice: consent is per (customer, store, purpose) and 0194 says it is never propagated
//    across stores, so scoping the read to the event's store makes a cross-store consent read impossible
//    rather than merely wrong.
//
// Note the division of labour with the consumer: the marks live in `consumer_processed`, which is RLS kind
// `organization_only` — a store-scoped client can neither read nor write it. So the CDP consumer runs TWO
// clients: the organization one for the marks, and one of these per event for the consent read.

import type { Queryable, ScopedClient } from '@platform/db';

/**
 * Who the gate says may be contacted. Declared HERE rather than imported from `cdp/types.ts`: this module is
 * service-wide, so it must not depend on one consumer's types. It is structurally identical to the CDP's
 * `CdpIdentity`, so a `GateIdentity` is accepted wherever the CDP wants one — no conversion, no cast, and no
 * import in this direction.
 */
export interface GateIdentity {
  /** Our customer id, when one is known. */
  userId: string | null;
  /** `email_hash` — never reversible, never the upsert key for a known customer. */
  anonymousId: string | null;
}

/** The only purpose the 0194 CHECK allows today. */
export const CONSENT_PURPOSE = 'marketing_email';

/**
 * How much the CDP may send without a marketing consent (#576, owner decision 2026-10-23).
 *
 *   `analytics` — the DEFAULT. Commerce events are tracked without `marketing_email`, and a guest with no
 *                  customer row is tracked under their `email_hash`. The owner's position is that analytics
 *                  tracking of one's own commerce events is not marketing; region rules come later as config.
 *   `strict`    — what #554 shipped: no identify and no track without granted `marketing_email` for that
 *                  store, and a guest is dropped.
 *
 * The mode is resolved PER STORE (`config.ts`: a global default plus `ENGAGEMENT_CDP_CONSENT_MODE_<STORE>`),
 * because each brand is one market — so one region can be made strict without touching code.
 *
 * It gates the CDP ONLY. CRM sync stays consent-gated in every mode, because it fetches and stores a name and
 * an e-mail in a third-party CRM, which is a different act from counting an order.
 */
export type ConsentMode = 'analytics' | 'strict';

/** What the projection says about one purpose. `null` = the customer has never answered. */
export interface ConsentState {
  granted: boolean | null;
  /** When the decision was recorded, as the projection has it. */
  at: string | null;
}

export interface CustomerFacts {
  /** `null` when the customer row is gone (erased and deleted) or was never there. */
  found: boolean;
  customerId: string | null;
  status: string | null;
  consent: ConsentState;
}

/** The projection block the core writes: `{ granted, at, source }` per purpose. */
interface ConsentBlock {
  granted?: boolean;
  at?: string;
  source?: string;
}

function stateOf(consent: Record<string, ConsentBlock> | null, purpose: string): ConsentState {
  const block = consent?.[purpose];
  if (!block || typeof block.granted !== 'boolean') return { granted: null, at: null };
  return { granted: block.granted, at: block.at ?? null };
}

/**
 * Reads the customer's status and consent projection by customer id. One statement, no transaction needed.
 * `q` is a store-scoped client (or a transaction of one) for the event's store.
 */
export async function readCustomerFacts(
  q: ScopedClient | Queryable,
  customerId: string,
  purpose = CONSENT_PURPOSE,
): Promise<CustomerFacts> {
  const r = await q.query('SELECT id, status, consent FROM customer WHERE id = $1', [customerId]);
  const row = r.rows[0] as
    { id: string; status: string; consent: Record<string, ConsentBlock> | null } | undefined;
  if (!row)
    return { found: false, customerId: null, status: null, consent: { granted: null, at: null } };
  return {
    found: true,
    customerId: row.id,
    status: row.status,
    consent: stateOf(row.consent, purpose),
  };
}

/**
 * For the order-scoped topics, which carry neither `customer_id` nor `email_hash`: resolve the customer FROM
 * THE ORDER ROW and read the consent projection in the SAME statement. One read per event — the identity and
 * the permission to send it are never two separate round trips, and never two sources of truth.
 *
 * A guest order has `customer_id IS NULL`: `found` is true (the order exists) with a null customer, which the
 * caller treats as "no identity" and drops.
 */
export async function readOrderCustomerFacts(
  q: ScopedClient | Queryable,
  orderId: string,
  purpose = CONSENT_PURPOSE,
): Promise<CustomerFacts & { orderFound: boolean }> {
  const r = await q.query(
    `SELECT o.id AS order_id, c.id AS customer_id, c.status, c.consent
       FROM "order" o
       LEFT JOIN customer c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [orderId],
  );
  const row = r.rows[0] as
    | {
        order_id: string;
        customer_id: string | null;
        status: string | null;
        consent: Record<string, ConsentBlock> | null;
      }
    | undefined;
  if (!row) {
    return {
      orderFound: false,
      found: false,
      customerId: null,
      status: null,
      consent: { granted: null, at: null },
    };
  }
  return {
    orderFound: true,
    found: row.customer_id !== null,
    customerId: row.customer_id,
    status: row.status,
    consent: stateOf(row.consent, purpose),
  };
}

/** Why an event was not sent — a log line says this, so a quiet CDP is explainable without a debugger. */
export type DropReason =
  | 'no_identity'
  | 'customer_not_found'
  | 'order_not_found'
  | 'consent_absent'
  | 'consent_revoked'
  | 'customer_erased';

export type GateDecision =
  { send: true; identity: GateIdentity } | { send: false; reason: DropReason };

/**
 * The gate.
 *
 * An erasure (`gated: false`) needs only an identity and is never consent-gated in either mode: a suppression
 * must go out precisely for the customer who has withdrawn everything.
 *
 * For everything else the `mode` decides (#576):
 *
 *   `strict`    — a customer we can name AND a granted `marketing_email` for that store. A guest (only an
 *                  `email_hash`) is dropped: there is no consent row to check for them.
 *   `analytics` — the DEFAULT. Consent is not required; an identity is. A named customer is sent, a guest is
 *                  sent under their `email_hash`, and the only drop left is having no identity at all.
 *
 * `analytics` still refuses two things, because they are not about consent:
 *   * an ERASED customer is never sent, in either mode. The erasure already told every consumer to delete
 *     their copies, so tracking that person again would undo it.
 *   * a vanished order or customer row is still reported as such rather than guessed at.
 */
export function gate(args: {
  gated: boolean;
  facts: Pick<CustomerFacts, 'found' | 'customerId' | 'status' | 'consent'>;
  /** From the payload, when it has one. In `analytics` mode it can be the identity on its own. */
  emailHash?: string | null;
  /** Set for the order-scoped topics so a vanished order is reported as such. */
  orderFound?: boolean;
  /** Defaults to `strict`: a caller that forgets the mode gets the cautious behaviour, never the open one. */
  mode?: ConsentMode;
}): GateDecision {
  if (args.orderFound === false) return { send: false, reason: 'order_not_found' };

  // An erasure: the identity is enough, and it must go out whatever the consent says. BOTH ids travel when
  // both are known, so the suppression reaches a profile keyed by the hash as well as one keyed by our id
  // (#576 — the hash-keyed profiles `analytics` mode creates for guests). `customer.erased` v1 carries no
  // hash; v2 does (CONTRACT CHANGE #580), and this needs no change when it lands: the hash is simply there.
  if (!args.gated) {
    const id = args.facts.customerId ?? null;
    if (id) return { send: true, identity: { userId: id, anonymousId: args.emailHash ?? null } };
    if (args.emailHash)
      return { send: true, identity: { userId: null, anonymousId: args.emailHash } };
    return { send: false, reason: 'no_identity' };
  }

  // An erased customer is refused in BOTH modes, before anything about consent: the erasure already told
  // every consumer to delete its copies, and tracking them again would undo it.
  if (args.facts.status === 'erased') return { send: false, reason: 'customer_erased' };

  const mode: ConsentMode = args.mode ?? 'strict';

  if (mode === 'analytics') {
    // Consent is not required; an identity is. A guest is tracked under their hash (#576).
    if (args.facts.customerId) {
      return {
        send: true,
        identity: { userId: args.facts.customerId, anonymousId: args.emailHash ?? null },
      };
    }
    if (args.emailHash)
      return { send: true, identity: { userId: null, anonymousId: args.emailHash } };
    // A customer row that was there but is gone is still reported as such rather than guessed at.
    return { send: false, reason: args.facts.found ? 'customer_not_found' : 'no_identity' };
  }

  if (!args.facts.customerId) {
    // Either a guest (no customer at all) or a customer row that is gone.
    return { send: false, reason: args.facts.found ? 'customer_not_found' : 'no_identity' };
  }
  if (args.facts.consent.granted === null) return { send: false, reason: 'consent_absent' };
  if (args.facts.consent.granted === false) return { send: false, reason: 'consent_revoked' };

  return {
    send: true,
    identity: { userId: args.facts.customerId, anonymousId: args.emailHash ?? null },
  };
}
