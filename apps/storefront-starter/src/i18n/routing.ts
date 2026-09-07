import { defineRouting } from 'next-intl/routing';

/**
 * Locale routing.
 *
 * The locales a store *offers* come from `GET /store` (`store.locales`), but routing has to be
 * decided before any request is made — the middleware rewrites the URL long before a page fetches
 * anything. So the list is build-time configuration, and `assertStoreLocale` checks it against the
 * store at render: a locale the store does not offer is a 404, not a half-translated page.
 *
 * A brand app sets its own list; the defaults match the Brand A mock (`en-GB`, `de-DE`).
 */
function fromEnv(name: string, fallback: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback.split(',');
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

export const locales = fromEnv('SUPPORTED_LOCALES', 'en-GB,de-DE');
export const defaultLocale = process.env.DEFAULT_LOCALE ?? locales[0] ?? 'en-GB';

export const routing = defineRouting({
  locales,
  defaultLocale,
  // Every locale is prefixed, including the default: one canonical URL shape, no duplicate content
  // between `/products` and `/en-GB/products`, and `hreflang` alternates that all look the same.
  localePrefix: 'always',
  localeCookie: { name: 'locale', maxAge: 60 * 60 * 24 * 365 },
});

export function isSupportedLocale(value: string): boolean {
  return locales.includes(value);
}
