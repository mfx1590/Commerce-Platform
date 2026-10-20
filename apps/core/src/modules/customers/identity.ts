// Cross-brand identity (#473, CONTRACT CHANGE #504, db 0196): one `customer_identity` row per person of the
// organization, keyed by the customers-realm SUBJECT (one realm serves every brand, so the `sub` is the same
// person everywhere); the per-brand `customer` rows point at it (model B). The table is closed to store sessions
// (RLS `organization_only`): a brand must never learn that a person shops at another brand — not a count, not a
// hash. Store-scoped code therefore never reads it; it calls two SECURITY DEFINER functions that run in
// organization scope and return an id and nothing else:
//
// - `app.link_customer_identity(customer_id, subject, email_hash)` — called by `resolveIn` (service.ts) at
//   provisioning, on adoption and on the first verified sign-in of an older row, ONLY for a verified email: finds
//   the identity by subject (creates it on a miss), merges a guest-only identity with the same email_hash when
//   exactly ONE unmerged subjectless candidate exists (two or more: no merge — ambiguity is never guessed), points
//   the customer row at it. Two Keycloak accounts with the same verified email are two identities (a shared
//   mailbox is two people as far as this table knows — manager decision 2026-10-18).
// - `app.unlink_customer_identity(customer_id)` — at erasure (gdpr.ts): clears the pointer, deletes the
//   identity when no customer row and no merged identity references it any more.
//
// The HQ read (`getCustomerIdentity`, `support` on organization:hq) answers store and customer ids only.
// Cross-brand self-service deletion (`eraseIdentity`) is built here and tested, but NOT wired to `deleteMe`: whether
// one deletion spans every brand is the owner's open decision (lawyer list); `eraseMe` stays per brand.
//
// No import from service.ts or gdpr.ts (they import this file); the erasure of one row is passed in.
import type { Queryable, ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';

/** Unlinks the customer from its identity; true when the identity row was deleted (nothing referenced it). */
export async function unlinkIdentity(tx: Queryable, customerId: string): Promise<boolean> {
  // the organization and the caller's store scope come from the session (0196); a customer outside the
  // caller's scope is a 42501 from the function, never a silent no-op
  const r = await tx.query<{ deleted: boolean }>(
    'SELECT app.unlink_customer_identity($1) AS deleted',
    [customerId],
  );
  return r.rows[0]?.deleted === true;
}

export interface CustomerIdentityView {
  id: string;
  customers: Array<{ store_id: string; customer_id: string }>;
}

/**
 * Admin `getCustomerIdentity` (support on organization:hq): the identity (a merged one resolved to its target)
 * and the per-brand rows pointing at it — ids only. Runs on an ORGANIZATION client: a store-scoped principal never
 * gets one (`organizationClientFor` → 403), and under RLS a store session would see nothing anyway.
 */
export async function getCustomerIdentity(
  client: ScopedClient,
  identityId: string,
): Promise<CustomerIdentityView> {
  let id = identityId;
  for (let hop = 0; hop < 8; hop += 1) {
    const r = await client.query<{ id: string; merged_into_id: string | null }>(
      'SELECT id, merged_into_id FROM customer_identity WHERE id = $1',
      [id],
    );
    const row = r.rows[0];
    if (!row) throw new AppError('not_found', 'identity not found', { identity_id: identityId });
    if (row.merged_into_id === null) break;
    id = row.merged_into_id;
  }
  const customers = await client.query<{ store_id: string; customer_id: string }>(
    'SELECT store_id, id AS customer_id FROM customer WHERE identity_id = $1 ORDER BY store_id, id',
    [id],
  );
  return { id, customers: customers.rows };
}

export type EraseRow = (
  tx: Queryable,
  organizationId: string,
  storeId: string,
  customerId: string,
  actor: Actor,
) => Promise<{ erased: boolean }>;

export interface EraseIdentityResult {
  /** Store rows erased (already erased ones are skipped), by store and customer id. */
  erased: Array<{ store_id: string; customer_id: string }>;
  identityDeleted: boolean;
}

/**
 * Cross-brand erasure: every customer row of the identity, in one transaction, each through the store-level
 * erasure (gdpr.ts `eraseIn`: addresses, consents, exports with their bundles, the tombstone subject, ONE
 * `customer.erased` per row), then the identity row and the guest identities merged into it. Built for the owner's
 * decision on self-service deletion; NOT wired to `deleteMe` until it is taken. Takes an ORGANIZATION client.
 */
export async function eraseIdentity(
  client: ScopedClient,
  identityId: string,
  actor: Actor,
  eraseRow: EraseRow,
): Promise<EraseIdentityResult> {
  const organizationId = client.context.organizationId;
  return client.transaction(async (tx) => {
    const target = await tx.query<{ id: string }>(
      'SELECT id FROM customer_identity WHERE id = $1 FOR UPDATE',
      [identityId],
    );
    if (!target.rows[0]) {
      throw new AppError('not_found', 'identity not found', { identity_id: identityId });
    }
    const rows = await tx.query<{ store_id: string; id: string }>(
      'SELECT store_id, id FROM customer WHERE identity_id = $1 ORDER BY store_id, id',
      [identityId],
    );
    const erased: EraseIdentityResult['erased'] = [];
    for (const row of rows.rows) {
      const r = await eraseRow(tx, organizationId, row.store_id, row.id, actor);
      if (r.erased) erased.push({ store_id: row.store_id, customer_id: row.id });
    }
    // the erasure unlinked every row (the last unlink may already have deleted the identity); whatever is left
    // of the identity graph — merged guest identities, the row itself — goes now
    await tx.query('DELETE FROM customer_identity WHERE merged_into_id = $1', [identityId]);
    await tx.query('DELETE FROM customer_identity WHERE id = $1', [identityId]);
    const left = await tx.query('SELECT 1 FROM customer_identity WHERE id = $1', [identityId]);
    return { erased, identityDeleted: (left.rowCount ?? 0) === 0 };
  });
}
