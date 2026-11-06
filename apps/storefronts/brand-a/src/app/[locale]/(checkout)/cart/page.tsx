import { buttonVariants } from '@platform/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CartLine, EmptyCart } from '@/components/cart-line';
import { TotalsTable } from '@/components/order-summary';
import { RecommendationRail } from '@/components/recommendation-rail';
import { analyticsConsentMode } from '@/lib/analytics/recommendation-events';
import { getCart } from '@/lib/cart';
import { EMPTY_RECOMMENDATIONS, loadRecommendations } from '@/lib/recommendations';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('cart'))('title') };
}

/** The cart is per-customer state read from a cookie: never cached, never prerendered. */
export const dynamic = 'force-dynamic';

export default async function CartPage() {
  // The rail's anchors are the cart's own lines, so its request starts the moment the cart arrives
  // and runs alongside the rest of the page's reads; it never throws and gives up at its deadline,
  // so a slow or failed call renders no rail instead of holding the cart back (#609).
  const cartRead = getCart();
  const recommendationsRead = cartRead.then(
    (value) =>
      value === null || value.items.length === 0
        ? EMPTY_RECOMMENDATIONS
        : loadRecommendations(
            { surface: 'cart', variantIds: value.items.map((item) => item.variant_id) },
            { currency: value.totals.total.currency },
          ),
    () => EMPTY_RECOMMENDATIONS,
  );
  const [cart, t, tCommon, recommendations] = await Promise.all([
    cartRead,
    getTranslations('cart'),
    getTranslations('common'),
    recommendationsRead,
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

      <RecommendationRail
        surface="cart"
        recommendations={recommendations}
        locale={locale}
        tracking={analyticsConsentMode() === 'analytics'}
      />
    </div>
  );
}
