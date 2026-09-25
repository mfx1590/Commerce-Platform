import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import {
  ApiStatePanel,
  EmptyPanel,
  ForbiddenPanel,
  requiresRelation,
} from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listPickLists, listWarehouses } from '@/lib/api/admin';
import { orderPermissions } from '@/lib/orders/permissions';
import { loadPrincipal } from '@/lib/principal';
import { PickListsPanel } from './pick-lists-panel';

export const dynamic = 'force-dynamic';

/**
 * Shipments waiting to be picked or packed, grouped by warehouse. `listPickLists` needs
 * `operations` on `organization:hq`, so the page checks that first and names the relation when it
 * is missing — the Orders section itself only needs `viewer`.
 */
export default async function PickListsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId } = await params;
  const raw = await searchParams;
  const principal = await loadPrincipal();
  const allowed = principal.ok && orderPermissions(principal.data, storeId).canFulfil;

  if (!allowed) {
    return (
      <StoreSectionGuard storeId={storeId} id="orders">
        <ForbiddenPanel
          error={requiresRelation('operations', 'organization:hq')}
          hint="Pick lists are a warehouse view; the orders themselves are under Orders."
        />
      </StoreSectionGuard>
    );
  }

  const query: Record<string, string> = {};
  for (const key of ['warehouse_id', 'status', 'page', 'limit'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value !== '') query[key] = value;
  }
  const [lists, warehouses] = await Promise.all([listPickLists(storeId, query), listWarehouses()]);

  return (
    <StoreSectionGuard storeId={storeId} id="orders">
      <Card>
        <CardHeader
          title="Pick lists"
          description="Shipments waiting to be picked or packed, by warehouse."
          action={
            <Link href={`/${storeId}/orders`} className="text-accent text-sm hover:underline">
              All orders
            </Link>
          }
        />
        <CardBody>
          {!lists.ok ? (
            <ApiStatePanel
              status={lists.status}
              error={lists.error}
              what="Pick lists"
              storeId={storeId}
            />
          ) : lists.data.items.length === 0 ? (
            <EmptyPanel
              title="Nothing to pick"
              description="Every planned shipment has been packed, or none has been planned yet."
            />
          ) : (
            <PickListsPanel
              storeId={storeId}
              groups={lists.data.items}
              warehouses={warehouses.ok ? warehouses.data.items : []}
              filters={{ warehouse_id: query['warehouse_id'] ?? '', status: query['status'] ?? '' }}
            />
          )}
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
