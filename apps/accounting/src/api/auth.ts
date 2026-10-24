// Finance authorization for the read API (#551): a staff-realm JWT through @platform/auth-sdk (or, only with
// ACCOUNTING_DEV_TOKENS=1 outside production, `Bearer dev:<keycloak_subject>` like the core's CORE_DEV_TOKENS), the
// subject must be an active staff_user, and the operation's `x-permission` (`finance` on `organization:hq`) is asked
// of OpenFGA for that staff_user.id — a store admin, however many stores, is a 403. OpenFGA unreachable = 503, fail
// closed. UI gating is a convenience; this is the boundary.
import { bearerToken, can, createStaffTokenVerifier, isApiError } from '@platform/auth-sdk';
import type { ScopedClient } from '@platform/db';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface Principal {
  subject: string;
  staffUserId: string;
}

export interface FinanceAuth {
  /** 401 without a valid token / active staff row; the principal otherwise. */
  authenticate(authorization: string | undefined): Promise<Principal>;
  /** 403 (contract shape, details { relation, object }) unless OpenFGA grants the relation; 503 when it cannot answer. */
  authorize(principal: Principal, permission: { relation: string; object: string }): Promise<void>;
}

export interface FinanceAuthOptions {
  client: ScopedClient;
  devTokens: boolean;
  keycloakUrl?: string;
  keycloakRealm?: string;
  /** Test seam; default `createStaffTokenVerifier`. */
  verifier?: { verify(token: string): Promise<{ subject: string }> };
  /** Test seam; default auth-sdk's `can(staffUserId, relation, object)` against OpenFGA. */
  permission?: (staffUserId: string, relation: string, object: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

export const DEV_TOKENS_FLAG = 'ACCOUNTING_DEV_TOKENS';
const DEV_PREFIX = 'dev:';

export function createFinanceAuth(options: FinanceAuthOptions): FinanceAuth {
  const env = options.env ?? process.env;
  const production = env.NODE_ENV === 'production';
  let verifier = options.verifier;
  const permission =
    options.permission ??
    ((staffUserId, relation, object) =>
      can(staffUserId, relation as Parameters<typeof can>[1], object));

  return {
    async authenticate(authorization) {
      const token = bearerToken(authorization);
      if (!token) throw new ApiError(401, 'unauthorized', 'Missing bearer token');
      let subject: string;
      if (token.startsWith(DEV_PREFIX)) {
        if (production)
          throw new ApiError(401, 'unauthorized', 'dev tokens are never accepted in production');
        if (!options.devTokens)
          throw new ApiError(
            401,
            'unauthorized',
            `dev tokens are not enabled (set ${DEV_TOKENS_FLAG}=1 locally)`,
          );
        subject = token.slice(DEV_PREFIX.length);
        if (subject === '') throw new ApiError(401, 'unauthorized', 'empty dev token subject');
      } else {
        verifier ??= createStaffTokenVerifier({
          ...(options.keycloakUrl ? { keycloakUrl: options.keycloakUrl } : {}),
          ...(options.keycloakRealm ? { realm: options.keycloakRealm } : {}),
        });
        try {
          subject = (await verifier.verify(token)).subject;
        } catch (err) {
          if (isApiError(err)) throw new ApiError(err.status, 'unauthorized', err.message);
          throw err;
        }
      }
      const row = await options.client.query<{ id: string }>(
        `SELECT id FROM staff_user WHERE keycloak_subject = $1 AND status = 'active'`,
        [subject],
      );
      if (row.rows.length === 0)
        throw new ApiError(401, 'unauthorized', 'unknown or disabled staff user');
      return { subject, staffUserId: row.rows[0]!.id };
    },

    async authorize(principal, perm) {
      let allowed: boolean;
      try {
        allowed = await permission(principal.staffUserId, perm.relation, perm.object);
      } catch {
        throw new ApiError(503, 'internal', 'permission service unavailable', {
          relation: perm.relation,
          object: perm.object,
        });
      }
      if (!allowed)
        throw new ApiError(403, 'forbidden', 'Not allowed', {
          relation: perm.relation,
          object: perm.object,
        });
    },
  };
}
