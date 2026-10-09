import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { catalogueFor } from './catalogue';
import { routing } from './routing';

/**
 * Loads the message catalogue for the request. An unknown locale falls back to the default rather
 * than throwing: the middleware should never let one through. The locale's own catalogue is
 * required (`catalogue.ts` fails loudly without it); the CMS one below is optional.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: {
      // Required, and a missing one fails naming the file and the variable (#441 part 5).
      ...(await catalogueFor(locale)),
      // Window 6 owns the `content` namespace — CMS pages, legal pages, campaign landings —
      // and ships it inside its own path (REQUEST #178), so it can add strings in every CMS task
      // without a request to this window for each one. `messages/*.json` keep their namespaces.
      content: await contentMessages(locale),
    },
  };
});

/**
 * The CMS catalogue is optional. It lives in window 6's folder and is absent until that window
 * ships it, and next-intl's own behaviour for a missing message is to log and render the key —
 * so failing the whole request here would turn "window 6 has not shipped its strings yet" into a
 * broken storefront rather than an untranslated `(content)` route.
 */
async function contentMessages(locale: string): Promise<Record<string, unknown>> {
  try {
    return (await import(`../lib/cms/messages/${locale}.json`)).default;
  } catch {
    return {};
  }
}
