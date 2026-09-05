import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Account' };

export default function AccountPage() {
  return <ComingSoon title="Account and order history" task="task 1.5 (issue #21)" />;
}
