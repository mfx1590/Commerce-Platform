import { buttonVariants } from '@platform/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CartLine, EmptyCart } from '@/components/cart-line';
import { TotalsTable } from '@/components/order-summary';
import { getCart } from '@/lib/cart';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('cart'))('title') };
}

/** The cart is per-customer state read from a cookie: never cached, never prerendered. */
export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const [cart, t, tCommon] = await Promise.all([
    getCart(),
    getTranslations('cart'),
    getTranslations('common'),
  ]);
  const locale = await getLocale();

  if (cart === null || cart.items.length === 0) {
    return (
      <>
        <h1 className="text-3xl font-bold">{t('title')}</h1>
        <EmptyCart />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl font-bold">{t('title')}</h1>

      <ul className="flex flex-col">
        {cart.items.map((item) => (
          <CartLine key={item.id} item={item} locale={locale} />
        ))}
      </ul>

      <div className="flex flex-col gap-6 sm:ml-auto sm:w-80">
        <TotalsTable totals={cart.totals} locale={locale} />
        <Link href="/checkout" className={buttonVariants({ size: 'lg' })}>
          {t('checkout')}
        </Link>
        <Link href="/products" className="text-center text-sm underline">
          {tCommon('continueShopping')}
        </Link>
      </div>
    </div>
  );
}
