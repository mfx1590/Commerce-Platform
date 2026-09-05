/**
 * Server-side configuration. Never import this from a client component — it reads process.env,
 * which Next.js only populates on the server, and the session secret must never be bundled.
 *
 * Every value except ADMIN_SESSION_SECRET has a default matching the repo-root `.env.example`.
 * The secret has no default on purpose — see `sessionSecret()`.
 */

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/** Trailing slashes break OIDC and API URL joins, so normalise them once here. */
function withoutTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export const isProduction = process.env.NODE_ENV === 'production';

/** 256 bits of base64 is 44 characters; 32 is the floor we accept. */
const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * The key the session cookie is encrypted with. Required in every environment, including
 * development and tests.
 *
 * There used to be a hard-coded development fallback here. It was a bad idea: a constant committed
 * to the repository is a key everyone has, and the difference between "dev" and "production" is one
 * mis-set `NODE_ENV` away. Failing loudly with instructions costs one command; silently encrypting
 * real sessions with a public constant does not fail at all until it matters.
 */
export function sessionSecret(): string {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (value === undefined || value === '') {
    throw new Error(
      'ADMIN_SESSION_SECRET is not set. Generate one with `openssl rand -base64 32` and put it in ' +
        'apps/admin/.env.local — see apps/admin/.env.example.',
    );
  }
  if (value.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `ADMIN_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (got ${value.length}).`,
    );
  }
  return value;
}

export const env = {
  /** Keycloak base URL, e.g. http://localhost:8180 (port 8180 — 8080 is taken on dev machines). */
  keycloakUrl: withoutTrailingSlash(optional('KEYCLOAK_URL', 'http://localhost:8180')),
  /** Staff realm. Customers live in a separate realm and never sign in here. */
  keycloakRealm: optional('KEYCLOAK_REALM_STAFF', 'staff'),
  /** Public OIDC client (PKCE, no secret) declared in infra/keycloak/staff-realm.json. */
  oidcClientId: optional('ADMIN_OIDC_CLIENT_ID', 'admin-app'),
  /** Public origin of this app; the OIDC redirect URI is derived from it. */
  appUrl: withoutTrailingSlash(optional('ADMIN_APP_URL', 'http://localhost:3000')),
  /** Admin API. Phase 1 points at the Prism mock (`pnpm mock`). */
  adminApiUrl: withoutTrailingSlash(optional('MOCK_ADMIN_API_URL', 'http://localhost:4011')),
} as const;

export const OIDC_REDIRECT_PATH = '/api/auth/callback';

export function redirectUri(): string {
  return `${env.appUrl}${OIDC_REDIRECT_PATH}`;
}

export function realmIssuer(): string {
  return `${env.keycloakUrl}/realms/${env.keycloakRealm}`;
}
