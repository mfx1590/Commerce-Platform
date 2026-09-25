import { StoreSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { listSegments } from '../_api';
import { MarketingNav } from '../section-nav';
import { SegmentsTable } from './segments-table';
import { SEGMENTS_TABLE_DEFAULTS, SEGMENT_FILTER_KEYS } from './segments-table.config';

export const dynamic = 'force-dynamic';

export default async function SegmentsPage({
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

  const query = parseTableQuery(search, SEGMENT_FILTER_KEYS, SEGMENTS_TABLE_DEFAULTS);
  const result = await listSegments(storeId, toContractQuery(query, { sortable: true }));

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <div className="space-y-4">
        <MarketingNav storeId={storeId} active="segments" />
        <Card>
          <CardHeader
            title="Segments"
            description="Who a campaign reaches. Members are refreshed on demand, not continuously."
          />
          <CardBody>
            <SegmentsTable
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
