import { createHash, randomBytes } from 'node:crypto';

/**
 * OIDC authorization-code flow with PKCE against the Keycloak **customers** realm.
 *
 * `storefront-brand-a` is a public client (no secret), so PKCE is what binds the authorization code
 * to this browser. The code exchange still happens on the server, and the tokens never reach the
 * page: they live in an httpOnly cookie and are attached by the Store API client.
 *
 * Window 13 takes the account area over in Phase 3; this is deliberately the smallest thing that is
 * correct, not a session framework.
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

export function oidcConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): OidcConfig {
  const keycloakUrl = env.KEYCLOAK_URL ?? 'http://localhost:8180';
  const realm = env.KEYCLOAK_REALM_CUSTOMERS ?? 'customers';
  const appUrl = env.SITE_URL ?? 'http://localhost:3100';

  return {
    issuer: `${keycloakUrl.replace(/\/+$/, '')}/realms/${realm}`,
    clientId: env.KEYCLOAK_CLIENT_ID ?? 'storefront-brand-a',
    redirectUri: `${appUrl.replace(/\/+$/, '')}/account/callback`,
    scope: 'openid profile email',
  };
}

export function authorizationEndpoint(config: OidcConfig): string {
  return `${config.issuer}/protocol/openid-connect/auth`;
}

export function tokenEndpoint(config: OidcConfig): string {
  return `${config.issuer}/protocol/openid-connect/token`;
}

export function endSessionEndpoint(config: OidcConfig): string {
  return `${config.issuer}/protocol/openid-connect/logout`;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────────────────────────

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 recommends 43–128 characters of entropy; 32 random bytes gives 43. */
export function createCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 challenge, the only method the realm accepts (`pkce.code.challenge.method`). */
export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function createState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizationUrl(
  config: OidcConfig,
  params: { state: string; codeVerifier: string },
): string {
  const url = new URL(authorizationEndpoint(config));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', codeChallenge(params.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ── redirect safety ──────────────────────────────────────────────────────────────────────────────

/**
 * Where to send the customer after sign-in. **Only same-site paths**: an attacker who can make
 * someone click `/account/sign-in?returnTo=https://evil.example` must not be able to bounce them off
 * this domain carrying a fresh session.
 */
export function safeReturnTo(value: string | null | undefined, fallback = '/account'): string {
  if (typeof value !== 'string' || value === '') return fallback;
  // Reject anything that is not a plain path: absolute URLs, protocol-relative `//evil`, backslashes.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (value.includes('\\')) return fallback;
  return value;
}

// ── token exchange ───────────────────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  token_type: string;
}

async function postToken(
  config: OidcConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(tokenEndpoint(config), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    cache: 'no-store',
  });

  if (!response.ok) {
    // Never log the body: it can echo the code or the refresh token.
    throw new Error(`Token endpoint returned ${response.status}`);
  }
  return (await response.json()) as TokenResponse;
}

export function exchangeCode(
  config: OidcConfig,
  params: { code: string; codeVerifier: string },
  fetchImpl?: typeof fetch,
): Promise<TokenResponse> {
  return postToken(
    config,
    {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code: params.code,
      code_verifier: params.codeVerifier,
    },
    fetchImpl,
  );
}

export function refreshTokens(
  config: OidcConfig,
  refreshToken: string,
  fetchImpl?: typeof fetch,
): Promise<TokenResponse> {
  return postToken(
    config,
    {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    },
    fetchImpl,
  );
}
