import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Cart' };

export default function CartPage() {
  return <ComingSoon title="Cart" task="task 1.4 (issue #20)" />;
}
