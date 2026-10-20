/**
 * Sign out (#353). In this order, so the app is signed out whatever happens on Keycloak's page:
 *
 * 1. End the realm's SSO session **server-side** (`endKeycloakSession`, the refresh token posted to
 *    the end-session endpoint). Before this, a user who abandoned Keycloak's "Do you want to log
 *    out?" page kept a live SSO session, and the next admin request signed them straight back in
 *    without a password.
 * 2. Drop the local session: both cookie chunks and the OIDC transient cookies, `Clear-Site-Data:
 *    "cookies"` for good measure, `no-store` so no cache keeps the redirect, and this process's
 *    liveness entry (`forgetSession`).
 * 3. Only then send the browser to Keycloak's end-session with `id_token_hint` and the registered
 *    `post_logout_redirect_uri`, which clears Keycloak's own browser cookies. Abandoning that page
 *    no longer matters: the session it would end is already gone.
 *
 * Keycloak unreachable: the local session is still dropped; the realm session may outlive it, and
 * the middleware's liveness check is what then keeps a copied cookie from being used.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { env, sessionSecret } from '@/lib/env';
import { endKeycloakSession, endSessionUrl, sessionIdOf } from '@/lib/auth/oidc';
import { forgetSession } from '@/lib/auth/liveness';
import { clearSessionCookies, joinChunks, openSession } from '@/lib/auth/session';
import { OIDC_TRANSIENT_COOKIES } from '@/lib/auth/oidc-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Registered as `http://localhost:3000/*` (and :3200) on the admin-app client: keep the slash. */
function postLogoutRedirectUri(): string {
  return `${env.appUrl}/`;
}

async function signOut(request: NextRequest): Promise<NextResponse> {
  const sealed = joinChunks((name) => request.cookies.get(name)?.value);
  let target = postLogoutRedirectUri();

  if (sealed !== null) {
    const session = await openSession(sealed, sessionSecret());
    if (session !== null) {
      await endKeycloakSession(session.refreshToken);
      forgetSession(sessionIdOf(session.idToken));
      try {
        target = await endSessionUrl(session.idToken, postLogoutRedirectUri());
      } catch {
        // Discovery failed: go home; the local session is dropped below either way.
      }
    }
  }

  // 303 so the browser follows with a GET whether Sign out was a form POST or a link.
  const response = NextResponse.redirect(target, 303);
  clearSessionCookies(response.cookies);
  for (const name of OIDC_TRANSIENT_COOKIES) {
    response.cookies.delete(name);
  }
  response.headers.set('Clear-Site-Data', '"cookies"');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}
