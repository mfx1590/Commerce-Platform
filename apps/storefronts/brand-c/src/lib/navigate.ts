import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';

/**
 * Redirect inside the app, keeping the customer in the locale they are browsing.
 *
 * `redirect` from `next/navigation` takes a raw path, which would drop the prefix and land on a
 * route that does not exist — every page lives under `[locale]`. Only the route handlers
 * (`/health`, `/auth/*`) sit outside, and those use the plain redirect on purpose.
 */
export async function redirectLocalized(href: string): Promise<never> {
  return redirect({ href, locale: await getLocale() });
}
