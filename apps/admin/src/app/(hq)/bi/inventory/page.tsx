import { HqSectionGuard } from '@/components/shell/section-guard';
import { loadPrincipal } from '@/lib/principal';
import { warehouseAccess } from '@/lib/warehouse';
import { InventoryView } from '../_v2/components/inventory';
import type { Raw } from '../_v2/model';

export const dynamic = 'force-dynamic';

/**
 * HQ · BI · Inventory health (#871, BI v2 wave 1). Every request happens inside the section guard: a
 * principal without `analyst` on hq gets the 403 panel and the metrics API is never called.
 */
export default async function HqInventoryPage({ searchParams }: { searchParams: Promise<Raw> }) {
  const raw = await searchParams;
  const principal = await loadPrincipal();
  const canOpenLedger = principal.ok && warehouseAccess(principal.data).canOperate;
  return (
    <HqSectionGuard id="bi">
      <InventoryView raw={raw} base="/bi" canOpenLedger={canOpenLedger} />
    </HqSectionGuard>
  );
}
