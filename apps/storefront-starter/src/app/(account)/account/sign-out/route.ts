import { NextResponse, type NextRequest } from 'next/server';
import { endSessionEndpoint, oidcConfigFromEnv } from '@/lib/auth/oidc';
import { clearSession, getSession } from '@/lib/auth/session';

/**
 * Sign-out. POST only: a GET would let any image tag or prefetch sign the customer out.
 *
 * The local cookie is dropped first, then Keycloak is asked to end its own SSO session — otherwise
 * the next sign-in would silently reuse it and look like the sign-out never happened.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = oidcConfigFromEnv();
  const session = await getSession();
  await clearSession();

  const logout = new URL(endSessionEndpoint(config));
  logout.searchParams.set('client_id', config.clientId);
  logout.searchParams.set(
    'post_logout_redirect_uri',
    new URL('/', request.nextUrl.origin).toString(),
  );
  // Without `id_token_hint` Keycloak asks the customer to confirm the logout; with it the round
  // trip is silent. It is why the session keeps the id token at all.
  if (session?.idToken !== undefined) logout.searchParams.set('id_token_hint', session.idToken);

  // 303, not the default 307: this handler answers a POST, and 307 preserves the method — the
  // browser would POST to Keycloak's logout endpoint, which does not end the SSO session that way.
  // The customer would then be signed straight back in on their next visit to /account.
  return NextResponse.redirect(logout, 303);
}
