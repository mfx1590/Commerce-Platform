import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { defaultLocale } from '@/i18n/routing';
import type { Store } from './store-api';

/**
 * Where the build's locale/currency configuration meets what the store actually offers.
 *
 * Routing is decided before any API call, so the supported locales are build-time config
 * (`src/i18n/routing.ts`). The store is the authority on what it *sells* in, and these functions
 * reconcile the two at render time.
 */

const CURRENCY_COOKIE = 'currency';

/** A locale this build supports but the store does not offer is a 404, not a half-translated page. */
export function assertStoreOffersLocale(store: Store | null, locale: string): void {
  // With the API down the page already degrades; do not add a 404 on top of an outage.
  if (store === null) return;
  if (!store.locales.includes(locale)) notFound();
}

/**
 * The currency to price in: the customer's choice when the store still sells in it, otherwise the
 * store's default. A cookie can hold anything, so it is never trusted as a currency by itself —
 * an unknown value would reach `POST /store/carts` and be rejected.
 */
export function resolveCurrency(store: Store | null, requested: string | undefined): string {
  if (store === null) return requested ?? 'EUR';
  if (requested !== undefined && store.currencies.includes(requested)) return requested;
  return store.default_currency;
}

export async function readCurrencyCookie(): Promise<string | undefined> {
  return (await cookies()).get(CURRENCY_COOKIE)?.value;
}

/** Server actions and route handlers only — writes a cookie. */
export async function writeCurrencyCookie(currency: string): Promise<void> {
  (await cookies()).set(CURRENCY_COOKIE, currency, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** The currency for this request, reconciled against the store. */
export async function getCurrency(store: Store | null): Promise<string> {
  return resolveCurrency(store, await readCurrencyCookie());
}

/** The locale for links and formatting when a store is unavailable. */
export function fallbackLocale(store: Store | null): string {
  return store?.default_locale ?? defaultLocale;
}
