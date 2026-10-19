import { NextResponse } from 'next/server';
import { SiteUrlError } from '@/brand/config';
import { endSessionEndpoint, oidcProviderFromEnv } from '@/lib/auth/oidc';
import { clearSession, getSession } from '@/lib/auth/session';
import { urlOnThisSite } from '@/lib/site-origin';

/**
 * Sign-out. POST only: a GET would let any image tag or prefetch sign the customer out.
 *
 * The local cookie is dropped first, then Keycloak is asked to end its own SSO session — otherwise
 * the next sign-in would silently reuse it and look like the sign-out never happened.
 *
 * Where Keycloak sends the customer afterwards is **this site's configured origin**, not the
 * request's (#298). The handler takes no request at all: there is nothing in one that it should
 * trust for this, and behind the ingress the request's own origin is the pod's
 * (`http://localhost:3100`), which Keycloak either refuses or — worse — honours.
 */
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const session = await getSession();
  // The local session goes first, whatever else is misconfigured: an unset client id (#441) fails
  // the Keycloak half loudly below, but must never leave the customer signed in here.
  await clearSession();
  const provider = oidcProviderFromEnv();

  const logout = new URL(endSessionEndpoint(provider));
  logout.searchParams.set('client_id', provider.clientId);

  // The one thing that needs the site's origin. If a production server has not been told it, the
  // sign-out still happens — the cookie is gone and Keycloak still ends the SSO session — but
  // without a return address: Keycloak shows its own signed-out page. That is the closed failure;
  // guessing an origin, or not signing the customer out, would be the open ones.
  try {
    logout.searchParams.set('post_logout_redirect_uri', urlOnThisSite('/', '/').toString());
  } catch (error) {
    if (!(error instanceof SiteUrlError)) throw error;
    console.error(`[storefront] sign-out without a return address: ${error.message}`);
  }

  // Without `id_token_hint` Keycloak asks the customer to confirm the logout; with it the round
  // trip is silent. It is why the session keeps the id token at all.
  if (session?.idToken !== undefined) logout.searchParams.set('id_token_hint', session.idToken);

  // 303, not the default 307: this handler answers a POST, and 307 preserves the method — the
  // browser would POST to Keycloak's logout endpoint, which does not end the SSO session that way.
  // The customer would then be signed straight back in on their next visit to /account.
  return NextResponse.redirect(logout, 303);
}
