// Admin API principal (ADR 0001/0002): staff bearer token → verified identity → `req.principal`. Mounted on
// `/admin` in src/server.ts AHEAD of Medusa (our admin route files opt out of Medusa's own auth with
// `export const AUTHENTICATE = false`).
//
// Two verifiers behind one seam (`StaffTokenVerifier`), composed by `composeStaffTokenVerifier`:
// - `KeycloakStaffTokenVerifier` (Integration 1, the default): the staff realm JWT (RS256/JWKS, aud `core-api`)
//   → `staff_user` → OpenFGA scope, through hq-rbac's `createStaffScopeMiddleware` (@platform/auth-sdk). The
//   principal carries the `StaffScope`; permissions ask OpenFGA (src/http/permissions.ts).
// - `DevTokenVerifier` (Phase 1, opt-in): `dev:<keycloak_subject>` → `staff_user` → `role_assignment` rows,
//   ONLY with `CORE_DEV_TOKENS=1` and never in production. Permissions use the `role_assignment` stub.
import type { RequestHandler } from 'express';
import type { Relation } from '@platform/contracts';
import type { ScopedClient } from '@platform/db';
import {
  createOpenFgaClient,
  type OpenFgaClient,
  type ScopeCache,
  type StaffScope,
  type StaffTokenVerifier as JwtVerifier,
} from '@platform/auth-sdk';
import { createStaffScopeMiddleware, type StaffScopeMiddleware } from '../modules/hq-rbac';
import type { Actor } from '../lib/audit';
import { getPool, organizationClient, tenantClient } from '../lib/db';
import { AppError, fromApiError } from '../lib/errors';
import { requestIdOf } from './request-id';
import { coreOrganizationId } from './tenant';

const unauthorized = (message: string) => new AppError('unauthorized', message);
const forbidden = (message: string) => new AppError('forbidden', message);

export interface StaffIdentity {
  /** Keycloak `sub` (staff_user.keycloak_subject). */
  subject: string;
  /**
   * Set by the Keycloak verifier: the OpenFGA-resolved scope (ADR 0002 §4). Absent for dev tokens, whose
   * principal is built from `role_assignment` instead.
   */
  scope?: StaffScope;
  /** The OpenFGA client the scope was resolved with; `can()` asks the same one. */
  fga?: OpenFgaClient;
}

/** What a verifier implements: bearer token → verified identity, or throw (401 / 503). */
export interface StaffTokenVerifier {
  verify(token: string): Promise<StaffIdentity>;
}

/** Explicit opt-in for the Phase 1 dev tokens. Enabling is never derived from NODE_ENV; production always refuses. */
export const DEV_TOKENS_FLAG = 'CORE_DEV_TOKENS';
export const devTokensEnabled = (): boolean => process.env[DEV_TOKENS_FLAG] === '1';
const isProduction = (): boolean => process.env.NODE_ENV === 'production';
const DEV_PREFIX = 'dev:';

/**
 * Phase 1 verifier: accepts `Bearer dev:<keycloak_subject>` and nothing else, ONLY when the operator set
 * `CORE_DEV_TOKENS=1` (explicit opt-in), and NEVER when NODE_ENV is `production` — that refusal comes first and
 * cannot be overridden by the flag. It never decodes an unverified JWT — a JWT must be checked by the real
 * verifier from @platform/auth-sdk.
 */
export class DevTokenVerifier implements StaffTokenVerifier {
  async verify(token: string): Promise<StaffIdentity> {
    if (isProduction()) {
      throw unauthorized('dev tokens are never accepted in production');
    }
    if (!devTokensEnabled()) {
      throw unauthorized(
        `staff tokens are not accepted: no verifier configured (set ${DEV_TOKENS_FLAG}=1 for local dev tokens)`,
      );
    }
    if (!token.startsWith(DEV_PREFIX) || token.length <= DEV_PREFIX.length) {
      throw unauthorized('unsupported token (Phase 1 accepts `dev:<keycloak_subject>` only)');
    }
    return { subject: token.slice(DEV_PREFIX.length) };
  }
}

type Pool = ReturnType<typeof getPool>;

