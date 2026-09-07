import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import {
  buildAuthorizationUrl,
  createCodeVerifier,
  createState,
  oidcConfigFromEnv,
  safeReturnTo,
} from '@/lib/auth/oidc';

/**
 * Starts the sign-in. The PKCE verifier and the CSRF state are kept in short-lived httpOnly
 * cookies — never in the URL — and checked again in the callback.
 *
 * A customer whose access token merely expired lands here too: Keycloak's SSO session usually sends
 * them straight back without asking for a password.
 */
export const dynamic = 'force-dynamic';

/** The round trip through Keycloak should take seconds; ten minutes is generous. */
const TRANSIENT_MAX_AGE = 60 * 10;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = oidcConfigFromEnv();
  const codeVerifier = createCodeVerifier();
  const state = createState();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));

  const jar = await cookies();
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: TRANSIENT_MAX_AGE,
  } as const;

  jar.set('oidc_verifier', codeVerifier, options);
  jar.set('oidc_state', state, options);
  jar.set('oidc_return_to', returnTo, options);

  return NextResponse.redirect(buildAuthorizationUrl(config, { state, codeVerifier }));
}
