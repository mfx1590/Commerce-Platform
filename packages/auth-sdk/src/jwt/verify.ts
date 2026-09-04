// Keycloak JWT verification (JWKS of the realm, RS256, issuer + audience pinned). Any failure → 401.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ApiError } from '../types.js';

export interface StaffTokenVerifierOptions {
  /** `KEYCLOAK_URL`, default http://localhost:8180 */
  keycloakUrl?: string;
  /** `KEYCLOAK_REALM_STAFF`, default `staff` */
  realm?: string;
  /** Expected `aud` claim (the audience mapper in infra/keycloak). Default `core-api`. */
  audience?: string;
  /** Override the JWKS URL (tests). */
  jwksUri?: string;
}

export interface StaffClaims {
  /** Keycloak user id → `staff_user.keycloak_subject`. */
  subject: string;
  email?: string;
  preferredUsername?: string;
  name?: string;
  issuer: string;
  expiresAt: number;
  raw: JWTPayload;
}

export interface StaffTokenVerifier {
  readonly issuer: string;
  /** Accepts a raw token or an `Authorization: Bearer …` header value. Throws ApiError(401). */
  verify(tokenOrHeader: string | undefined | null): Promise<StaffClaims>;
}

export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? m[1]! : header.includes(' ') ? null : header;
}

export function createStaffTokenVerifier(opts: StaffTokenVerifierOptions = {}): StaffTokenVerifier {
  const keycloakUrl = (
    opts.keycloakUrl ??
    process.env.KEYCLOAK_URL ??
    'http://localhost:8180'
  ).replace(/\/+$/, '');
  const realm = opts.realm ?? process.env.KEYCLOAK_REALM_STAFF ?? 'staff';
  const audience = opts.audience ?? 'core-api';
  const issuer = `${keycloakUrl}/realms/${realm}`;
  const jwks = createRemoteJWKSet(
    new URL(opts.jwksUri ?? `${issuer}/protocol/openid-connect/certs`),
    {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    },
  );

  return {
    issuer,
    async verify(tokenOrHeader) {
      const token = bearerToken(tokenOrHeader);
      if (!token) throw new ApiError(401, 'unauthorized', 'Missing bearer token');
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer, audience, algorithms: ['RS256'] }));
      } catch (err) {
        // jose error codes are stable (ERR_JWT_EXPIRED, ERR_JWS_SIGNATURE_VERIFICATION_FAILED, …); never echo the token.
        const code = (err as { code?: string }).code ?? 'invalid';
        throw new ApiError(401, 'unauthorized', 'Invalid bearer token', { reason: code });
      }
      if (!payload.sub)
        throw new ApiError(401, 'unauthorized', 'Invalid bearer token', { reason: 'no_sub' });
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const claims: StaffClaims = {
        subject: payload.sub,
        issuer,
        expiresAt: payload.exp ?? 0,
        raw: payload,
      };
      const email = str(payload.email);
      const preferredUsername = str(payload.preferred_username);
      const name = str(payload.name);
      if (email) claims.email = email;
      if (preferredUsername) claims.preferredUsername = preferredUsername;
      if (name) claims.name = name;
      return claims;
    },
  };
}
