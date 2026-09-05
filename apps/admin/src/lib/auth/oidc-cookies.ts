/** Short-lived cookies that carry PKCE state between /api/auth/login and /api/auth/callback. */

export const OIDC_STATE_COOKIE = 'admin_oidc_state';
export const OIDC_VERIFIER_COOKIE = 'admin_oidc_verifier';
export const OIDC_RETURN_TO_COOKIE = 'admin_oidc_return_to';

export const OIDC_TRANSIENT_COOKIES = [
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
  OIDC_RETURN_TO_COOKIE,
] as const;

/** Ten minutes is plenty for a login form and short enough to limit replay. */
const TRANSIENT_MAX_AGE_SECONDS = 600;

export function transientCookieAttributes(secure: boolean): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: TRANSIENT_MAX_AGE_SECONDS,
  };
}
