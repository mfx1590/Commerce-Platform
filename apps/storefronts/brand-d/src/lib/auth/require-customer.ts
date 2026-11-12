import { getLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAccessToken } from './session';

/**
 * Guard for every page in `(account)`. An unauthenticated visitor is sent to sign-in carrying where
 * they were going, so they land back on the page they asked for rather than a generic account home.
 *
 * `returnTo` is sanitised again when it is read back (`safeReturnTo`), so this cannot become an
 * open redirect even if a caller passes something odd.
 */
export async function requireCustomerToken(returnTo: string): Promise<string> {
  const token = await getAccessToken();
  if (token === null) {
    // `/auth/*` is deliberately outside the locale tree (its callback URL is registered with
    // Keycloak), but the page to come back to is not — so returnTo carries the prefix.
    const locale = await getLocale();
    redirect(`/auth/sign-in?returnTo=${encodeURIComponent(`/${locale}${returnTo}`)}`);
  }
  return token;
}
