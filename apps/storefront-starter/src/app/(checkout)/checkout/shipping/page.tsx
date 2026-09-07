import type { Metadata } from 'next';
import { ShippingForm } from '@/components/checkout-forms';
import { CheckoutSteps } from '@/components/checkout-steps';
import { requireCheckoutStep } from '@/lib/checkout-page';
import { storeApi } from '@/lib/store-api';

export const metadata: Metadata = { title: 'Delivery' };
export const dynamic = 'force-dynamic';

export default async function ShippingStepPage() {
  const { cart, locale } = await requireCheckoutStep('shipping');
  // Options depend on the destination and the contents, so they are read per cart, never cached.
  const { items } = await storeApi().listShippingOptions(cart.id, { cache: 'no-store' });

  return (
    <div className="flex flex-col gap-6">
      <CheckoutSteps cart={cart} current="shipping" />
      <h1 className="text-2xl font-bold">How should it get there?</h1>
      <ShippingForm options={items} selectedId={cart.shipping_option?.id ?? null} locale={locale} />
    </div>
  );
}
