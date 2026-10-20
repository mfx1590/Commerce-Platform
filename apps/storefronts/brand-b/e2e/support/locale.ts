import { localeConfigFromEnv } from '../../src/i18n/locale-config.mjs';

/**
 * The locale the specs navigate in, and the locales the app routes — from the same definition the
 * app and `scripts/e2e-server.mjs` use (#441 part 4). A brand whose locale is not the starter's
 * (brand C: `en-US`) sets `SUPPORTED_LOCALES` where the Playwright process sees it — its own
 * `playwright.config.ts` — and every synced spec then runs in that brand's locale.
 */
export const { locales: LOCALES, defaultLocale: LOCALE } = localeConfigFromEnv(process.env);

/** A path under the default locale: `localePath('/products')` → `/en-GB/products`. */
export function localePath(path = ''): string {
  return `/${LOCALE}${path}`;
}

/** `s` with every regular-expression metacharacter escaped. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A URL matcher for a path under the default locale. `tail` is a regular-expression source:
 * `localeUrl('/cart$')`, `localeUrl('/orders/[^/]+$')`, `localeUrl('$')` for the locale home.
 */
export function localeUrl(tail = ''): RegExp {
  return new RegExp(`/${escapeRegExp(LOCALE)}${tail}`);
}
