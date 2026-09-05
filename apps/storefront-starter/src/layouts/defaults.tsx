import Link from 'next/link';
import { getComponents, type LayoutSlots } from '@/lib/slots';
import type { Store } from '@/lib/store-api';

const NAV = [
  { href: '/products', label: 'Shop' },
  { href: '/pages/about', label: 'About' },
] as const;

function Header({ store }: { store: Store | null }) {
  const { Logo, Announcement } = getComponents();
  return (
    <>
      <Announcement store={store} />
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-4">
          <Logo storeName={store?.name ?? 'Storefront'} />
          <nav aria-label="Main" className="flex items-center gap-6 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hover:underline">
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/account" className="hover:underline">
              Account
            </Link>
            <Link href="/cart" className="hover:underline">
              Cart
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}

function Footer({ store }: { store: Store | null }) {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-8 text-sm text-muted-foreground">
        <p>
          © {new Date().getFullYear()} {store?.name ?? 'Storefront'}
        </p>
        <p>
          Ships to {store?.default_country ?? '—'} · Prices in {store?.default_currency ?? '—'}
        </p>
      </div>
    </footer>
  );
}

export const defaultLayouts: LayoutSlots = { Header, Footer };
