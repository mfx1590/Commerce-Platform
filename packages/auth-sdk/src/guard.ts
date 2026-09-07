// The package's headline API (issue #15, package CLAUDE.md): can(), allowedStores(), resolveScope() and the
// requirePermission() guard every mutating route calls, speaking exactly the `x-permission` language of
// packages/contracts admin-api.yaml: `organization:hq`, `store:{storeId}` / `store:{store_id}`, `store:*`.
import type { OpenFgaClient } from '@openfga/sdk';
import type { Relation } from '@platform/contracts';
import { createOpenFgaClient } from './fga/client.js';
import { resolveRelations, type StaffScope } from './scope/resolve.js';
import { ApiError, forbidden } from './types.js';

/** Whoever the check is about: a StaffScope/StaffPrincipal-shaped object or the bare staff_user.id. */
export type PermissionSubject = string | { userId: string };
export type PermissionRelation = Relation | 'viewer';

const userOf = (s: PermissionSubject) => `user:${typeof s === 'string' ? s : s.userId}`;

export interface GuardOptions {
  /** Defaults to `createOpenFgaClient()` (env-configured), created once per process. */
  fga?: OpenFgaClient;
}

let defaultFga: OpenFgaClient | undefined;
function fgaOf(opts?: GuardOptions): OpenFgaClient {
  if (opts?.fga) return opts.fga;
  defaultFga ??= createOpenFgaClient();
  return defaultFga;
}
/** Test hook: forget the memoized default client (env changed, store reseeded). */
export function resetDefaultOpenFgaClient(): void {
  defaultFga = undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Token conveniences (package CLAUDE.md names). Verifiers are built once per process from the environment;
// pass your own createStaffTokenVerifier()/createCustomerTokenVerifier() instance for anything non-default.
import {
  createStaffTokenVerifier,
  type StaffClaims,
  type StaffTokenVerifier,
} from './jwt/verify.js';
import {
  createCustomerTokenVerifier,
  type CustomerClaims,
  type CustomerTokenVerifier,
} from './jwt/customer.js';

let defaultStaffVerifier: StaffTokenVerifier | undefined;
let defaultCustomerVerifier: CustomerTokenVerifier | undefined;

/** Verifies a staff-realm token (env-configured verifier). Throws ApiError(401). */
export function verifyStaffToken(tokenOrHeader: string | undefined | null): Promise<StaffClaims> {
  defaultStaffVerifier ??= createStaffTokenVerifier();
  return defaultStaffVerifier.verify(tokenOrHeader);
}

/** Verifies a customers-realm token AND its store binding (`store_code` claim). Throws ApiError(401). */
export function verifyCustomerToken(
  tokenOrHeader: string | undefined | null,
  expectedStoreCode: string,
): Promise<CustomerClaims> {
  defaultCustomerVerifier ??= createCustomerTokenVerifier();
  return defaultCustomerVerifier.verify(tokenOrHeader, expectedStoreCode);
}

/** Wildcard object of the contract: "any store the caller can view" (resolved with ListObjects). */
export const ANY_STORE = 'store:*';

/**
 * Turns an `x-permission` object template into a concrete OpenFGA object.
 * `{param}` placeholders are read from `params` (route/query values); `store:*` passes through.
 * Missing or non-uuid store params → 400 (the route param is client input).
 */
export function resolvePermissionObject(
  template: string,
  params: Record<string, string | undefined> = {},
): string {
  if (template === ANY_STORE) return ANY_STORE;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (!value) {
      throw new ApiError(400, 'validation_error', `missing route parameter ${name}`, {
        field: name,
      });
    }
    return value;
  });
}

/** One OpenFGA check. `store:*` = does the subject see any store at all. OpenFGA failure → 503. */
export async function can(
  subject: PermissionSubject,
  relation: PermissionRelation,
  object: string,
  opts?: GuardOptions,
): Promise<boolean> {
  const fga = fgaOf(opts);
  try {
    if (object === ANY_STORE) {
      const stores = await fga.listObjects({
        user: userOf(subject),
        relation: 'viewer',
        type: 'store',
      });
      return stores.objects.length > 0;
    }
    const res = await fga.check({ user: userOf(subject), relation, object });
    return res.allowed === true;
  } catch {
    throw new ApiError(503, 'internal', 'authorization service unavailable');
  }
}

/** Every store the subject holds any relation on (`viewer`), as store ids. */
export async function allowedStores(
  subject: PermissionSubject,
  opts?: GuardOptions,
): Promise<string[]> {
  const fga = fgaOf(opts);
  try {
    const stores = await fga.listObjects({
      user: userOf(subject),
      relation: 'viewer',
      type: 'store',
    });
    return stores.objects.map((o) => o.replace(/^store:/, '')).sort();
  } catch {
    throw new ApiError(503, 'internal', 'authorization service unavailable');
  }
}

/** ADR 0002 §4 in one call: store ids + organization relations + scope kind for the subject. */
export async function resolveScope(
  subject: PermissionSubject,
  opts?: GuardOptions,
): Promise<Pick<StaffScope, 'storeIds' | 'organizationRelations' | 'scope'>> {
  return resolveRelations(fgaOf(opts), {
    userId: typeof subject === 'string' ? subject : subject.userId,
  });
}

export type PermissionObjectFactory =
  string | ((params: Record<string, string | undefined>) => string);

export interface PermissionGuard {
  readonly relation: PermissionRelation;
  /** Throws ApiError: 403 `{ code: forbidden, details: { relation, object } }` per the contract, 503 fail closed. */
  (
    subject: PermissionSubject,
    params?: Record<string, string | undefined>,
    opts?: GuardOptions,
  ): Promise<void>;
}

/**
 * Builds the guard for one route: `requirePermission('finance', 'organization:hq')`,
 * `requirePermission('store_admin', 'store:{storeId}')`, or a function of the route params.
 * The returned guard re-checks server-side on EVERY call — UI gating is a convenience, not security.
 */
export function requirePermission(
  relation: PermissionRelation,
  objectFactory: PermissionObjectFactory,
): PermissionGuard {
  const guard = async (
    subject: PermissionSubject,
    params: Record<string, string | undefined> = {},
    opts?: GuardOptions,
  ): Promise<void> => {
    const object =
      typeof objectFactory === 'function'
        ? objectFactory(params)
        : resolvePermissionObject(objectFactory, params);
    if (!(await can(subject, relation, object, opts))) throw forbidden(relation, object);
  };
  return Object.assign(guard, { relation }) as PermissionGuard;
}
