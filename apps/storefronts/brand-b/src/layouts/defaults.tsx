import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getCurrency } from '@/lib/i18n';
import { getComponents, type LayoutSlots } from '@/lib/slots';
import type { Store } from '@/lib/store-api';

const NAV = [
  { href: '/products', key: 'shop' },
  { href: '/pages/about', key: 'about' },
] as const;

function Header({ store }: { store: Store | null }) {
  const { Logo, Announcement } = getComponents();
  const t = useTranslations('nav');

  return (
    <>
      <Announcement store={store} />
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-4">
          <Logo storeName={store?.name ?? 'Storefront'} />
          <nav aria-label={t('main')} className="flex items-center gap-6 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hover:underline">
                {t(item.key)}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/account" className="hover:underline">
              {t('account')}
            </Link>
            <Link href="/cart" className="hover:underline">
              {t('cart')}
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}

async function Footer({ store }: { store: Store | null }) {
  // The currency the customer actually chose, not the store default — otherwise the footer
  // contradicts the switcher and the cart for anyone who changed it.
  const [t, currency] = await Promise.all([getTranslations('nav'), getCurrency(store)]);

  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-8 text-sm text-muted-foreground">
        <p>
          {t('copyright', { year: new Date().getFullYear(), store: store?.name ?? 'Storefront' })}
        </p>
        <p>
          {t('shipsTo', {
            country: store?.default_country ?? '—',
            currency,
          })}
        </p>
      </div>
    </footer>
  );
}

export const defaultLayouts: LayoutSlots = { Header, Footer };
