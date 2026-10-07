/**
 * OpenID Connect authorization-code flow with PKCE against the Keycloak staff realm.
 *
 * The client (`admin-app`) is public: there is no client secret anywhere in this app, and the
 * code verifier is what proves the callback belongs to the browser that started the sign-in.
 * Every call here happens on the server; tokens never cross into a client component.
 */

import { env, realmIssuer } from '../env';
import { decodeJwtClaims, stringClaim } from './jwt';
import type { Session, SessionUser } from './session';

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

interface CachedMetadata {
  value: OidcMetadata;
  fetchedAt: number;
}

const METADATA_TTL_MS = 5 * 60_000;
let cache: CachedMetadata | null = null;

/** Exposed for tests: forget the cached discovery document. */
export function resetDiscoveryCache(): void {
  cache = null;
}

export async function discover(): Promise<OidcMetadata> {
  const now = Date.now();
  if (cache !== null && now - cache.fetchedAt < METADATA_TTL_MS) {
    return cache.value;
  }
  const url = `${realmIssuer()}/.well-known/openid-configuration`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    // Keycloak answers 500 while it is still importing realms; the caller surfaces this as a
    // sign-in error rather than a blank page.
    throw new Error(`OIDC discovery failed (${response.status}) at ${url}`);
  }
  const value = (await response.json()) as OidcMetadata;
  cache = { value, fetchedAt: now };
  return value;
}

export interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}

export async function authorizationUrl(request: AuthorizationRequest): Promise<string> {
  const metadata = await discover();
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('client_id', env.oidcClientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('state', request.state);
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
}

async function requestTokens(body: URLSearchParams): Promise<TokenResponse> {
  const metadata = await discover();
  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Token endpoint returned ${response.status}: ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as TokenResponse;
}

export async function exchangeCode(
  code: string,
  codeVerifier: string,
  uri: string,
): Promise<Session> {
  const tokens = await requestTokens(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.oidcClientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: uri,
    }),
  );
  return toSession(tokens);
}

export async function refreshTokens(refreshToken: string): Promise<Session> {
  const tokens = await requestTokens(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.oidcClientId,
      refresh_token: refreshToken,
    }),
  );
  return toSession(tokens);
}

/**
 * Ends the realm's SSO session **server-side**, before the browser is sent anywhere (#353).
 *
 * Keycloak's front-channel end-session can stop on a "Do you want to log out?" page; a user who
 * abandons it used to keep a live SSO session, and the next admin request signed them straight back
 * in. Posting the refresh token to the end-session endpoint (public client: `client_id` is the
 * authentication) kills the session whatever happens in the browser. True on 2xx; false when
 * Keycloak refused or could not be reached — the caller drops the local session either way.
 */
export async function endKeycloakSession(refreshToken: string): Promise<boolean> {
  try {
    const metadata = await discover();
    if (metadata.end_session_endpoint === undefined) return false;
    const response = await fetch(metadata.end_session_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.oidcClientId, refresh_token: refreshToken }),
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether the realm still knows the session behind this access token: Keycloak's userinfo answers
 * 401 once the session is ended (sign-out, an admin's "sign out", expiry). Fails **closed**: any
 * answer but 200, or no answer at all, is "not live" — the admin's own session then goes back to
 * sign-in. Only the admin app asks this; the core keeps verifying JWTs offline.
 */
export async function sessionIsLive(accessToken: string): Promise<boolean> {
  try {
    const metadata = await discover();
    if (metadata.userinfo_endpoint === undefined) return false;
    const response = await fetch(metadata.userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Keycloak's session id (`sid`) from the ID token, or '' when it carries none. */
export function sessionIdOf(idToken: string): string {
  try {
    return stringClaim(decodeJwtClaims(idToken), 'sid');
  } catch {
    return '';
  }
}

export async function endSessionUrl(
  idToken: string,
  postLogoutRedirectUri: string,
): Promise<string> {
  const metadata = await discover();
  if (metadata.end_session_endpoint === undefined) {
    return postLogoutRedirectUri;
  }
  const url = new URL(metadata.end_session_endpoint);
  url.searchParams.set('id_token_hint', idToken);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  return url.toString();
}

/** Maps ID-token claims onto the session's user block (see src/lib/auth/jwt.ts on verification). */
export function claimsToUser(idToken: string): SessionUser {
  const claims = decodeJwtClaims(idToken);
  const username = stringClaim(claims, 'preferred_username');
  const name = stringClaim(claims, 'name');
  return {
    subject: stringClaim(claims, 'sub'),
    username,
    email: stringClaim(claims, 'email'),
    displayName: name !== '' ? name : username,
  };
}

function toSession(tokens: TokenResponse): Session {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    user: claimsToUser(tokens.id_token),
  };
}
