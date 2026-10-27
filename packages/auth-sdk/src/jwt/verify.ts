// Keycloak JWT verification (JWKS of the realm, RS256, issuer + audience pinned). Any failure → 401.
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ApiError } from '../types.js';
import {
  assertServiceClientMayCall,
  readOnlyServiceClientOf,
  type ServiceClientRefusal,
  type StaffRequestContext,
} from './service-clients.js';

export interface StaffTokenVerifierOptions {
  /** Where a read-only service client's refused write is reported (default: one JSON line on stderr). */
  onServiceClientRefusal?: (refusal: ServiceClientRefusal) => void;
  /** `KEYCLOAK_URL`, default http://localhost:8180 */
  keycloakUrl?: string;
  /** `KEYCLOAK_REALM_STAFF`, default `staff` */
  realm?: string;
  /** Expected `aud` claim (the audience mapper in infra/keycloak). Default `core-api`. */
  audience?: string;
  /** Override the JWKS URL (tests only — the constructor throws when `NODE_ENV === 'production'`). */
  jwksUri?: string;
}

export interface StaffClaims {
  /** Keycloak user id → `staff_user.keycloak_subject`. */
  subject: string;
  email?: string;
  preferredUsername?: string;
  name?: string;
  /**
   * Set when the token belongs to a read-only service-account client (`READ_ONLY_SERVICE_CLIENTS`, from the
   * verified `azp`): such a token only ever passes `verify` with a safe request method (#565 / #622).
   */
  serviceClient?: string;
  issuer: string;
  expiresAt: number;
  raw: JWTPayload;
}

export interface StaffTokenVerifier {
  readonly issuer: string;
  /**
   * Accepts a raw token or an `Authorization: Bearer …` header value. Throws ApiError(401). Pass the request
   * (`{ method, operationId }`): a read-only service client is refused (403) on any non-GET/HEAD method and
   * whenever the request is not given; everyone else is unaffected by it.
   */
  verify(
    tokenOrHeader: string | undefined | null,
    request?: StaffRequestContext,
  ): Promise<StaffClaims>;
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
  // The override exists for tests. In production the signing keys come from the issuer's own JWKS and
  // nowhere else — whoever serves the JWKS decides which tokens are valid (#314).
  if (opts.jwksUri !== undefined && process.env.NODE_ENV === 'production') {
    throw new Error('jwksUri must not be set when NODE_ENV=production');
  }
  const jwks = createRemoteJWKSet(
    new URL(opts.jwksUri ?? `${issuer}/protocol/openid-connect/certs`),
    {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    },
  );

  return {
    issuer,
    async verify(tokenOrHeader, request) {
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
      // Read-only service clients: refused on any write BEFORE any permission check (#565 / #622).
      const serviceClient = readOnlyServiceClientOf(payload);
      if (serviceClient) {
        assertServiceClientMayCall(serviceClient, request, opts.onServiceClientRefusal);
        claims.serviceClient = serviceClient;
      }
      return claims;
    },
  };
}
