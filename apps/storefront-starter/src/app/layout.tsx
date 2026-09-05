import { ThemeProvider } from '@platform/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { brandTokens } from '@/brand/tokens';
import { getStoreOrNull } from '@/lib/store';
import './globals.css';

/**
 * Phase 1: every route renders per request. The layout itself calls `GET /store`, so prerendering
 * would bake one snapshot of the store (and require the mock during `next build`). Task 1.3
 * introduces per-route caching with fetch tags where it actually pays off (PLP and PDP).
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStoreOrNull();
  return {
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
