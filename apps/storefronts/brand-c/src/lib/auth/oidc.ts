import { siteUrl } from '@/brand/config';
import { isSafeInternalPath } from '@/lib/safe-path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * OIDC authorization-code flow with PKCE against the Keycloak **customers** realm.
 *
 * Each storefront's client (`KEYCLOAK_CLIENT_ID`, e.g. `storefront-brand-a`) is a public client
 * (no secret), so PKCE is what binds the authorization code to this browser. The code exchange still happens on the server, and the tokens never reach the
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

/** The identity provider and this app's client in it — everything that does not depend on where the site lives. */
export type OidcProvider = Pick<OidcConfig, 'issuer' | 'clientId'>;

/** This app's client was needed and nothing says which it is. */
export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcConfigError';
  }
}

/**
 * What the client id defaults to on a developer's machine: the dev realm's client for the starter
 * and brand A. **Development only** — see `oidcClientId`.
 */
export const LOCAL_DEVELOPMENT_CLIENT_ID = 'storefront-brand-a';

/**
 * The Keycloak client this storefront signs customers in through — `KEYCLOAK_CLIENT_ID`.
 *
 * **Fails closed** (#441), with the same allow-list as `siteUrl()` (#298/#320): the documented
 * default applies only under `next dev` / unit tests (`NODE_ENV` development or test) and while
 * `next build` runs; anywhere else an unset id throws. A default here is not cosmetic: a customer
 * token is bound to a store by the `store_code` claim **each storefront client stamps**, so a brand
 * that forgot the variable would sign its customers in through brand A's client and mint sessions
 * scoped to `brand-a` (measured on brand B: Keycloak refused its callback as an invalid
 * redirect_uri, which looked like a realm problem and was a wrong client).
 */
export function oidcClientId(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.KEYCLOAK_CLIENT_ID ?? '').trim();
  if (configured !== '') return configured;

  const local = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  if (local || env.NEXT_PHASE === 'phase-production-build') return LOCAL_DEVELOPMENT_CLIENT_ID;
  throw new OidcConfigError(
    'KEYCLOAK_CLIENT_ID is not set. A production server must name its own Keycloak client ' +
      '(for example KEYCLOAK_CLIENT_ID=storefront-brand-c): customer sessions are bound to the ' +
      "store that client stamps, so borrowing another brand's client would bind them to that brand.",
  );
}

export function oidcProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): OidcProvider {
  const keycloakUrl = env.KEYCLOAK_URL ?? 'http://localhost:8180';
  const realm = env.KEYCLOAK_REALM_CUSTOMERS ?? 'customers';

  return {
    issuer: `${keycloakUrl.replace(/\/+$/, '')}/realms/${realm}`,
    clientId: oidcClientId(env),
  };
}

/**
 * The callback is on **this site's configured origin** — `siteUrl()`, the same definition every
 * other absolute URL uses, not a second copy of the `SITE_URL` fallback (there was one here, and it
 * ignored a brand's fixed origin). Throws `SiteUrlError` when a production server has none: a
 * sign-in cannot start without knowing where Keycloak should send the customer back to.
 */
export function oidcConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): OidcConfig {
  // The callback first: with nothing configured, "SITE_URL is not set" is the first thing to fix.
  const redirectUri = `${siteUrl(env)}/auth/callback`;
  return { ...oidcProviderFromEnv(env), redirectUri, scope: 'openid profile email' };
}

export function authorizationEndpoint(config: OidcConfig): string {
  return `${config.issuer}/protocol/openid-connect/auth`;
}

export function tokenEndpoint(config: Pick<OidcConfig, 'issuer'>): string {
  return `${config.issuer}/protocol/openid-connect/token`;
}

export function endSessionEndpoint(config: Pick<OidcConfig, 'issuer'>): string {
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
 * someone click `/auth/sign-in?returnTo=https://evil.example` must not be able to bounce them off
 * this domain carrying a fresh session.
 *
 * The caller supplies the fallback, because the account page lives under a locale prefix and only
 * the request knows which one.
 */
export function safeReturnTo(value: string | null | undefined, fallback = '/account'): string {
  // The rule lives in `isSafeInternalPath`, shared with the referral landing: absolute URLs,
  // protocol-relative `//evil`, backslashes — and control characters, which URL parsing strips
  // before parsing, so `/\t/evil.example` resolved to another origin and this guard did not see it.
  // The callback route checks the resolved origin too.
  return isSafeInternalPath(value) ? value : fallback;
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
  config: OidcProvider,
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

/**
 * Takes the provider half only: a refresh names the issuer and the client, never the callback,
 * so it can never depend on `SITE_URL` (#298) — a stale token on a cart call must not become a
 * missing-origin failure.
 */
export function refreshTokens(
  config: OidcProvider,
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
