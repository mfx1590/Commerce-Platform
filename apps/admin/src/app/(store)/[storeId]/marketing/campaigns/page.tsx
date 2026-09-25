import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { parseTableQuery, toContractQuery } from '@/lib/table/query-state';
import { listCampaigns } from '../_api';
import { MarketingNav } from '../section-nav';
import { CampaignsTable } from './campaigns-table';
import { CAMPAIGNS_TABLE_DEFAULTS, CAMPAIGN_FILTER_KEYS } from './campaigns-table.config';

export const dynamic = 'force-dynamic';

/** The campaign list: `listCampaigns` with the contract's own filters and sort. */
export default async function CampaignsPage({
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

  const query = parseTableQuery(search, CAMPAIGN_FILTER_KEYS, CAMPAIGNS_TABLE_DEFAULTS);
  const result = await listCampaigns(storeId, toContractQuery(query, { sortable: true }));

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <div className="space-y-4">
        <MarketingNav storeId={storeId} active="campaigns" />
        <Card>
          <CardHeader
            title="Campaigns"
            description="Reading needs store_staff; creating, launching and ending need store_admin."
            action={
              <Link href={`/${storeId}/marketing/campaigns/new`}>
                <Button size="sm">New campaign</Button>
              </Link>
            }
          />
          <CardBody>
            <CampaignsTable
              storeId={storeId}
              rows={result.ok ? result.data.items : []}
              total={result.ok ? result.data.total : 0}
              query={query}
              emptyAction={
                <Link href={`/${storeId}/marketing/campaigns/new`}>
                  <Button>Create the first campaign</Button>
                </Link>
              }
              error={result.ok ? undefined : { status: result.status, error: result.error }}
            />
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