export interface KeycloakStaffTokenVerifierOptions {
  /** Application pool (default: the process pool from src/lib/db.ts, after `initDb()`). */
  pool?: Pool;
  /** Default `coreOrganizationId()` (CORE_ORGANIZATION_ID, else the seeded HQ). */
  organizationId?: string;
  /** Default `createOpenFgaClient()`: OPENFGA_API_URL / OPENFGA_STORE_ID / OPENFGA_MODEL_ID (auth-sdk defaults). */
  fga?: OpenFgaClient;
  /** Default `new ScopeCache()` (≤ 30 s per subject). Tests pass `new ScopeCache(0)`. */
  cache?: ScopeCache;
  /** JWT verifier override; default reads KEYCLOAK_URL / KEYCLOAK_REALM_STAFF (aud `core-api`). */
  jwtVerifier?: JwtVerifier;
}

/**
 * Integration 1 verifier: a real staff-realm JWT → `staff_user` → OpenFGA scope, exactly hq-rbac's
 * `createStaffScopeMiddleware` (JWKS of the staff realm, issuer + `aud: core-api` pinned; unknown/disabled user
 * → 401; OpenFGA unreachable → 503, fail closed). The middleware is built on first use so the pool may be opened
 * after construction. `dev:` tokens are refused here — the composition below routes them to `DevTokenVerifier`.
 */
export class KeycloakStaffTokenVerifier implements StaffTokenVerifier {
  readonly fga: OpenFgaClient;
  private middleware: StaffScopeMiddleware | undefined;

  constructor(private readonly opts: KeycloakStaffTokenVerifierOptions = {}) {
    this.fga = opts.fga ?? createOpenFgaClient();
    this.invalidate = this.invalidate.bind(this);
  }

  private scopeMiddleware(): StaffScopeMiddleware {
    this.middleware ??= createStaffScopeMiddleware({
      pool: this.opts.pool ?? getPool(),
      fga: this.fga,
      organizationId: this.opts.organizationId ?? coreOrganizationId(),
      ...(this.opts.cache ? { cache: this.opts.cache } : {}),
      ...(this.opts.jwtVerifier ? { verifier: this.opts.jwtVerifier } : {}),
    });
    return this.middleware;
  }

  async verify(token: string): Promise<StaffIdentity> {
    if (token.startsWith(DEV_PREFIX)) {
      throw unauthorized(
        `dev tokens are not accepted (set ${DEV_TOKENS_FLAG}=1 locally; never in production)`,
      );
    }
    let scope: StaffScope;
    try {
      scope = await this.scopeMiddleware().resolve(token);
    } catch (err) {
      throw fromApiError(err);
    }
    return { subject: scope.subject, scope, fga: this.fga };
  }

  /** Drops the cached scope of a staff user; wire as `onRoleChange` of hq-rbac. */
  invalidate(staffUserId: string): void {
    this.scopeMiddleware().invalidate(staffUserId);
  }
}

/**
 * The composition rule of src/server.ts: `dev:<subject>` goes to the dev verifier ONLY when `CORE_DEV_TOKENS=1`
 * and NODE_ENV is not `production` (unchanged Phase 1 behaviour); every other bearer — including a `dev:` token
 * without the opt-in — goes to the Keycloak verifier, which refuses it with 401.
 */
export function composeStaffTokenVerifier(
  keycloak: StaffTokenVerifier,
  dev: StaffTokenVerifier = new DevTokenVerifier(),
): StaffTokenVerifier {
  return {
    verify(token) {
      if (token.startsWith(DEV_PREFIX) && devTokensEnabled() && !isProduction()) {
        return dev.verify(token);
      }
      return keycloak.verify(token);
    },
  };
}

export interface PrincipalStore {
  store_id: string;
  code: string;
  name: string;
  relations: Relation[];
}

