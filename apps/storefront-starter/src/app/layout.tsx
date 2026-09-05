import { ThemeProvider } from '@platform/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { brandTokens } from '@/brand/tokens';
import { getStoreOrNull } from '@/lib/store';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStoreOrNull();
  return {
    // The API returns `seo.canonical` as a path; Next resolves it against this into an absolute
    // URL, which is what crawlers require. Phase 2 sets SITE_URL per brand and environment.
    metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3100'),
    title: {
      default: store?.name ?? 'Storefront',
      template: `%s · ${store?.name ?? 'Storefront'}`,
    },
    description: `Shop at ${store?.name ?? 'our store'}.`,
  };
}

/**
 * The theme is resolved once, here: `store.theme` (per brand, from the API) layered under
 * `brandTokens` (this app's own overrides). `ThemeProvider` renders <body> itself, so its CSS
 * variables cover the whole document and are available during the very first paint.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const store = await getStoreOrNull();

  return (
    <html lang={store?.default_locale ?? 'en'}>
      <ThemeProvider
        as="body"
        theme={store?.theme}
        tokens={brandTokens}
        className="min-h-screen bg-background text-foreground antialiased"
      >
        {children}
      </ThemeProvider>
    </html>
  );
}
