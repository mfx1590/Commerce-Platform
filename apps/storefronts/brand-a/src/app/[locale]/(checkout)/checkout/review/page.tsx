import { Price } from '@platform/ui';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { PlaceOrderForm } from '@/components/checkout-forms';
import { CheckoutSteps } from '@/components/checkout-steps';
import { AddressCard, TotalsTable } from '@/components/order-summary';
import { requireCheckoutStep } from '@/lib/checkout-page';
import { stepPath } from '@/lib/checkout';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('checkout.review'))('title') };
}
export const dynamic = 'force-dynamic';

export default async function ReviewStepPage() {
  const { cart, locale } = await requireCheckoutStep('review');
  const [t, tCommon] = await Promise.all([
    getTranslations('checkout.review'),
    getTranslations('common'),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <CheckoutSteps cart={cart} current="review" />
      <h1 className="text-2xl font-bold">{t('title')}</h1>

      <ul className="flex flex-col divide-y divide-border">
        {cart.items.map((item) => (
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
        {cart.shipping_address === null ? null : (
          <AddressCard title={t('deliveryAddress')} address={cart.shipping_address} />
        )}
        <div className="flex flex-col gap-1 text-sm">
          <h3 className="font-medium">{t('deliveryAndPayment')}</h3>
          <p className="text-muted-foreground">
            {cart.shipping_option?.name ?? '—'} · {cart.shipping_option?.carrier ?? '—'}
          </p>
          <p className="text-muted-foreground">
            {cart.payment_session?.provider ?? '—'} ({cart.payment_session?.status ?? '—'})
          </p>
          <p className="text-muted-foreground">{cart.email}</p>
          <Link href={stepPath('address')} className="mt-1 w-fit underline">
            {tCommon('change')}
          </Link>
        </div>
      </div>

      <div className="sm:ml-auto sm:w-80">
        <TotalsTable totals={cart.totals} locale={locale} />
      </div>

      <PlaceOrderForm />
    </div>
  );
}
