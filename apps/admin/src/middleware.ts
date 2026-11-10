/**
 * The single gate in front of every page.
 *
 * It is also the only place that can refresh the session: a server component may read cookies but
 * not write them, so the access token is renewed here and handed to the current request as well as
 * to the browser. UI permission gating happens later (issue #25) and is only a convenience — the
 * Admin API re-checks every `x-permission` server-side.
 *
 * It also refuses a session Keycloak no longer has (#353): a sealed cookie cannot be revoked, so a
 * copy kept from before Sign out is checked against the realm (`isSessionLive`, cached 30 s per
 * session, fail closed). A refresh proves the session live by itself.
 *
 * And it sets the Content-Security-Policy (Phase 6 D4): a new nonce per response, on the response
 * for the browser and on the forwarded request for Next, which stamps it on its inline scripts
 * (src/lib/security/csp.ts). The sign-in error page is outside the session gate but inside the CSP.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isProduction, sessionSecret } from '@/lib/env';
import { CSP_HEADER, NONCE_HEADER, contentSecurityPolicy, newNonce } from '@/lib/security';
import { refreshTokens, sessionIdOf, sessionIsLive } from '@/lib/auth/oidc';
import { isSessionLive, markLive } from '@/lib/auth/liveness';
import type { CookieWriter } from '@/lib/auth/session';
import {
  clearSessionCookies,
  isExpiring,
  joinChunks,
  openSession,
  sealSession,
  writeSessionCookies,
} from '@/lib/auth/session';

function toLogin(request: NextRequest): NextResponse {
  const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const url = new URL('/api/auth/login', request.nextUrl.origin);
  if (returnTo !== '/') {
    url.searchParams.set('returnTo', returnTo);
  }
  const response = NextResponse.redirect(url);
  clearSessionCookies(response.cookies);
  return response;
}

/** Pages that render without a session; they still get the CSP. */
const PUBLIC_PAGES = new Set(['/auth/error']);

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const nonce = newNonce();
  const policy = contentSecurityPolicy({
    nonce,
    keycloakUrl: process.env.KEYCLOAK_URL,
    production: isProduction,
  });
  // Built when the gate lets the request through, after it has rewritten the session cookie on
  // the request, so the copy carries the refreshed token too.
  const forward = (): NextResponse => {
    const headers = new Headers(request.headers);
    headers.set(NONCE_HEADER, nonce);
    headers.set(CSP_HEADER, policy);
    return NextResponse.next({ request: { headers } });
  };

  const response = PUBLIC_PAGES.has(request.nextUrl.pathname)
    ? forward()
    : await gate(request, forward);
  response.headers.set(CSP_HEADER, policy);
  return response;
}

async function gate(request: NextRequest, forward: () => NextResponse): Promise<NextResponse> {
  const secret = sessionSecret();
  const sealed = joinChunks((name) => request.cookies.get(name)?.value);
  if (sealed === null) {
    return toLogin(request);
  }

  const session = await openSession(sealed, secret);
  if (session === null) {
    return toLogin(request);
  }

  const sessionId = sessionIdOf(session.idToken);

  if (!isExpiring(session)) {
    // Keycloak down or the session ended there (Sign out elsewhere, an admin's "sign out"): sign in
    // again rather than render with a session the realm no longer has — never a 500.
    const live = await isSessionLive(sessionId, () => sessionIsLive(session.accessToken));
    return live ? forward() : toLogin(request);
  }

  let refreshedCookie: string;
  try {
    const refreshed = await refreshTokens(session.refreshToken);
    refreshedCookie = await sealSession(refreshed, secret);
    markLive(sessionIdOf(refreshed.idToken));
  } catch {
    // The refresh token is spent or Keycloak is down: start a clean sign-in rather than
    // letting the page render with a token the Admin API will reject.
    return toLogin(request);
  }

  // Update the *incoming* request too, so this render already sees the new token.
  const requestWriter: CookieWriter = {
    set: (name, value) => request.cookies.set(name, value),
    delete: (name) => request.cookies.delete(name),
  };
  writeSessionCookies(requestWriter, refreshedCookie, isProduction);

  const response = forward();
  writeSessionCookies(response.cookies, refreshedCookie, isProduction);
  return response;
}

export const config = {
  // Everything except the auth endpoints themselves, the container's liveness probe, and assets.
  // A probe that gets redirected to sign-in never reports healthy, so the pod would never become
  // ready. The sign-in error page is matched for its CSP and let through as a PUBLIC_PAGES entry.
  matcher: ['/((?!api/auth|health|_next/static|_next/image|favicon.ico).*)'],
};
