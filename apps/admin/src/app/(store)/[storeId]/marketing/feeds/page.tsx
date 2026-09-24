import { StoreSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { listFeeds } from '../_api';
import { MarketingNav } from '../section-nav';
import { FeedsTable } from './feeds-table';
import { FEEDS_TABLE_DEFAULTS, FEED_FILTER_KEYS } from './feeds-table.config';

export const dynamic = 'force-dynamic';

export default async function FeedsPage({
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

  const query = parseTableQuery(search, FEED_FILTER_KEYS, FEEDS_TABLE_DEFAULTS);
  const result = await listFeeds(storeId, toContractQuery(query));

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <div className="space-y-4">
        <MarketingNav storeId={storeId} active="feeds" />
        <Card>
          <CardHeader
            title="Product feeds"
            description="What Google Merchant and Meta fetch. Publishing regenerates the file; the channel picks it up on its own schedule."
          />
          <CardBody>
            <FeedsTable
              storeId={storeId}
              rows={result.ok ? result.data.items : []}
              total={result.ok ? result.data.total : 0}
              query={query}
              error={result.ok ? undefined : { status: result.status, error: result.error }}
            />
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
