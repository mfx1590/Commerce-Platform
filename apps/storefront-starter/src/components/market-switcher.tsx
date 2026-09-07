import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { getCurrency } from '@/lib/i18n';
import { setCurrencyAction } from '@/lib/i18n-actions';
import type { Store } from '@/lib/store-api';

/**
 * Language and currency, both server-rendered.
 *
 * Language is a set of links — one canonical URL per locale, crawlable, and it keeps working without
 * JavaScript. Currency is a GET form posting to a server action, because currency is a cookie rather
 * than part of the path: the same URL priced in EUR or GBP is the same page.
 *
 * The choices are intersected with what the store actually offers, so a build configured for a
 * locale or currency the store does not sell in never shows it.
 */
export async function MarketSwitcher({ store }: { store: Store | null }) {
  // The selected currency is the customer's cookie reconciled against the store — NOT
  // `store.default_currency`, which would snap the control back to the default on every render
  // while the cookie and the cart quietly stayed on the currency they actually chose.
  const [t, currentLocale, currentCurrency] = await Promise.all([
    getTranslations('common'),
    getLocale(),
    getCurrency(store),
  ]);

  const locales = routing.locales.filter((locale) =>
    store === null ? true : store.locales.includes(locale),
  );
  const currencies = store?.currencies ?? [];

  if (locales.length <= 1 && currencies.length <= 1) return null;

  return (
    <div className="flex flex-wrap items-center gap-4 text-sm">
      {locales.length > 1 ? (
        <nav aria-label={t('locale')} className="flex items-center gap-2">
          <span className="text-muted-foreground">{t('locale')}</span>
          {locales.map((locale) => (
            <Link
              key={locale}
              href="/"
              locale={locale}
              aria-current={locale === currentLocale ? 'true' : undefined}
              className={locale === currentLocale ? 'font-medium underline' : 'hover:underline'}
            >
              {locale}
            </Link>
          ))}
        </nav>
      ) : null}

      {currencies.length > 1 ? (
        <form action={setCurrencyAction} className="flex items-center gap-2">
          <label htmlFor="currency" className="text-muted-foreground">
            {t('currency')}
          </label>
          <select
            id="currency"
            name="currency"
            defaultValue={currentCurrency}
            className="h-8 rounded-md border border-input bg-background px-2"
          >
            {currencies.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
          <button type="submit" className="underline">
            {t('change')}
          </button>
        </form>
      ) : null}
    </div>
  );
}
