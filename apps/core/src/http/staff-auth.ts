// Admin API principal (ADR 0001/0002): staff bearer token → `staff_user` → `role_assignment` rows → the stores the
// principal may act on. Mounted on `/admin` in src/server.ts AHEAD of Medusa (our admin route files opt out of
// Medusa's own auth with `export const AUTHENTICATE = false`).
//
// Phase 1 stub. `@platform/auth-sdk` (window 2) will provide the token verifier (Keycloak staff realm, RS256/JWKS)
// and the OpenFGA check behind `requirePermission(relation, object)`; the call sites here keep those signatures.
import type { RequestHandler } from 'express';
import type { Relation } from '@platform/contracts';
import type { ScopedClient } from '@platform/db';
import type { Actor } from '../lib/audit';
import { organizationClient, tenantClient } from '../lib/db';
import { AppError } from '../lib/errors';
import { requestIdOf } from './request-id';
import { coreOrganizationId } from './tenant';

const unauthorized = (message: string) => new AppError('unauthorized', message);
const forbidden = (message: string) => new AppError('forbidden', message);

export interface StaffIdentity {
  /** Keycloak `sub` (staff_user.keycloak_subject). */
  subject: string;
}

/** What @platform/auth-sdk implements: bearer token → verified identity, or throw. */
export interface StaffTokenVerifier {
  verify(token: string): Promise<StaffIdentity>;
}

/** Explicit opt-in for the Phase 1 dev tokens. Enabling is never derived from NODE_ENV; production always refuses. */
export const DEV_TOKENS_FLAG = 'CORE_DEV_TOKENS';
export const devTokensEnabled = (): boolean => process.env[DEV_TOKENS_FLAG] === '1';

/**
 * Phase 1 verifier: accepts `Bearer dev:<keycloak_subject>` and nothing else, ONLY when the operator set
 * `CORE_DEV_TOKENS=1` (explicit opt-in), and NEVER when NODE_ENV is `production` — that refusal comes first and
 * cannot be overridden by the flag. It never decodes an unverified JWT — a JWT must be checked by the real
 * verifier from @platform/auth-sdk.
 */
export class DevTokenVerifier implements StaffTokenVerifier {
  async verify(token: string): Promise<StaffIdentity> {
    if (process.env.NODE_ENV === 'production') {
      throw unauthorized('dev tokens are never accepted in production');
    }
    if (!devTokensEnabled()) {
      throw unauthorized(
        `staff tokens are not accepted: no verifier configured (set ${DEV_TOKENS_FLAG}=1 for local dev tokens)`,
      );
    }
    if (!token.startsWith('dev:') || token.length <= 4) {
      throw unauthorized('unsupported token (Phase 1 accepts `dev:<keycloak_subject>` only)');
    }
    return { subject: token.slice(4) };
  }
}

export interface PrincipalStore {
  store_id: string;
  code: string;
  name: string;
  relations: Relation[];
}

export interface StaffPrincipal {
  organizationId: string;
  user: { id: string; email: string; display_name: string };
  organizationRelations: Relation[];
  stores: PrincipalStore[];
  actor: Actor;
  requestId: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
}
interface RoleRow {
  relation: Relation;
  object_type: 'organization' | 'store';
  object_id: string;
  store_code: string | null;
  store_name: string | null;
}

export function parseBearer(authorization: string | undefined): string {
  const m = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  const token = m?.[1]?.trim();
  if (!token) throw unauthorized('Authorization: Bearer <token> is required');
  return token;
}

/** Resolves the principal for a bearer token, or throws 401 (no user, disabled user, bad token). */
export async function resolveStaffPrincipal(
  authorization: string | undefined,
  verifier: StaffTokenVerifier,
  requestId: string,
): Promise<StaffPrincipal> {
  const { subject } = await verifier.verify(parseBearer(authorization));
  const organizationId = coreOrganizationId();
  const hq = organizationClient({ organizationId });

  return hq.transaction(async (tx) => {
    const u = await tx.query<UserRow>(
      `SELECT id, email, display_name, status FROM staff_user WHERE keycloak_subject = $1`,
      [subject],
    );
    const user = u.rows[0];
    if (!user) throw unauthorized('unknown staff user');
    if (user.status !== 'active') throw unauthorized('staff user is disabled');

    const roles = await tx.query<RoleRow>(
      `SELECT ra.relation, ra.object_type, ra.object_id, s.code AS store_code, s.name AS store_name
       FROM role_assignment ra
       LEFT JOIN store s ON ra.object_type = 'store' AND s.id = ra.object_id
       WHERE ra.staff_user_id = $1
       ORDER BY ra.object_type, s.code, ra.relation`,
      [user.id],
    );
    const organizationRelations: Relation[] = [];
    const stores = new Map<string, PrincipalStore>();
    for (const r of roles.rows) {
      if (r.object_type === 'organization') {
        if (r.object_id === organizationId) organizationRelations.push(r.relation);
      } else if (r.store_code !== null) {
        const entry = stores.get(r.object_id) ?? {
          store_id: r.object_id,
          code: r.store_code,
          name: r.store_name ?? r.store_code,
          relations: [],
        };
        entry.relations.push(r.relation);
        stores.set(r.object_id, entry);
      }
    }
    return {
      organizationId,
      user: { id: user.id, email: user.email, display_name: user.display_name },
      organizationRelations,
      stores: [...stores.values()],
      actor: { id: user.id, type: 'staff', requestId },
      requestId,
    };
  });
}

/** Express middleware for the `/admin` namespace: attaches `req.principal` or fails with 401. */
export function staffAuthMiddleware(verifier: StaffTokenVerifier): RequestHandler {
  return (req, _res, next) => {
    resolveStaffPrincipal(req.headers.authorization, verifier, requestIdOf(req))
      .then((p) => {
        req.principal = p;
        next();
      })
      .catch(next);
  };
}

export function requirePrincipal(req: { principal?: StaffPrincipal }): StaffPrincipal {
  if (!req.principal) throw unauthorized('no staff principal');
  return req.principal;
}

/** True when the principal holds any organization-level relation (HQ roles see every store). */
export function hasOrganizationAccess(p: StaffPrincipal): boolean {
  return p.organizationRelations.length > 0;
}

/**
 * Store-scoped client for an admin request on `storeId`: allowed when the principal has a relation on that store
 * or any organization-level relation; otherwise 403 `{ code: "forbidden" }` (the store may well exist — a
 * principal must never learn that through a 404). Fine-grained `x-permission` checks are task 1.7.
 */
export function storeClientFor(p: StaffPrincipal, storeId: string): ScopedClient {
  const inScope = hasOrganizationAccess(p) || p.stores.some((s) => s.store_id === storeId);
  if (!inScope) throw forbidden('store is outside your scope');
  return tenantClient({
    organizationId: p.organizationId,
    storeIds: [storeId],
    actorId: p.user.id,
  });
}

/** Organization-scoped client: only for principals with an organization-level relation. */
export function organizationClientFor(p: StaffPrincipal): ScopedClient {
  if (!hasOrganizationAccess(p)) throw forbidden('organization scope requires an HQ role');
  return organizationClient({ organizationId: p.organizationId, actorId: p.user.id });
}

/** Store-scoped client covering every store the principal may see (listings). */
export function visibleStoresClientFor(p: StaffPrincipal): ScopedClient {
  if (hasOrganizationAccess(p)) return organizationClientFor(p);
  if (p.stores.length === 0) throw forbidden('no store access');
  return tenantClient({
    organizationId: p.organizationId,
    storeIds: p.stores.map((s) => s.store_id),
    actorId: p.user.id,
  });
}
