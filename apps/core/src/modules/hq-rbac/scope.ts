// Staff scope middleware (issue #13): Authorization header → verified Keycloak claims → staff_user → OpenFGA
// (ListObjects store/viewer + organization relations) → StaffScope, cached ≤ 30 s per subject.
// Window 1's tenant middleware calls `resolve()` and turns the result into the @platform/db client
// (`toTenantContext`). Fails closed: OpenFGA down → 503; unknown/disabled user or bad token → 401.
import {
  ApiError,
  createStaffTokenVerifier,
  resolveRelations,
  ScopeCache,
  type OpenFgaClient,
  type StaffScope,
  type StaffTokenVerifier,
} from '@platform/auth-sdk';
import { createOrganizationClient } from '@platform/db';

type Pool = Parameters<typeof createOrganizationClient>[0];

export interface StaffScopeMiddlewareDeps {
  pool: Pool;
  fga: OpenFgaClient;
  /** The HQ organization this deployment serves (one organization in Phases 0–3). */
  organizationId: string;
  /** Default: `createStaffTokenVerifier()` from KEYCLOAK_URL / KEYCLOAK_REALM_STAFF. */
  verifier?: StaffTokenVerifier;
  /** Default: `new ScopeCache()` (30 s). Pass `new ScopeCache(0)` to disable. */
  cache?: ScopeCache;
  /** OpenFGA object of the organization; default `organization:hq`. */
  organizationObject?: string;
}

export interface StaffScopeMiddleware {
  /** `Authorization` header value (or raw token) → scope. Throws ApiError 401 / 503. */
  resolve(authorization: string | undefined | null): Promise<StaffScope>;
  /** Wire as `onRoleChange` of createHqRbac so role changes take effect immediately. */
  invalidate(staffUserId: string): void;
  readonly cache: ScopeCache;
  readonly verifier: StaffTokenVerifier;
}

interface StaffRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'disabled';
}

export function createStaffScopeMiddleware(deps: StaffScopeMiddlewareDeps): StaffScopeMiddleware {
  const verifier = deps.verifier ?? createStaffTokenVerifier();
  const cache = deps.cache ?? new ScopeCache();
  // System-level lookup of the mirror row: the org is known (deployment config), the actor is not yet.
  const lookup = createOrganizationClient(deps.pool, { organizationId: deps.organizationId });

  async function resolve(authorization: string | undefined | null): Promise<StaffScope> {
    const claims = await verifier.verify(authorization);
    const cached = cache.get(claims.subject);
    if (cached) return cached;

    const row = await lookup.query<StaffRow>(
      'SELECT id, email, display_name, status FROM staff_user WHERE keycloak_subject = $1',
      [claims.subject],
    );
    const user = row.rows[0];
    if (!user)
      throw new ApiError(401, 'unauthorized', 'Unknown staff user', { reason: 'no_staff_user' });
    if (user.status !== 'active') {
      throw new ApiError(401, 'unauthorized', 'Staff user disabled', { reason: 'disabled' });
    }

    const relations = await resolveRelations(deps.fga, {
      userId: user.id,
      ...(deps.organizationObject ? { organizationObject: deps.organizationObject } : {}),
    });
    const scope: StaffScope = {
      userId: user.id,
      subject: claims.subject,
      email: user.email,
      displayName: user.display_name,
      organizationId: deps.organizationId,
      ...relations,
    };
    cache.set(scope);
    // Best effort, once per cache period; never fails the request.
    lookup
      .query('UPDATE staff_user SET last_login_at = now() WHERE id = $1', [user.id])
      .catch(() => {});
    return scope;
  }

  return { resolve, invalidate: (id) => cache.invalidate(id), cache, verifier };
}
