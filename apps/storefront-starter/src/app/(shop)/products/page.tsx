import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Products' };

export default function ProductListPage() {
  return <ComingSoon title="Product listing" task="task 1.3 (issue #19)" />;
}
