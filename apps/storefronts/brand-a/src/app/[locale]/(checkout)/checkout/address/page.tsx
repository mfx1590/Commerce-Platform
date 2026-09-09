import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AddressForm } from '@/components/checkout-forms';
import { CheckoutSteps } from '@/components/checkout-steps';
import { requireCheckoutStep } from '@/lib/checkout-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('checkout.address'))('title') };
}
export const dynamic = 'force-dynamic';

export default async function AddressStepPage() {
  const { cart, country } = await requireCheckoutStep('address');
  const t = await getTranslations('checkout.address');

  return (
    <div className="flex flex-col gap-6">
      <CheckoutSteps cart={cart} current="address" />
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <AddressForm cart={cart} defaultCountry={country} />
    </div>
  );
}
