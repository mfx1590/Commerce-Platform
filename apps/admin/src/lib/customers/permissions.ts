/**
 * Customer mutations the guard checks before the API (#903): the `x-permission` of each operation
 * in `admin-api.yaml`, pinned in a unit test. Erasure is irreversible and privacy-critical, so it is
 * refused in the admin before the request is sent, not only by the Admin API.
 */

import { findStore, type Principal } from '../nav/navigation';
import { expandStoreRelations, type Relation } from '../nav/relations';
import type { PermissionRule } from '../permissions/rules';

export const CUSTOMER_PERMISSIONS = {
  updateCustomer: { relation: 'support', object: 'store' },
  eraseCustomer: { relation: 'store_admin', object: 'store' },
  // A GDPR export schedules a bundle of everything held about one person, so it is `store_admin`
  // like erasure — not `support`, which is enough to READ the record on screen.
  exportCustomer: { relation: 'store_admin', object: 'store' },
} as const satisfies Record<string, PermissionRule>;

/**
 * Holds `store_admin` on this store, directly or by implication — the relation the three
 * privacy-critical customer operations need: `eraseCustomer`, `exportCustomer`, and downloading a
 * bundle.
 *
 * It lives here, not in a page, because the bundle **route handler** needs the same answer as the
 * screen and a guard component cannot reach a route. Two readers of one predicate cannot drift.
 */
export function mayAdministerCustomer(principal: Principal, storeId: string): boolean {
  const store = findStore(principal, storeId);
  return expandStoreRelations(
    (store?.relations ?? []) as Relation[],
    principal.organization_relations as Relation[],
  ).has('store_admin');
}
