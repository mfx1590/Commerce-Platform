import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listStores } from '@/lib/api/admin';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { StoresTable } from './stores-table';
import { STORES_TABLE_DEFAULTS } from './stores-table.config';

export const dynamic = 'force-dynamic';

/**
 * The store registry. Table state is read from the URL and handed to the client component already
 * parsed, so the first paint matches the link that was opened.
 */
export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params.set(key, value);
  }

  // `listStores` (Admin API 0.2.0) takes page, limit, sort and order — no filters.
  // `created_at` desc is the contract's own default, so it is omitted from the URL.
  const query = parseTableQuery(params, [], STORES_TABLE_DEFAULTS);
  const result = await listStores(toContractQuery(query, { sortable: true }));

  return (
    <HqSectionGuard id="stores">
      <Card>
        <CardHeader
          title="Stores"
          description="Every store in the organization."
          action={
            <Link href="/stores/new">
              <Button size="sm">New store</Button>
            </Link>
          }
        />
        <CardBody>
          <StoresTable
            rows={result.ok ? result.data.items : []}
            total={result.ok ? result.data.total : 0}
            query={query}
            emptyAction={
              <Link href="/stores/new">
                <Button>Create the first store</Button>
              </Link>
            }
            error={result.ok ? undefined : { status: result.status, error: result.error }}
          />
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
