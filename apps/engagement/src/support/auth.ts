// Agent authentication and the server-side permission check (#556).
//
// Two gates, in this order, and both matter:
//
//   1. WHO. A staff-realm JWT through `@platform/auth-sdk`, then the subject looked up in `staff_user`: a token
//      is a claim, the row is the fact (the apps/notifications rule). Inactive or unknown → 401.
//   2. WHAT. `support` on `store:<id>` through OpenFGA, server-side, before any read — the #556 requirement
//      that every route carries a permission check with auth-sdk. A staff user of this organization who is
//      not support for THIS store gets 403, and so does one asking about another store.
//
// Then the agent's own Authorization header is forwarded to the Admin API, so the core checks the same agent
// again with its own `x-permission` rules. That is deliberate defence in depth, not redundancy: this check
// decides whether to make the call at all (and gives the agent a clean 403 instead of a leaked core error),
// and the core's check is the authority on the data. If they ever disagree, the core wins and nothing leaks.
//
// `dev:<subject>` tokens follow the same opt-in shape as `CORE_DEV_TOKENS` / `NOTIFICATIONS_DEV_TOKENS`:
// refused in production before the flag is even read.

import { bearerToken, createStaffTokenVerifier } from '@platform/auth-sdk';
import type { ScopedClient } from '@platform/db';
import { SupportError, type AgentPrincipal } from './types.js';

export const DEV_TOKENS_FLAG = 'ENGAGEMENT_DEV_TOKENS';
const DEV_PREFIX = 'dev:';

/** The slice of OpenFGA this module needs: "may this subject do `relation` on `object`?" */
export interface PermissionChecker {
  can(staffUserId: string, relation: string, object: string): Promise<boolean>;
}

export interface AgentAuthOptions {
  /** Organization-scoped client, for the `staff_user` lookup only. */
  client: ScopedClient;
  fga: PermissionChecker;
  devTokens?: boolean;
  keycloakUrl?: string;
  keycloakRealm?: string;
  /** Test seam; default `createStaffTokenVerifier`. */
  verifier?: { verify(token: string): Promise<{ subject: string }> };
  env?: NodeJS.ProcessEnv;
}

export interface AgentAuth {
  /** Gate 1: who. Throws `SupportError(401)`. */
  authenticate(authorization: string | undefined): Promise<AgentPrincipal>;
  /** Gate 2: what. Throws `SupportError(403)`. */
  requireSupport(principal: AgentPrincipal, storeId: string): Promise<void>;
}

export function createAgentAuth(options: AgentAuthOptions): AgentAuth {
  const env = options.env ?? process.env;
  const production = env.NODE_ENV === 'production';
  const devTokens = options.devTokens ?? env[DEV_TOKENS_FLAG] === '1';
  let verifier = options.verifier;

  function resolveVerifier(): { verify(token: string): Promise<{ subject: string }> } {
    const existing = verifier;
    if (existing) return existing;
    const built = createStaffTokenVerifier({
      ...(options.keycloakUrl ? { keycloakUrl: options.keycloakUrl } : {}),
      ...(options.keycloakRealm ? { realm: options.keycloakRealm } : {}),
    });
    verifier = built;
    return built;
  }

  return {
    async authenticate(authorization) {
      const token = bearerToken(authorization);
      if (!token) throw new SupportError(401, 'unauthorized', 'Missing bearer token');

      let subject: string;
      if (token.startsWith(DEV_PREFIX)) {
        // Production first, then the flag: a misconfigured production must never accept one.
        if (production) {
          throw new SupportError(
            401,
            'unauthorized',
            'Dev tokens are never accepted in production',
          );
        }
        if (!devTokens) {
          throw new SupportError(
            401,
            'unauthorized',
            `Dev tokens are not enabled (set ${DEV_TOKENS_FLAG}=1 locally)`,
          );
        }
        subject = token.slice(DEV_PREFIX.length);
        if (!subject) throw new SupportError(401, 'unauthorized', 'Dev token carries no subject');
      } else {
        try {
          ({ subject } = await resolveVerifier().verify(token));
        } catch {
          // Never echo the verifier's reason: it can quote the token.
          throw new SupportError(401, 'unauthorized', 'Invalid token');
        }
      }

      const row = await options.client.query<{ id: string }>(
        `SELECT id FROM staff_user WHERE keycloak_subject = $1 AND status = 'active'`,
        [subject],
      );
      const staffUserId = row.rows[0]?.id;
      if (!staffUserId) {
        throw new SupportError(401, 'unauthorized', 'Unknown or disabled staff user');
      }
      return { staffUserId, subject, authorization: authorization as string };
    },

    async requireSupport(principal, storeId) {
      let allowed: boolean;
      try {
        allowed = await options.fga.can(principal.staffUserId, 'support', `store:${storeId}`);
      } catch {
        // Fail CLOSED, and say so with a 503 rather than a 403: the agent is not forbidden, we cannot tell.
        // The same choice auth-sdk's own guard makes.
        throw new SupportError(503, 'unavailable', 'Permission service unavailable');
      }
      if (!allowed) {
        throw new SupportError(403, 'forbidden', 'Not a support agent for this store');
      }
    },
  };
}
