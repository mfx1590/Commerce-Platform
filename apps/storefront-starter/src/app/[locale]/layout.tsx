import { ThemeProvider } from '@platform/ui';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { brandTokens } from '@/brand/tokens';
import { routing } from '@/i18n/routing';
import { assertStoreOffersLocale } from '@/lib/i18n';
import { getStoreOrNull } from '@/lib/store';
import './globals.css';

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

  const store = await getStoreOrNull();
  // A locale this build supports but the store does not offer is a 404, not a half-translated page.
  assertStoreOffersLocale(store, locale);

  return (
    <html lang={locale}>
      <ThemeProvider
        as="body"
        theme={store?.theme}
        tokens={brandTokens}
        className="min-h-screen bg-background text-foreground antialiased"
      >
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </ThemeProvider>
    </html>
  );
}
