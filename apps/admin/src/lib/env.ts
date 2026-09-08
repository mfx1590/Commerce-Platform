/**
 * Server-side configuration. Never import this from a client component — it reads process.env,
 * which Next.js only populates on the server, and the session secret must never be bundled.
 *
 * Every value except ADMIN_SESSION_SECRET has a default matching the repo-root `.env.example`.
 * The secret has no default on purpose — see `sessionSecret()`.
 */

import { MOCK_URLS } from '@platform/contracts';

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/** Trailing slashes break OIDC and API URL joins, so normalise them once here. */
function withoutTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * A base URL that is not absolute http(s) fails every screen at once, and it fails deep inside
 * `new URL(base + path)` where the message names neither the variable nor the value. Checking it
 * here costs one throw at startup and says which variable to fix, the same bargain
 * `sessionSecret()` makes.
 */
function httpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL (got "${value}").`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http:// or https:// (got "${value}").`);
  }
  return value;
}

/**
 * Where the Admin API lives, most specific source first:
 *
 * 1. `ADMIN_API_URL` — the real core (`pnpm --filter @platform/core dev`, :9000).
 * 2. `MOCK_ADMIN_API_URL` — a Prism mock on a port of your choosing.
 * 3. `MOCK_URLS.admin` from the contracts package, which is what `pnpm mock` binds (:4011).
 *
 * Two names rather than one because they mean different things: `MOCK_ADMIN_API_URL` is shared with
 * the other apps' mock wiring and is the Phase 1 default, while `ADMIN_API_URL` is this app's
 * deliberate "point me at a real backend" switch. Keeping the mock variable as the fallback means
 * nothing changes for anyone who has not set the new one.
 *
 * Exported (and taking its source as an argument) so the resolution order is unit-testable without
 * reloading the module.
 */
export function resolveAdminApiUrl(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  for (const name of ['ADMIN_API_URL', 'MOCK_ADMIN_API_URL'] as const) {
    const value = source[name];
    if (value !== undefined && value !== '') {
      return withoutTrailingSlash(httpUrl(name, value));
    }
  }
  return MOCK_URLS.admin;
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
  /**
   * Admin API. `ADMIN_API_URL` (the real core on :9000) wins, then `MOCK_ADMIN_API_URL`, then the
   * contracts package's own mock URL — see `resolveAdminApiUrl`.
   */
  adminApiUrl: resolveAdminApiUrl(),
} as const;

export const OIDC_REDIRECT_PATH = '/api/auth/callback';

export function redirectUri(): string {
  return `${env.appUrl}${OIDC_REDIRECT_PATH}`;
}

export function realmIssuer(): string {
  return `${env.keycloakUrl}/realms/${env.keycloakRealm}`;
}
