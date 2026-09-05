/**
 * Clears the local session and sends the browser to Keycloak's end-session endpoint so the realm
 * SSO session goes too — otherwise the next sign-in would silently log the same user back in.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { env, sessionSecret } from '@/lib/env';
import { endSessionUrl } from '@/lib/auth/oidc';
import { clearSessionCookies, joinChunks, openSession } from '@/lib/auth/session';
import { OIDC_TRANSIENT_COOKIES } from '@/lib/auth/oidc-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function signOut(request: NextRequest): Promise<NextResponse> {
  const sealed = joinChunks((name) => request.cookies.get(name)?.value);
  let target = env.appUrl;

  if (sealed !== null) {
    const session = await openSession(sealed, sessionSecret());
    if (session !== null) {
      try {
        target = await endSessionUrl(session.idToken, env.appUrl);
      } catch {
        // Keycloak unreachable: still drop the local session rather than leaving the user signed in.
      }
    }
  }

  const response = NextResponse.redirect(target);
  clearSessionCookies(response.cookies);
  for (const name of OIDC_TRANSIENT_COOKIES) {
    response.cookies.delete(name);
  }
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return signOut(request);
}
