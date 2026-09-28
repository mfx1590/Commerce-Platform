import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale, isSupportedLocale } from '@/i18n/routing';
import { exchangeCode, oidcConfigFromEnv, safeReturnTo } from '@/lib/auth/oidc';
import { isSameOrigin } from '@/lib/safe-path';
import { saveSession, sessionFromTokens } from '@/lib/auth/session';

/**
 * Finishes the sign-in: checks the state, exchanges the code with the PKCE verifier, and stores the
 * session. Failures land on the account page with a flag rather than an error screen — the customer
 * can simply try again, and nothing about why is worth telling an attacker.
 */
export const dynamic = 'force-dynamic';

function clearTransient(jar: Awaited<ReturnType<typeof cookies>>): void {
  jar.delete('oidc_verifier');
  jar.delete('oidc_state');
  jar.delete('oidc_return_to');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const jar = await cookies();
  const origin = request.nextUrl.origin;

  // The account pages live under a locale prefix, so the fallback destination has to carry one.
  // next-intl writes the customer's choice to the `locale` cookie; fall back to the default.
  const cookieLocale = jar.get('locale')?.value;
  const locale =
    cookieLocale !== undefined && isSupportedLocale(cookieLocale) ? cookieLocale : defaultLocale;
  const failed = NextResponse.redirect(new URL(`/${locale}/account?error=sign_in_failed`, origin));

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const expectedState = jar.get('oidc_state')?.value;
  const codeVerifier = jar.get('oidc_verifier')?.value;
  const returnTo = safeReturnTo(jar.get('oidc_return_to')?.value, `/${locale}/account`);

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
  // Same second layer as the referral landing: a `returnTo` that resolves off this origin sends the
  // customer to the account page instead. This one matters more — they have just authenticated.
  const destination = new URL(returnTo, origin);
  return NextResponse.redirect(
    isSameOrigin(destination, origin) ? destination : new URL(`/${locale}/account`, origin),
  );
}
