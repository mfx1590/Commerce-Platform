/**
 * Server-side configuration. Never import this from a client component — it reads process.env,
 * which Next.js only populates on the server, and the session secret must never be bundled.
 *
 * Defaults match `.env.example` at the repo root so `pnpm dev` works with no extra setup.
 */

const DEV_SESSION_SECRET = 'admin-dev-session-secret-not-for-production';

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/** Trailing slashes break OIDC and API URL joins, so normalise them once here. */
function withoutTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export const isProduction = process.env.NODE_ENV === 'production';

/**
 * The session cookie is encrypted with this value. In production it is required and must be at
 * least 32 characters; in development a constant is used so restarts do not sign everybody out.
 */
export function sessionSecret(): string {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (value === undefined || value === '') {
    if (isProduction) {
      throw new Error('ADMIN_SESSION_SECRET is required in production');
    }
    return DEV_SESSION_SECRET;
  }
  if (isProduction && value.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters');
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
