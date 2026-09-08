// Permission guard for the Admin API (packages/contracts admin-api.yaml `x-permission`).
//
// `requirePermission(relation, objectFactory)` is an Express route middleware that throws 403
// (`{ code: "forbidden" }`); `can(principal, relation, object)` answers the question. Two evaluators behind it:
// - a principal from a REAL token carries the OpenFGA-resolved `StaffScope` → `@platform/auth-sdk` `can()`
//   asks OpenFGA (`store:*` = any visible store via ListObjects); OpenFGA unreachable → 503, fail closed;
// - a dev-token principal (no scope) → the Phase 1 stub over `role_assignment`, following the OpenFGA model in
//   docs/adr/0002-auth-model.md.
// auth-sdk's own `requirePermission` returns a callable guard `(subject, params, opts) => Promise<void>`, not an
// Express handler; this file is the adapter that keeps the route files unchanged.
import type { Request, RequestHandler } from 'express';
import type { Relation } from '@platform/contracts';
import { can as fgaCan } from '@platform/auth-sdk';
import { AppError, fromApiError } from '../lib/errors';
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
 * Does the principal hold `relation` on `object`? Real tokens: one OpenFGA check through auth-sdk (throws 503
 * `internal` when OpenFGA is unreachable). Dev tokens: the `role_assignment` stub.
 */
export async function can(
  p: StaffPrincipal,
  relation: PermissionRelation,
  object: PermissionObject,
): Promise<boolean> {
  if (!p.scope) return hasPermission(p, relation, object);
  try {
    return await fgaCan(p.scope, relation, object, p.fga ? { fga: p.fga } : undefined);
  } catch (err) {
    throw fromApiError(err);
  }
}

/** The Phase 1 stub (dev tokens): ADR 0002 evaluated over the principal's `role_assignment` rows. */
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

/** Throws `403 { code: "forbidden" }` unless the stub says the principal holds `relation` on `object`. */
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
 * Async check for both kinds of principal. Real tokens answer the contract 403 with
 * `details: { relation, object }` (auth-sdk's `forbidden()` shape); dev tokens keep the Phase 1 body.
 */
export async function ensurePermission(
  p: StaffPrincipal,
  relation: PermissionRelation,
  object: PermissionObject,
): Promise<void> {
  if (!p.scope) {
    assertPermission(p, relation, object);
    return;
  }
  if (!(await can(p, relation, object))) {
    throw new AppError('forbidden', `requires ${relation} on ${object}`, { relation, object });
  }
}

/**
 * Route middleware: `requirePermission('store_staff', (req) => \`store:${req.params.storeId}\`)`.
 * Needs `req.principal` (staffAuthMiddleware ran); 401 without it, 403 without the relation, 503 when the
 * authorization service is unreachable.
 */
export function requirePermission(
  relation: PermissionRelation,
  objectFactory: ObjectFactory,
): RequestHandler {
  return (req, _res, next) => {
    Promise.resolve()
      .then(() => ensurePermission(requirePrincipal(req), relation, objectFactory(req)))
      .then(() => next(), next);
  };
}

/** Resolves an `x-permission` object template (`store:{storeId}`) for a request. */
export function resolveObject(
  template: string,
  params: { storeId?: string | undefined },
): PermissionObject {
  return template.replace('{storeId}', params.storeId ?? '');
}
