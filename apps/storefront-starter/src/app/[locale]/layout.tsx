import { ThemeProvider } from '@platform/ui';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { brandTokens } from '@/brand/tokens';
import { routing } from '@/i18n/routing';
import { assertStoreOffersLocale } from '@/lib/i18n';
import { getStoreOrNull } from '@/lib/store';
import './globals.css';

/**
 * Namespaces the `'use client'` components need: `variant-picker` (pdp), `cart-line` (cart),
 * `checkout-forms` (checkout). Everything else renders on the server and never reaches the browser.
 * Keep this in step with the components — `test/i18n.test.ts` fails if a client component asks for a
 * namespace that is not listed here.
 */
const CLIENT_NAMESPACES = ['common', 'pdp', 'cart', 'checkout', 'totals'] as const;

function pickNamespaces(
  messages: Record<string, unknown>,
  namespaces: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    namespaces.filter((name) => name in messages).map((name) => [name, messages[name]]),
  );
}

/** The locale is in the path, so every route is generated per locale. */
export function generateStaticParams(): { locale: string }[] {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const store = await getStoreOrNull();
  const name = store?.name ?? 'Storefront';

  // `hreflang` alternates: one canonical URL per locale, so a search engine serves a German
  // customer the German page instead of guessing.
  const languages = Object.fromEntries(routing.locales.map((l) => [l, `/${l}`]));

  return {
    metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3100'),
    title: { default: name, template: `%s · ${name}` },
    description: `Shop at ${name}.`,
    alternates: { canonical: `/${locale}`, languages },
  };
}

/**
 * Root layout. It lives under `[locale]` because `<html lang>` has to be the locale being rendered,
 * and because every page in the app is locale-scoped — only the route handlers (`/health`, `/auth/*`)
 * sit outside.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Lets the static parts of the tree render without opting the whole route into dynamic rendering.
  setRequestLocale(locale);

  const [store, messages] = await Promise.all([getStoreOrNull(), getMessages()]);
  // A locale this build supports but the store does not offer is a 404, not a half-translated page.
  assertStoreOffersLocale(store, locale);

  // Only the namespaces the `'use client'` components actually ask for. Handing the provider the
  // whole catalogue serialises every string into the HTML and hydrates it on pages that use none of
  // it — measurable in total blocking time, which is what kept PLP and PDP under the 90 budget.
  const clientMessages = pickNamespaces(messages, CLIENT_NAMESPACES);

  return (
    <html lang={locale}>
      <ThemeProvider
        as="body"
        theme={store?.theme}
        tokens={brandTokens}
        className="min-h-screen bg-background text-foreground antialiased"
      >
        <NextIntlClientProvider messages={clientMessages}>{children}</NextIntlClientProvider>
      </ThemeProvider>
    </html>
  );
}
