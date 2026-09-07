import { cookies } from 'next/headers';
import { cache } from 'react';
import type { TokenResponse } from './oidc';

/**
 * The customer session: the tokens from Keycloak, in an httpOnly cookie.
 *
 * No page or component ever sees them — `getAccessToken()` is read by server code and handed to the
 * Store API client, which only ever attaches it to `/store/customers/*` and `/store/orders/{id}`.
 *
 * Phase 1 keeps the tokens in the cookie itself: it is the smallest correct thing and window 13
 * owns this folder from Phase 3. Two known limits, recorded in the memory file: a cookie caps at
 * ~4 KB, and refreshing requires a request that may write cookies (a route handler), so a page that
 * finds an expired token redirects through sign-in rather than refreshing mid-render — Keycloak's
 * SSO session means the customer is not asked for a password again.
 */

const SESSION_COOKIE = 'customer_session';
/** Clock skew allowance, so a token that expires mid-request is treated as already expired. */
const EXPIRY_SKEW_SECONDS = 30;

export interface CustomerSession {
  accessToken: string;
  refreshToken?: string;
  /** Kept only to pass as `id_token_hint` at sign-out, so Keycloak ends its SSO session without
   * showing the customer a "do you really want to log out?" confirmation page. */
  idToken?: string;
  /** Unix seconds. */
  expiresAt: number;
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
} as const;

export function sessionFromTokens(tokens: TokenResponse, now = Date.now()): CustomerSession {
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
    ...(tokens.id_token === undefined ? {} : { idToken: tokens.id_token }),
    expiresAt: Math.floor(now / 1000) + tokens.expires_in,
  };
}

export function isExpired(session: CustomerSession, now = Date.now()): boolean {
  return session.expiresAt - EXPIRY_SKEW_SECONDS <= Math.floor(now / 1000);
}

/** Tolerant on purpose: a corrupted or truncated cookie means "signed out", never a crash. */
export function parseSession(raw: string | undefined): CustomerSession | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.accessToken !== 'string' || candidate.accessToken === '') return null;
    if (typeof candidate.expiresAt !== 'number') return null;
    return {
      accessToken: candidate.accessToken,
      ...(typeof candidate.refreshToken === 'string'
        ? { refreshToken: candidate.refreshToken }
        : {}),
      ...(typeof candidate.idToken === 'string' ? { idToken: candidate.idToken } : {}),
      expiresAt: candidate.expiresAt,
    };
  } catch {
    return null;
  }
}

export const getSession = cache(async (): Promise<CustomerSession | null> => {
  return parseSession((await cookies()).get(SESSION_COOKIE)?.value);
});

/** The token to send to the Store API, or null when there is no usable session. */
export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  if (session === null || isExpired(session)) return null;
  return session.accessToken;
}

export async function isSignedIn(): Promise<boolean> {
  return (await getAccessToken()) !== null;
}

/** Route handlers and server actions only — writes a cookie. */
export async function saveSession(session: CustomerSession): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, JSON.stringify(session), {
    ...COOKIE_OPTIONS,
    // The cookie outlives the access token so a refresh token is still available afterwards.
    maxAge: 60 * 60 * 24 * 14,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
