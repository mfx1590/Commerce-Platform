import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ProductsView } from '@/app/(hq)/bi/_v2/components/products';
import type { Raw } from '@/app/(hq)/bi/_v2/model';

export const dynamic = 'force-dynamic';

/**
 * Store · BI · Products & categories (#871, BI v2 wave 1): the same view narrowed to this store. The section
 * guard refuses a principal without `viewer` on the store before any API call; the metrics API
 * scopes every statement on top (a store outside the scope is a 403, never empty rows).
 */
export default async function StoreProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Raw>;
}) {
  const [{ storeId }, raw] = await Promise.all([params, searchParams]);
  return (
    <StoreSectionGuard storeId={storeId} id="bi">
      <ProductsView raw={raw} base={`/${storeId}/bi`} storeId={storeId} />
    </StoreSectionGuard>
  );
}