export interface StaffPrincipal {
  organizationId: string;
  /** Keycloak `sub` (`staff_user.keycloak_subject`). */
  subject: string;
  user: { id: string; email: string; display_name: string };
  organizationRelations: Relation[];
  /** Every store the principal may see (OpenFGA `viewer` for real tokens), with its direct store relations. */
  stores: PrincipalStore[];
  actor: Actor;
  requestId: string;
  /** Present for real tokens only: the OpenFGA-resolved scope. Permissions ask OpenFGA when it is set. */
  scope?: StaffScope;
  /** The OpenFGA client to ask (real tokens). */
  fga?: OpenFgaClient;
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
interface ScopedStoreRow {
  id: string;
  code: string;
  name: string;
  relations: Relation[];
}

export function parseBearer(authorization: string | undefined): string {
  const m = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  const token = m?.[1]?.trim();
  if (!token) throw unauthorized('Authorization: Bearer <token> is required');
  return token;
}

/**
 * Principal for a real token: the identity and relations come from the verified scope (OpenFGA decided);
 * `stores[]` lists the scope's stores with code/name plus the principal's direct store relations from the
 * `role_assignment` mirror (what `/admin/me` shows; authorisation never reads it — see permissions.ts).
 */
async function principalFromScope(
  scope: StaffScope,
  fga: OpenFgaClient | undefined,
  requestId: string,
): Promise<StaffPrincipal> {
  const hq = organizationClient({ organizationId: scope.organizationId });
  const stores =
    scope.storeIds.length === 0
      ? []
      : (
          await hq.query<ScopedStoreRow>(
            `SELECT s.id, s.code, s.name,
                    COALESCE(array_agg(ra.relation::text ORDER BY ra.relation) FILTER (WHERE ra.relation IS NOT NULL), '{}') AS relations
             FROM store s
             LEFT JOIN role_assignment ra
               ON ra.object_type = 'store' AND ra.object_id = s.id AND ra.staff_user_id = $2
             WHERE s.id = ANY($1::uuid[])
             GROUP BY s.id, s.code, s.name
             ORDER BY s.code`,
            [scope.storeIds, scope.userId],
          )
        ).rows;
  return {
    organizationId: scope.organizationId,
    subject: scope.subject,
    user: { id: scope.userId, email: scope.email, display_name: scope.displayName },
    organizationRelations: [...scope.organizationRelations],
    stores: stores.map((s) => ({
      store_id: s.id,
      code: s.code,
      name: s.name,
      relations: s.relations,
    })),
    actor: { id: scope.userId, type: 'staff', requestId },
    requestId,
    scope,
    ...(fga ? { fga } : {}),
  };
}

/** Resolves the principal for a bearer token, or throws 401 (no user, disabled user, bad token) / 503. */
export async function resolveStaffPrincipal(
  authorization: string | undefined,
  verifier: StaffTokenVerifier,
  requestId: string,
): Promise<StaffPrincipal> {
  const identity = await verifier.verify(parseBearer(authorization));
  if (identity.scope) return principalFromScope(identity.scope, identity.fga, requestId);

  // Dev token: `staff_user` → `role_assignment` rows (Phase 1 stub, ADR 0002 evaluated in permissions.ts).
  const { subject } = identity;
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
      subject,
      user: { id: user.id, email: user.email, display_name: user.display_name },
      organizationRelations,
      stores: [...stores.values()],
      actor: { id: user.id, type: 'staff', requestId },
      requestId,
    };
  });
}

/** Express middleware for the `/admin` namespace: attaches `req.principal` or fails with 401 (503 fail closed). */
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

/**
 * The `StaffScope` of a principal — the real one for Keycloak tokens, synthesised from the `role_assignment`
 * principal for dev tokens (same shape: hq-rbac's routes and `toTenantContext` take it either way).
 */
export function principalScope(p: StaffPrincipal): StaffScope {
  return (
    p.scope ?? {
      userId: p.user.id,
      subject: p.subject,
      email: p.user.email,
      displayName: p.user.display_name,
      organizationId: p.organizationId,
      organizationRelations: [...p.organizationRelations],
      storeIds: p.stores.map((s) => s.store_id).sort(),
      scope: p.organizationRelations.length > 0 ? 'organization' : 'store',
    }
  );
}

/** True when the principal holds any organization-level relation (HQ roles see every store). */
export function hasOrganizationAccess(p: StaffPrincipal): boolean {
  return p.organizationRelations.length > 0;
}

/** Store ids the principal may see: the OpenFGA scope for real tokens, `role_assignment` stores for dev tokens. */
export function visibleStoreIds(p: StaffPrincipal): string[] {
  return p.scope ? p.scope.storeIds : p.stores.map((s) => s.store_id);
}

/**
 * Store-scoped client for an admin request on `storeId`: allowed when the principal may see that store or holds
 * any organization-level relation; otherwise 403 `{ code: "forbidden" }` (the store may well exist — a
 * principal must never learn that through a 404). Fine-grained `x-permission` checks: permissions.ts.
 */
export function storeClientFor(p: StaffPrincipal, storeId: string): ScopedClient {
  const inScope = hasOrganizationAccess(p) || visibleStoreIds(p).includes(storeId);
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
  const storeIds = visibleStoreIds(p);
  if (storeIds.length === 0) throw forbidden('no store access');
  return tenantClient({
    organizationId: p.organizationId,
    storeIds,
    actorId: p.user.id,
  });
}
