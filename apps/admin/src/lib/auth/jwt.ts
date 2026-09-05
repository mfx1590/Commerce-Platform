/**
 * Minimal JWT payload decoding.
 *
 * Deliberately not a verifying library: the only token this app decodes is the ID token, which it
 * received over TLS straight from Keycloak's token endpoint, so its signature does not need
 * re-checking here (OIDC Core §3.1.3.7 note 2). The Admin API verifies the *access* token against
 * the realm JWKS on every request — that is the security boundary.
 *
 * Hand-rolled rather than pulled from `jose` because this code also runs in the Edge middleware,
 * where `jose`'s JWE support drags in CompressionStream and trips the Edge runtime warning.
 */

import { fromBase64Url } from './crypto';

const decoder = new TextDecoder();

export type JwtClaims = Record<string, unknown>;

export function decodeJwtClaims(token: string): JwtClaims {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload === '') {
    throw new Error('Malformed JWT: expected three dot-separated segments');
  }
  const json = decoder.decode(fromBase64Url(payload));
  const claims: unknown = JSON.parse(json);
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw new Error('Malformed JWT: payload is not a JSON object');
  }
  return claims as JwtClaims;
}

export function stringClaim(claims: JwtClaims, name: string): string {
  const value = claims[name];
  return typeof value === 'string' ? value : '';
}
