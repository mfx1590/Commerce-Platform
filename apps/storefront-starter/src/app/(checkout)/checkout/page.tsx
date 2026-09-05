import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Checkout' };

export default function CheckoutPage() {
  return <ComingSoon title="Checkout" task="task 1.4 (issue #20)" />;
}
