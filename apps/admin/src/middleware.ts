/**
 * The single gate in front of every page.
 *
 * It is also the only place that can refresh the session: a server component may read cookies but
 * not write them, so the access token is renewed here and handed to the current request as well as
 * to the browser. UI permission gating happens later (issue #25) and is only a convenience — the
 * Admin API re-checks every `x-permission` server-side.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isProduction, sessionSecret } from '@/lib/env';
import { refreshTokens } from '@/lib/auth/oidc';
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

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const secret = sessionSecret();
  const sealed = joinChunks((name) => request.cookies.get(name)?.value);
  if (sealed === null) {
    return toLogin(request);
  }

  const session = await openSession(sealed, secret);
  if (session === null) {
    return toLogin(request);
  }

  if (!isExpiring(session)) {
    return NextResponse.next();
  }

  let refreshedCookie: string;
  try {
    const refreshed = await refreshTokens(session.refreshToken);
    refreshedCookie = await sealSession(refreshed, secret);
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

  const response = NextResponse.next({ request });
  writeSessionCookies(response.cookies, refreshedCookie, isProduction);
  return response;
}

export const config = {
  // Everything except the auth endpoints themselves, the error page they redirect to, the
  // container's liveness probe, and assets. A probe that gets redirected to sign-in never
  // reports healthy, so the pod would never become ready.
  matcher: ['/((?!api/auth|auth/error|health|_next/static|_next/image|favicon.ico).*)'],
};
