import { StoreSectionGuard } from '@/components/shell/section-guard';
import { EmptyPanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listCustomers } from '@/lib/api/admin';
import { forCustomerRows } from '@/lib/customers/projection';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { CustomersTable } from './customers-table';
import { CUSTOMERS_TABLE_DEFAULTS, CUSTOMER_FILTER_KEYS } from './customers-table.config';

export const dynamic = 'force-dynamic';

/**
 * The customers list, behind the `support` gate (`StoreSectionGuard` renders the 403 panel for
 * anyone else — an analyst typing the URL gets the panel naming the relation, not the data).
 * `group_id` is honoured from the URL for links; there is no picker until a customer-groups
 * operation exists (CONTRACT CHANGE filed with 2.3).
 */
export default async function CustomersPage({
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

  const query = parseTableQuery(search, CUSTOMER_FILTER_KEYS, CUSTOMERS_TABLE_DEFAULTS);
  const result = await listCustomers(storeId, toContractQuery(query, { sortable: true }));

  return (
    <StoreSectionGuard storeId={storeId} id="customers">
      <Card>
        <CardHeader
          title="Customers"
          description="Personal data — visible because your relation is support or above. Nothing here is logged."
        />
        <CardBody className="space-y-3">
          <CustomersTable
            storeId={storeId}
            rows={result.ok ? forCustomerRows(result.data.items) : []}
            total={result.ok ? result.data.total : 0}
            query={query}
            emptyState={
              <EmptyPanel
                title="No customers yet"
                description="Customers appear here when they check out or register on the storefront."
              />
            }
            error={result.ok ? undefined : { status: result.status, error: result.error }}
          />
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
