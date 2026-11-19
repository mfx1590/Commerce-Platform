import { StoreSectionGuard } from '@/components/shell/section-guard';
import { EmptyPanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { SelectFilter } from '@/components/table/url-filters';
import { listCustomerGroups, listCustomers } from '@/lib/api/admin';
import { forCustomerRows } from '@/lib/customers/projection';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { CustomersTable } from './customers-table';
import { CUSTOMERS_TABLE_DEFAULTS, CUSTOMER_FILTER_KEYS } from './customers-table.config';

export const dynamic = 'force-dynamic';

/**
 * The customers list, behind the `support` gate (`StoreSectionGuard` renders the 403 panel for
 * anyone else — an analyst typing the URL gets the panel naming the relation, not the data).
 *
 * **The group picker** (#870 wave 1 item 4) keeps the promise this docstring used to make: the
 * operation it waited for, `listCustomerGroups`, arrived in Admin API 0.4.7. `group_id` was always
 * honoured from the URL; now it is choosable, and the Group column shows the group's **name**
 * instead of eight characters of a uuid. The groups read is `viewer` while the list itself is
 * `support`, so it cannot widen anything; if it fails the table still works and the picker says so
 * rather than disappearing.
 *
 * **No CSV here, deliberately.** A customer-list export is a bulk extraction of email addresses,
 * phone numbers and addresses, which needs its own decision (store_admin, audited, with a stated
 * reason) rather than a button someone adds while building a filter.
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
  const [result, groups] = await Promise.all([
    listCustomers(storeId, toContractQuery(query, { sortable: true })),
    listCustomerGroups(storeId),
  ]);

  const groupOptions = groups.ok
    ? groups.data.items.map((group) => ({ value: group.id, label: group.name }))
    : [];
  // Names for the Group column, so a row reads "Wholesale" rather than eight hex characters.
  const groupNames = Object.fromEntries(groupOptions.map((group) => [group.value, group.label]));

  return (
    <StoreSectionGuard storeId={storeId} id="customers">
      <Card>
        <CardHeader
          title="Customers"
          description="Personal data — visible because your relation is support or above. Nothing here is logged."
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <SelectFilter
              query={query}
              defaults={CUSTOMERS_TABLE_DEFAULTS}
              filterKey="group_id"
              label="Group"
              anyLabel="Any group"
              options={groupOptions}
            />
            {!groups.ok && (
              <p role="note" className="text-muted text-xs">
                The group list could not be read ({groups.status}), so the picker is empty. A
                `group_id` already in the address still filters.
              </p>
            )}
          </div>
          <CustomersTable
            storeId={storeId}
            groupNames={groupNames}
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
