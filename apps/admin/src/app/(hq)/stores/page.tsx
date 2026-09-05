import { HqSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listStores } from '@/lib/api/admin';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { StoresTable } from './stores-table';

export const dynamic = 'force-dynamic';

/**
 * The store registry, and the first screen on the data-table primitive (issue #26). Issue #28 adds
 * create, detail/edit, domains, sales channels and API keys on top of this list.
 *
 * Table state is read from the URL and handed to the client component already parsed, so the first
 * paint matches the link that was opened.
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

  // `listStores` takes only page and limit in contracts-v0.1 — no q, no sort.
  const query = parseTableQuery(params);
  const result = await listStores(toContractQuery(query));

  return (
    <HqSectionGuard id="stores">
      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Stores"
            description="Every store in the organization. Create and edit arrive with issue #28."
          />
          <CardBody>
            <StoresTable
              rows={result.ok ? result.data.items : []}
              total={result.ok ? result.data.total : 0}
              query={query}
              error={result.ok ? undefined : { status: result.status, error: result.error }}
            />
          </CardBody>
        </Card>
      </div>
    </HqSectionGuard>
  );
}
