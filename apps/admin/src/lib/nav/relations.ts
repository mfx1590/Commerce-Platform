/**
 * The relation algebra from ADR 0002, mirrored on the client so navigation can be decided without
 * a round-trip per section.
 *
 * `GET /admin/me` reports the relations a principal holds; the OpenFGA model then *implies* more.
 * An organization owner is a store admin everywhere, an org-level `support` is `support` on every
 * store, and any organization relation makes you a store `viewer`. Rendering a section for a
 * relation the user only holds by implication is correct; the Admin API still re-checks the
 * operation's `x-permission` on every call, so getting this wrong is a cosmetic bug, never a hole.
 *
 * Kept in step with `infra/openfga/model.fga` (window 2) and the `Relation` enum in
 * packages/contracts. `viewer` is not a grantable relation — in `x-permission` it means
 * "any relation on the object" — so it is modelled here as a derived marker only.
 */

import type { AdminComponents } from '../api/admin-client';

export type Relation = AdminComponents['Relation'];

/** Derived marker for "holds any relation on the object", matching `x-permission: viewer`. */
export const VIEWER = 'viewer' as const;
export type EffectiveRelation = Relation | typeof VIEWER;

/**
 * type organization:
 *   define finance/operations/analyst/support: [user] or owner
 *   define viewer: owner or finance or operations or analyst or support
 */
export function expandOrganizationRelations(held: readonly Relation[]): Set<EffectiveRelation> {
  const effective = new Set<EffectiveRelation>(held);
  if (effective.has('owner')) {
    effective.add('finance');
    effective.add('operations');
    effective.add('analyst');
    effective.add('support');
  }
  if (effective.size > 0) {
    effective.add(VIEWER);
  }
  return effective;
}

/**
 * type store:
 *   define store_admin: [user] or owner from organization
 *   define store_staff: [user] or store_admin
 *   define support:     [user] or support from organization or store_admin
 *   define analyst:     analyst from organization
 *   define viewer:      store_staff or support or analyst
 *                       or operations from organization or finance from organization
 *
 * `organizationRelations` are the relations the principal holds on `organization:hq`; every store
 * has that organization as its parent, so they flow down here.
 */
export function expandStoreRelations(
  heldOnStore: readonly Relation[],
  organizationRelations: readonly Relation[] = [],
): Set<EffectiveRelation> {
  const org = expandOrganizationRelations(organizationRelations);
  const effective = new Set<EffectiveRelation>(heldOnStore);

  // owner from organization
  if (org.has('owner')) effective.add('store_admin');
  // support from organization
  if (org.has('support')) effective.add('support');
  // analyst from organization
  if (org.has('analyst')) effective.add('analyst');

  // store_admin implies store_staff and support
  if (effective.has('store_admin')) {
    effective.add('store_staff');
    effective.add('support');
  }

  // viewer: any store relation, plus operations/finance from organization
  if (
    effective.size > 0 ||
    org.has('operations') ||
    org.has('finance') ||
    org.has('analyst') ||
    org.has('support') ||
    org.has('owner')
  ) {
    effective.add(VIEWER);
  }
  return effective;
}

/** True when the effective set satisfies any one of the relations a section asks for. */
export function satisfies(
  effective: ReadonlySet<EffectiveRelation>,
  required: readonly EffectiveRelation[],
): boolean {
  return required.some((relation) => effective.has(relation));
}
