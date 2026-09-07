// Scope resolution (ADR 0002 §4): which stores a staff user may see and which organization relations they hold.
// Feeds the tenant context of @platform/db (ADR 0001 step 5). Fails closed: OpenFGA unreachable → 503.
import type { OpenFgaClient } from '@openfga/sdk';
import type { Relation } from '@platform/contracts';
import { ASSIGNABLE_RELATIONS } from '../roles/service.js';
import { ApiError } from '../types.js';

/** Organization relations a user can hold (owner, finance, operations, analyst, support). */
export const ORGANIZATION_RELATIONS: readonly Relation[] = [...ASSIGNABLE_RELATIONS.organization];

export interface StaffScope {
  /** staff_user.id */
  userId: string;
  /** Keycloak sub */
  subject: string;
  email: string;
  displayName: string;
  organizationId: string;
  /** Organization relations held directly or via owner (checked, not just assigned). */
  organizationRelations: Relation[];
  /** Stores where the user has any relation (`viewer`), including via organization relations. */
  storeIds: string[];
  /** `organization` when any organization relation is held, else `store` (storeIds may be empty). */
  scope: 'organization' | 'store';
}

export interface ResolveScopeInput {
  userId: string;
  /** Default `organization:hq`. */
  organizationObject?: string;
}

/** Runs ListObjects(store, viewer) + the organization relation checks. Throws ApiError(503) when OpenFGA fails. */
export async function resolveRelations(
  fga: OpenFgaClient,
  input: ResolveScopeInput,
): Promise<Pick<StaffScope, 'organizationRelations' | 'storeIds' | 'scope'>> {
  const user = `user:${input.userId}`;
  const object = input.organizationObject ?? 'organization:hq';
  try {
    const [stores, org] = await Promise.all([
      fga.listObjects({ user, relation: 'viewer', type: 'store' }),
      fga.listRelations({ user, object, relations: [...ORGANIZATION_RELATIONS] }),
    ]);
    const organizationRelations = ORGANIZATION_RELATIONS.filter((r) => org.relations.includes(r));
    const storeIds = stores.objects.map((o) => o.replace(/^store:/, '')).sort();
    return {
      organizationRelations,
      storeIds,
      scope: organizationRelations.length > 0 ? 'organization' : 'store',
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(503, 'internal', 'authorization service unavailable', {
      reason: (err as { name?: string }).name ?? 'openfga_error',
    });
  }
}

/** What @platform/db needs: organization client when `scope === 'organization'`, else a tenant client. */
export function toTenantContext(scope: StaffScope): {
  organizationId: string;
  storeIds: string[];
  actorId: string;
  scope: 'organization' | 'store';
} {
  return {
    organizationId: scope.organizationId,
    storeIds: scope.storeIds,
    actorId: scope.userId,
    scope: scope.scope,
  };
}

export const SCOPE_CACHE_MAX_TTL_MS = 30_000;

/** In-process per-subject cache (≤ 30 s), invalidated by staff_user id on every role change. */
export class ScopeCache {
  private readonly entries = new Map<string, { scope: StaffScope; expiresAt: number }>();
  readonly ttlMs: number;
  constructor(
    ttlMs: number = SCOPE_CACHE_MAX_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.ttlMs = Math.min(Math.max(0, ttlMs), SCOPE_CACHE_MAX_TTL_MS);
  }
  get(subject: string): StaffScope | undefined {
    const e = this.entries.get(subject);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(subject);
      return undefined;
    }
    return e.scope;
  }
  set(scope: StaffScope): void {
    if (this.ttlMs === 0) return;
    this.entries.set(scope.subject, { scope, expiresAt: this.now() + this.ttlMs });
  }
  /** Drop every entry of that staff user (role change through the tuple API). */
  invalidate(staffUserId: string): void {
    for (const [k, e] of this.entries) if (e.scope.userId === staffUserId) this.entries.delete(k);
  }
  clear(): void {
    this.entries.clear();
  }
  get size(): number {
    return this.entries.size;
  }
}
