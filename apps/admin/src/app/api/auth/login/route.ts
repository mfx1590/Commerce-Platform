/**
 * Starts the OIDC authorization-code + PKCE flow.
 *
 * The state and the code verifier are parked in short-lived httpOnly cookies. The verifier never
 * leaves the server, which is what makes the public `admin-app` client safe without a secret.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { OIDC_REDIRECT_PATH, env, isProduction, redirectUri } from '@/lib/env';
import { codeChallengeS256, createCodeVerifier, randomBase64Url } from '@/lib/auth/crypto';
import { authorizationUrl } from '@/lib/auth/oidc';
import {
  OIDC_RETURN_TO_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
  transientCookieAttributes,
} from '@/lib/auth/oidc-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const state = randomBase64Url(16);
  const verifier = createCodeVerifier();
  const challenge = await codeChallengeS256(verifier);

  // Only same-app paths may be returned to, so a crafted link cannot bounce a user off-site.
  const requested = request.nextUrl.searchParams.get('returnTo') ?? '/';
  const returnTo = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

  let target: string;
  try {
    target = await authorizationUrl({
      state,
      codeChallenge: challenge,
      redirectUri: redirectUri(),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Sign-in is unavailable';
    return NextResponse.redirect(
      new URL(`/auth/error?reason=${encodeURIComponent(message)}`, env.appUrl),
    );
  }

  const response = NextResponse.redirect(target);
  const attributes = transientCookieAttributes(isProduction);
  response.cookies.set(OIDC_STATE_COOKIE, state, attributes);
  response.cookies.set(OIDC_VERIFIER_COOKIE, verifier, attributes);
  response.cookies.set(OIDC_RETURN_TO_COOKIE, returnTo, attributes);
  // Referenced so the redirect path stays in step with the registered Keycloak redirect URI.
  response.headers.set('x-oidc-redirect-path', OIDC_REDIRECT_PATH);
  return response;
}
