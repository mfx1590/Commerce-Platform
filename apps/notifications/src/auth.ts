// Staff authentication for the preview route (#360): a real staff-realm JWT through @platform/auth-sdk, or
// — only with `NOTIFICATIONS_DEV_TOKENS=1` and never in production — `Bearer dev:<keycloak_subject>`, the same
// opt-in shape as the core's `CORE_DEV_TOKENS`. Either way the subject must be an active `staff_user`: a token
// is a claim, the row is the fact. No OpenFGA relation is checked — the route renders sample data, and "is a
// staff member of this organization" is the whole question.
import { bearerToken, createStaffTokenVerifier, isApiError } from '@platform/auth-sdk';
import type { ScopedClient } from '@platform/db';

export class AuthError extends Error {
  override readonly name = 'AuthError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface StaffAuth {
  /** Resolves the staff subject behind an `Authorization` header, or throws `AuthError(401)`. */
  authenticate(authorization: string | undefined): Promise<{ subject: string }>;
}

export interface StaffAuthOptions {
  client: ScopedClient;
  devTokens: boolean;
  keycloakUrl?: string;
  keycloakRealm?: string;
  /** Test seam; default `createStaffTokenVerifier` from the Keycloak options above. */
  verifier?: { verify(token: string): Promise<{ subject: string }> };
  env?: NodeJS.ProcessEnv;
}

export const DEV_TOKENS_FLAG = 'NOTIFICATIONS_DEV_TOKENS';
const DEV_PREFIX = 'dev:';

export function createStaffAuth(options: StaffAuthOptions): StaffAuth {
  const env = options.env ?? process.env;
  const production = env.NODE_ENV === 'production';
  let verifier = options.verifier;

  async function isActiveStaff(subject: string): Promise<boolean> {
    const res = await options.client.query<{ ok: number }>(
      `SELECT 1 AS ok FROM staff_user WHERE keycloak_subject = $1 AND status = 'active'`,
      [subject],
    );
    return res.rows.length > 0;
  }

  return {
    async authenticate(authorization) {
      const token = bearerToken(authorization);
      if (!token) throw new AuthError(401, 'missing bearer token');

      let subject: string;
      if (token.startsWith(DEV_PREFIX)) {
        if (production) throw new AuthError(401, 'dev tokens are never accepted in production');
        if (!options.devTokens) {
          throw new AuthError(401, `dev tokens are not enabled (set ${DEV_TOKENS_FLAG}=1 locally)`);
        }
        subject = token.slice(DEV_PREFIX.length);
        if (subject === '') throw new AuthError(401, 'empty dev token subject');
      } else {
        verifier ??= createStaffTokenVerifier({
          ...(options.keycloakUrl ? { keycloakUrl: options.keycloakUrl } : {}),
          ...(options.keycloakRealm ? { realm: options.keycloakRealm } : {}),
        });
        try {
          subject = (await verifier.verify(token)).subject;
        } catch (err) {
          if (isApiError(err)) throw new AuthError(err.status, err.message);
          throw err;
        }
      }

      if (!(await isActiveStaff(subject))) {
        throw new AuthError(401, 'unknown or disabled staff user');
      }
      return { subject };
    },
  };
}
