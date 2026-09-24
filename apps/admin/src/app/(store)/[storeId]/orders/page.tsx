import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { EmptyPanel } from '@/components/states/state-panel';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getStore, listOrders } from '@/lib/api/admin';
import { orderPermissions } from '@/lib/orders/permissions';
import { loadPrincipal } from '@/lib/principal';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { OrderFilters } from './order-filters';
import { OrdersTable } from './orders-table';
import { ORDERS_TABLE_DEFAULTS, ORDER_FILTER_KEYS } from './orders-table.config';

export const dynamic = 'force-dynamic';

/**
 * The orders list: `listOrders` with the contract's filters and sort, money in the store's locale.
 * The store is read in parallel and fails alone — a 403 on `getStore` costs the locale (en-GB is
 * used), never the list.
 */
export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId } = await params;
  const raw = await searchParams;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') search.set(key, value);
  }

  const query = parseTableQuery(search, ORDER_FILTER_KEYS, ORDERS_TABLE_DEFAULTS);
  const [result, store, principal] = await Promise.all([
    listOrders(storeId, toContractQuery(query, { sortable: true })),
    getStore(storeId),
    loadPrincipal(),
  ]);
  const locale = store.ok ? store.data.default_locale : 'en-GB';
  const canFulfil = principal.ok && orderPermissions(principal.data, storeId).canFulfil;

  return (
    <StoreSectionGuard storeId={storeId} id="orders">
      <Card>
        <CardHeader
          title="Orders"
          description="Placed, paid and fulfilled, in one list. Every action is re-checked against your permissions on the server."
          {...(canFulfil
            ? {
                action: (
                  <Link href={`/${storeId}/orders/pick-lists`}>
                    <Button size="sm" variant="secondary">
                      Pick lists
                    </Button>
                  </Link>
                ),
              }
            : {})}
        />
        <CardBody className="space-y-3">
          <OrderFilters query={query} />
          <OrdersTable
            storeId={storeId}
            locale={locale}
            rows={result.ok ? result.data.items : []}
            total={result.ok ? result.data.total : 0}
            query={query}
            emptyState={
              <EmptyPanel
                title="No orders yet"
                description="Orders appear here the moment a checkout completes on the storefront."
              />
            }
            error={result.ok ? undefined : { status: result.status, error: result.error }}
          />
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
