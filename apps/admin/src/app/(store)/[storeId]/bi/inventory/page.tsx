import { StoreSectionGuard } from '@/components/shell/section-guard';
import { InventoryView } from '@/app/(hq)/bi/_v2/components/inventory';
import type { Raw } from '@/app/(hq)/bi/_v2/model';
import { loadPrincipal } from '@/lib/principal';
import { warehouseAccess } from '@/lib/warehouse';

export const dynamic = 'force-dynamic';

/**
 * Store · BI · Inventory health (#871, BI v2 wave 1): the same view narrowed to this store. The section
 * guard refuses a principal without `viewer` on the store before any API call; the metrics API
 * scopes every statement on top (a store outside the scope is a 403, never empty rows).
 */
export default async function StoreInventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Raw>;
}) {
  const [{ storeId }, raw] = await Promise.all([params, searchParams]);
  const principal = await loadPrincipal();
  const canOpenLedger = principal.ok && warehouseAccess(principal.data).canOperate;
  return (
    <StoreSectionGuard storeId={storeId} id="bi">
      <InventoryView
        raw={raw}
        base={`/${storeId}/bi`}
        storeId={storeId}
        canOpenLedger={canOpenLedger}
      />
    </StoreSectionGuard>
  );
}
