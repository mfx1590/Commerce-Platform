import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ShippingForm } from '@/components/checkout-forms';
import { CheckoutSteps } from '@/components/checkout-steps';
import { requireCheckoutStep } from '@/lib/checkout-page';
import { storeApi } from '@/lib/store-api';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('checkout.shipping'))('title') };
}
export const dynamic = 'force-dynamic';

export default async function ShippingStepPage() {
  const { cart, locale } = await requireCheckoutStep('shipping');
  const t = await getTranslations('checkout.shipping');
  // Options depend on the destination and the contents, so they are read per cart, never cached.
  const { items } = await storeApi().listShippingOptions(cart.id, { cache: 'no-store' });

  return (
    <div className="flex flex-col gap-6">
      <CheckoutSteps cart={cart} current="shipping" />
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <ShippingForm options={items} selectedId={cart.shipping_option?.id ?? null} locale={locale} />
    </div>
  );
}
