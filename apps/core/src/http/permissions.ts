// `requirePermission(principal, relation, object)` — the check every mutating Admin API route runs before doing
// anything (packages/contracts admin-api.yaml `x-permission`). Phase 1 STUB over `role_assignment` following the
// OpenFGA model in docs/adr/0002-auth-model.md; `@platform/auth-sdk` (window 2) replaces the body of
// `hasPermission` with the real OpenFGA check behind the same signature.
import type { Relation } from '@platform/contracts';
import { AppError } from '../lib/errors';
import type { StaffPrincipal } from './staff-auth';

/** `viewer` = any relation on the object (ADR 0002). */
export type PermissionRelation = Relation | 'viewer';
/** `organization:hq`, `store:<uuid>`, or `store:*` (any store the principal holds the relation on). */
export type PermissionObject = string;

export interface Permission {
  relation: PermissionRelation;
  object: PermissionObject;
}

const has = (rels: readonly Relation[], r: Relation) => rels.includes(r);

/** ADR 0002 `type organization`: owner implies every organization relation; viewer = any. */
function organizationSatisfies(
  orgRels: readonly Relation[],
  relation: PermissionRelation,
): boolean {
  if (has(orgRels, 'owner')) return true;
  if (relation === 'viewer') return orgRels.length > 0;
  return has(orgRels, relation);
}

/** ADR 0002 `type store` (with `organization` = the store's organization). */
function storeSatisfies(
  orgRels: readonly Relation[],
  storeRels: readonly Relation[],
  relation: PermissionRelation,
): boolean {
  if (has(orgRels, 'owner')) return true;
  switch (relation) {
    case 'owner':
      return false;
    case 'store_admin':
      return has(storeRels, 'store_admin');
    case 'store_staff':
      return has(storeRels, 'store_staff') || has(storeRels, 'store_admin');
    case 'support':
      return has(storeRels, 'support') || has(orgRels, 'support') || has(storeRels, 'store_admin');
    case 'analyst':
      return has(orgRels, 'analyst');
    case 'operations':
    case 'finance':
      return has(orgRels, relation);
    case 'viewer':
      return (
        storeSatisfies(orgRels, storeRels, 'store_staff') ||
        storeSatisfies(orgRels, storeRels, 'support') ||
        storeSatisfies(orgRels, storeRels, 'analyst') ||
        has(orgRels, 'operations') ||
        has(orgRels, 'finance')
      );
  }
}

export function hasPermission(
  p: StaffPrincipal,
  relation: PermissionRelation,
  object: PermissionObject,
): boolean {
  const [type, id] = object.split(':', 2) as [string, string | undefined];
  if (type === 'organization') return organizationSatisfies(p.organizationRelations, relation);
  if (type === 'store') {
    if (id === '*') {
      return (
        storeSatisfies(p.organizationRelations, [], relation) ||
        p.stores.some((s) => storeSatisfies(p.organizationRelations, s.relations, relation))
      );
    }
    const store = p.stores.find((s) => s.store_id === id);
    return storeSatisfies(p.organizationRelations, store?.relations ?? [], relation);
  }
  return false;
}

/** Throws `403 { code: "forbidden" }` unless the principal holds `relation` on `object`. */
export function requirePermission(
  p: StaffPrincipal,
  relation: PermissionRelation,
  object: PermissionObject,
): void {
  if (!hasPermission(p, relation, object)) {
    throw new AppError('forbidden', `requires ${relation} on ${object}`);
  }
}

/** Resolves an `x-permission` object template (`store:{storeId}`) for a request. */
export function resolveObject(
  template: string,
  params: { storeId?: string | undefined },
): PermissionObject {
  return template.replace('{storeId}', params.storeId ?? '');
}
