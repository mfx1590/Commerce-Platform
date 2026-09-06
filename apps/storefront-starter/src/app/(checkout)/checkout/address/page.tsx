import type { Metadata } from 'next';
import { AddressForm } from '@/components/checkout-forms';
import { CheckoutSteps } from '@/components/checkout-steps';
import { requireCheckoutStep } from '@/lib/checkout-page';

export const metadata: Metadata = { title: 'Delivery address' };
export const dynamic = 'force-dynamic';

export default async function AddressStepPage() {
  const { cart, country } = await requireCheckoutStep('address');

  return (
    <div className="flex flex-col gap-6">
      <CheckoutSteps cart={cart} current="address" />
      <h1 className="text-2xl font-bold">Where should it go?</h1>
      <AddressForm cart={cart} defaultCountry={country} />
    </div>
  );
}
