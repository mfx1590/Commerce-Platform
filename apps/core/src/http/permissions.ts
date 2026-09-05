// Permission guard for the Admin API (packages/contracts admin-api.yaml `x-permission`).
//
// Signature aligned with packages/auth-sdk/CLAUDE.md: `requirePermission(relation, objectFactory)` is a route
// middleware that throws 403 (`{ code: "forbidden" }`), `can(principal, relation, object)` answers the question.
// Phase 1 STUB: `can` evaluates `role_assignment` following the OpenFGA model in docs/adr/0002-auth-model.md;
// `@platform/auth-sdk` (window 2) replaces the body of `can` with the real OpenFGA check behind the same shapes.
import type { Request, RequestHandler } from 'express';
import type { Relation } from '@platform/contracts';
import { AppError } from '../lib/errors';
import { requirePrincipal, type StaffPrincipal } from './staff-auth';

/** `viewer` = any relation on the object (ADR 0002). */
export type PermissionRelation = Relation | 'viewer';
/** `organization:hq`, `store:<uuid>`, or `store:*` (any store the principal holds the relation on). */
export type PermissionObject = string;
/** Resolves the object for a request, e.g. `(req) => \`store:${req.params.storeId}\``. */
export type ObjectFactory = (req: Request) => PermissionObject;

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

/**
 * Does the principal hold `relation` on `object`? (auth-sdk: `can(principal, relation, object)`; there it is
 * async because it asks OpenFGA — kept sync-compatible here by returning a resolved promise.)
 */
export async function can(
  p: StaffPrincipal,
  relation: PermissionRelation,
  object: PermissionObject,
): Promise<boolean> {
  return hasPermission(p, relation, object);
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
export function assertPermission(
  p: StaffPrincipal,
  relation: PermissionRelation,
  object: PermissionObject,
): void {
  if (!hasPermission(p, relation, object)) {
    throw new AppError('forbidden', `requires ${relation} on ${object}`);
  }
}

/**
 * Route middleware (auth-sdk signature): `requirePermission('store_staff', (req) => \`store:${req.params.storeId}\`)`.
 * Needs `req.principal` (staffAuthMiddleware ran); 401 without it, 403 without the relation.
 */
export function requirePermission(
  relation: PermissionRelation,
  objectFactory: ObjectFactory,
): RequestHandler {
  return (req, _res, next) => {
    try {
      assertPermission(requirePrincipal(req), relation, objectFactory(req));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Resolves an `x-permission` object template (`store:{storeId}`) for a request. */
export function resolveObject(
  template: string,
  params: { storeId?: string | undefined },
): PermissionObject {
  return template.replace('{storeId}', params.storeId ?? '');
}
