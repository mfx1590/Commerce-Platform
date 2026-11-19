import { HqSectionGuard } from '@/components/shell/section-guard';
import { ProductsView } from '../_v2/components/products';
import type { Raw } from '../_v2/model';

export const dynamic = 'force-dynamic';

/**
 * HQ · BI · Products & categories (#871, BI v2 wave 1). Every request happens inside the section guard: a
 * principal without `analyst` on hq gets the 403 panel and the metrics API is never called.
 */
export default async function HqProductsPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const raw = await searchParams;
  return (
    <HqSectionGuard id="bi">
      <ProductsView raw={raw} base="/bi" />
    </HqSectionGuard>
  );
}
