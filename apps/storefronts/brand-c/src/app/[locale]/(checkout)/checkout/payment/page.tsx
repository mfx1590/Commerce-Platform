import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PaymentForm } from '@/components/checkout-forms';
import { CheckoutSteps } from '@/components/checkout-steps';
import { requireCheckoutStep } from '@/lib/checkout-page';
import { paymentOptions } from '@/lib/payment-options';
import { getStoreOrNull } from '@/lib/store';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('checkout.payment'))('title') };
}
export const dynamic = 'force-dynamic';

export default async function PaymentStepPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { cart } = await requireCheckoutStep('payment');
  const [t, store] = await Promise.all([getTranslations('checkout.payment'), getStoreOrNull()]);
  const options = paymentOptions(store);
  const provider = cart.payment_session?.provider ?? null;
  // `placeOrderAction` sends a declined payment back here with the contract's error code.
  const { error } = await searchParams;
  const failed = error === 'payment_failed' || cart.payment_session?.status === 'failed';

  return (
    <div className="flex flex-col gap-6">
      <CheckoutSteps cart={cart} current="payment" />
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <PaymentForm
        failed={failed}
        methods={{ card: options.stripePublishableKey !== null, invoice: options.invoice }}
        selected={provider}
      />
    </div>
  );
}
