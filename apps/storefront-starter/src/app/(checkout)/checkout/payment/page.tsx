import type { Metadata } from 'next';
import { PaymentForm } from '@/components/checkout-forms';
import { CheckoutSteps } from '@/components/checkout-steps';
import { requireCheckoutStep } from '@/lib/checkout-page';

export const metadata: Metadata = { title: 'Payment' };
export const dynamic = 'force-dynamic';

export default async function PaymentStepPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { cart } = await requireCheckoutStep('payment');
  // `placeOrderAction` sends a declined payment back here with the contract's error code.
  const { error } = await searchParams;
  const failed = error === 'payment_failed' || cart.payment_session?.status === 'failed';

  return (
    <div className="flex flex-col gap-6">
      <CheckoutSteps cart={cart} current="payment" />
      <h1 className="text-2xl font-bold">How would you like to pay?</h1>
      <PaymentForm failed={failed} />
    </div>
  );
}
