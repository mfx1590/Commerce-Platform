import { describe, expect, it } from 'vitest';
import { localeConfigFromEnv } from '@/i18n/locale-config.mjs';
import { defaultLocale, locales } from '@/i18n/routing';
import { LOCALE, LOCALES, localePath, localeUrl } from '../e2e/support/locale';

/**
 * #441 part 4: the locale list and the default locale have ONE definition, read from
 * `SUPPORTED_LOCALES` / `DEFAULT_LOCALE`, shared by the app's routing, `scripts/e2e-server.mjs` and
 * the e2e specs — so a brand whose locale is not the starter's (brand C, `en-US`) is warmed and
 * navigated in its own locale.
 */
describe('localeConfigFromEnv', () => {
  it('defaults to the starter’s two locales, en-GB first', () => {
    expect(localeConfigFromEnv({})).toEqual({
      locales: ['en-GB', 'de-DE'],
      defaultLocale: 'en-GB',
    });
    expect(localeConfigFromEnv({ SUPPORTED_LOCALES: '  ' }).locales).toEqual(['en-GB', 'de-DE']);
  });

  it('takes a brand’s list, its first locale as the default unless DEFAULT_LOCALE says', () => {
    expect(localeConfigFromEnv({ SUPPORTED_LOCALES: 'en-US' })).toEqual({
      locales: ['en-US'],
      defaultLocale: 'en-US',
    });
    expect(
      localeConfigFromEnv({ SUPPORTED_LOCALES: 'fr-FR, en-GB', DEFAULT_LOCALE: 'en-GB' }),
    ).toEqual({ locales: ['fr-FR', 'en-GB'], defaultLocale: 'en-GB' });
  });

  it('is exactly what the app’s routing uses', () => {
    expect({ locales, defaultLocale }).toEqual(localeConfigFromEnv(process.env));
  });
});

describe('the e2e locale helper', () => {
  it('navigates and matches under the app’s default locale', () => {
    expect({ LOCALES, LOCALE }).toEqual({ LOCALES: locales, LOCALE: defaultLocale });
    expect(localePath('/products')).toBe(`/${defaultLocale}/products`);
    expect(localeUrl('/cart$').test(`http://127.0.0.1:3100/${defaultLocale}/cart`)).toBe(true);
    expect(localeUrl('/cart$').test('http://127.0.0.1:3100/xx-XX/cart')).toBe(false);
    expect(localeUrl('$').test(`http://127.0.0.1:3100/${defaultLocale}`)).toBe(true);
  });
});
