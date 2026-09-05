import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Checkout' };

/**
 * Rendered per request: this page has no cacheable data of its own, but the layout above it calls
 * `GET /store` for the header. Prerendering it would bake one snapshot of the store into the build
 * — and CI builds with no API reachable at all. The catalog routes cache at the fetch layer instead.
 */
export const dynamic = 'force-dynamic';

export default function CheckoutPage() {
  return <ComingSoon title="Checkout" task="task 1.4 (issue #20)" />;
}
