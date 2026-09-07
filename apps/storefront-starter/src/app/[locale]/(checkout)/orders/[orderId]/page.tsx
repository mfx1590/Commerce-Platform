import { Badge, Price, buttonVariants } from '@platform/ui';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { Link } from '@/i18n/navigation';
import { notFound } from 'next/navigation';
import { AddressCard, TotalsTable } from '@/components/order-summary';
import { isNotFound, storeApi } from '@/lib/store-api';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('checkout.confirmation'))('title') };
}
export const dynamic = 'force-dynamic';

type Params = Promise<{ orderId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Order confirmation. `GET /store/orders/{id}` needs the email the order was placed with — it is
 * what authorises a guest to see it. `placeOrderAction` puts that email in a short-lived httpOnly
 * cookie, so the address never appears in a URL that could be shared or logged; a returning
 * customer can still pass `?email=` from the link in their confirmation mail.
 */
export default async function OrderConfirmationPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { orderId } = await params;
  const { email: emailParam } = await searchParams;
  const cookieEmail = (await cookies()).get('order_email')?.value;
  const email = typeof emailParam === 'string' ? emailParam : cookieEmail;
  const t = await getTranslations('checkout.confirmation');

  if (email === undefined) {
    return (
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-2xl font-bold">{t('unavailable')}</h1>
        <p className="text-muted-foreground">{t('unavailableBody')}</p>
        <Link href="/account" className={buttonVariants({ variant: 'outline' })}>
          {t('goToAccount')}
        </Link>
      </div>
    );
  }

  const [tCommon, order] = await Promise.all([
    getTranslations('common'),
    storeApi()
      .getOrder(orderId, { email }, { cache: 'no-store' })
      .catch((error: unknown) => {
        if (isNotFound(error)) notFound();
        throw error;
      }),
  ]);
  const locale = await getLocale();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-2">
        <Badge variant="success">{t('badge')}</Badge>
        <h1 className="text-3xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">
          {t('body', { order: order.display_id, email: order.email })}
        </p>
      </header>

      <ul className="flex flex-col divide-y divide-border">
        {order.items.map((item) => (
          <li key={item.id} className="flex justify-between gap-4 py-3">
            <span>
              <span className="font-medium">{item.title}</span>{' '}
              <span className="text-muted-foreground">
                {item.variant_title} × {item.quantity}
              </span>
            </span>
            <Price value={item.total} locale={locale} />
          </li>
        ))}
      </ul>

      <div className="grid gap-6 sm:grid-cols-2">
        <AddressCard title={t('deliveryAddress')} address={order.shipping_address} />
        <div className="flex flex-col gap-1 text-sm">
          <h3 className="font-medium">{t('delivery')}</h3>
          <p className="text-muted-foreground">
            {order.shipping_method.name} · {order.shipping_method.carrier}
          </p>
        </div>
      </div>

      <div className="sm:ml-auto sm:w-80">
        <TotalsTable totals={order.totals} locale={locale} />
      </div>

      <Link href="/products" className={buttonVariants({ variant: 'outline' })}>
        {tCommon('continueShopping')}
      </Link>
    </div>
  );
}
