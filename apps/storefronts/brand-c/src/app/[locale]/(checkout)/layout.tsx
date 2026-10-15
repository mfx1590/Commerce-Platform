import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import type { ReactNode } from 'react';
import { getComponents } from '@/lib/slots';
import { getStoreOrNull } from '@/lib/store';

/**
 * Checkout chrome is deliberately not the shop header: no navigation, no search, nothing that
 * invites the customer to leave the funnel. Only the logo links back out.
 */
export default async function CheckoutLayout({ children }: { children: ReactNode }) {
  const [store, t] = await Promise.all([getStoreOrNull(), getTranslations('common')]);
  const { Logo } = getComponents();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <Logo storeName={store?.name ?? 'Storefront'} />
          <Link href="/products" className="text-sm text-muted-foreground hover:underline">
            {t('continueShopping')}
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
    </div>
  );
}
