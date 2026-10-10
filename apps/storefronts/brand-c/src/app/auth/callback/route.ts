import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale, isSupportedLocale } from '@/i18n/routing';
import { exchangeCode, oidcConfigFromEnv, safeReturnTo } from '@/lib/auth/oidc';
import { saveSession, sessionFromTokens } from '@/lib/auth/session';
import { urlOnThisSite } from '@/lib/site-origin';

/**
 * Finishes the sign-in: checks the state, exchanges the code with the PKCE verifier, and stores the
 * session. Failures land on the account page with a flag rather than an error screen — the customer
 * can simply try again, and nothing about why is worth telling an attacker.
 *
 * Every redirect from here goes to **this site's configured origin** (`urlOnThisSite`), never to
 * the request's own (#298): behind the ingress that is the pod's address, and this handler sent
 * freshly authenticated customers to `https://localhost:3100/…`. If a production server has not
 * been told its origin the handler throws before it touches the session — no half sign-in.
 */
export const dynamic = 'force-dynamic';

function clearTransient(jar: Awaited<ReturnType<typeof cookies>>): void {
  jar.delete('oidc_verifier');
  jar.delete('oidc_state');
  jar.delete('oidc_return_to');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const jar = await cookies();

  // The account pages live under a locale prefix, so the fallback destination has to carry one.
  // next-intl writes the customer's choice to the `locale` cookie; fall back to the default.
  const cookieLocale = jar.get('locale')?.value;
  const locale =
    cookieLocale !== undefined && isSupportedLocale(cookieLocale) ? cookieLocale : defaultLocale;
  const accountPath = `/${locale}/account`;
  // Resolved first, and on purpose: this is where a missing `SITE_URL` fails, before any cookie
  // is read, cleared or written.
  const failed = NextResponse.redirect(
    urlOnThisSite(`${accountPath}?error=sign_in_failed`, accountPath),
  );

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const expectedState = jar.get('oidc_state')?.value;
  const codeVerifier = jar.get('oidc_verifier')?.value;
  const returnTo = safeReturnTo(jar.get('oidc_return_to')?.value, accountPath);

  // Keycloak reports a refusal (`error=access_denied`) with no code; treat it like any other failure.
  if (code === null || state === null || codeVerifier === undefined) {
    clearTransient(jar);
    return failed;
  }
  // Constant-time comparison is unnecessary here: the state is single-use and already known to the
  // browser. What matters is that a state we did not issue is refused.
  if (expectedState === undefined || state !== expectedState) {
    clearTransient(jar);
    return failed;
  }

  try {
    const tokens = await exchangeCode(oidcConfigFromEnv(), { code, codeVerifier });
    await saveSession(sessionFromTokens(tokens));
  } catch {
    clearTransient(jar);
    return failed;
  }

  clearTransient(jar);
  // Same two layers as the referral landing, in `urlOnThisSite`: a `returnTo` that is not a path of
  // ours, or that resolves off this origin, sends the customer to the account page instead. This
  // one matters more — they have just authenticated.
  return NextResponse.redirect(urlOnThisSite(returnTo, accountPath));
}
