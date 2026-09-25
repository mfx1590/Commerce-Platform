import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatMoney } from '@/lib/forms/money';
import { endCampaignAction, launchCampaignAction } from '../../_actions';
import { getCampaign } from '../../_api';
import { MarketingNav } from '../../section-nav';
import { CAMPAIGN_STATUS_TONE, ENDABLE, LAUNCHABLE } from '../campaigns-table.config';
import { CampaignControls } from './campaign-controls';

export const dynamic = 'force-dynamic';

function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().replace('T', ' ').slice(0, 16);
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ storeId: string; campaignId: string }>;
}) {
  const { storeId, campaignId } = await params;
  const result = await getCampaign(storeId, campaignId);

  if (!result.ok) {
    return (
      <StoreSectionGuard storeId={storeId} id="marketing">
        <div className="space-y-4">
          <MarketingNav storeId={storeId} active="campaigns" />
          <ApiStatePanel
            status={result.status}
            error={result.error}
            what="campaign"
            storeId={storeId}
            backHref={`/${storeId}/marketing/campaigns`}
            backLabel="Back to campaigns"
          />
        </div>
      </StoreSectionGuard>
    );
  }

  const campaign = result.data;

  // Bound on the server; the client component receives zero-argument callables (global gotcha: `.bind`, never
  // an arrow wrapper, for anything crossing the boundary).
  const launch = launchCampaignAction.bind(null, storeId, campaignId);
  const end = endCampaignAction.bind(null, storeId, campaignId);

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <div className="space-y-4">
        <MarketingNav storeId={storeId} active="campaigns" />
        <Card>
          <CardHeader
            title={campaign.name}
            description={`${campaign.type.replace('_', ' ')} campaign`}
            action={
              <div className="flex items-center gap-2">
                <Badge tone={CAMPAIGN_STATUS_TONE[campaign.status] ?? 'neutral'}>
                  {campaign.status}
                </Badge>
                <Link href={`/${storeId}/marketing/campaigns`}>
                  <span className="text-muted hover:text-ink text-sm">Back</span>
                </Link>
              </div>
            }
          />
          <CardBody className="space-y-4">
            <CampaignControls
              status={campaign.status}
              canLaunch={LAUNCHABLE.includes(campaign.status)}
              canEnd={ENDABLE.includes(campaign.status)}
              launch={launch}
              end={end}
            />

            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
              <div>
                <dt className="text-muted text-xs uppercase">Budget</dt>
                <dd className="font-mono tabular-nums">
                  {campaign.budget === null || campaign.budget === undefined
                    ? '—'
                    : formatMoney(campaign.budget.amount_minor, campaign.budget.currency)}
                </dd>
              </div>
              <div>
                <dt className="text-muted text-xs uppercase">Starts</dt>
                <dd className="font-mono">{formatDate(campaign.starts_at)}</dd>
              </div>
              <div>
                <dt className="text-muted text-xs uppercase">Ends</dt>
                <dd className="font-mono">{formatDate(campaign.ends_at)}</dd>
              </div>
              <div>
                <dt className="text-muted text-xs uppercase">Launched</dt>
                <dd className="font-mono">{formatDate(campaign.launched_at)}</dd>
              </div>
              <div>
                <dt className="text-muted text-xs uppercase">Ended</dt>
                <dd className="font-mono">{formatDate(campaign.ended_at)}</dd>
              </div>
              <div>
                <dt className="text-muted text-xs uppercase">External ref</dt>
                <dd className="font-mono text-xs">{campaign.external_ref ?? '—'}</dd>
              </div>
            </dl>

            <div className="border-line border-t pt-3">
              <h3 className="mb-2 text-sm font-medium">Attribution</h3>
              <p className="text-muted mb-2 text-xs">
                Orders are credited to this campaign by matching <code>utm_campaign</code>,
                case-insensitively, at report time — so a campaign without one is never credited
                with anything.
              </p>
              <dl className="grid grid-cols-3 gap-x-6 text-sm">
                <div>
                  <dt className="text-muted text-xs uppercase">utm_source</dt>
                  <dd className="font-mono text-xs">{campaign.utm_source ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted text-xs uppercase">utm_medium</dt>
                  <dd className="font-mono text-xs">{campaign.utm_medium ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-muted text-xs uppercase">utm_campaign</dt>
                  <dd className="font-mono text-xs">
                    {campaign.utm_campaign ?? <span className="text-warning">not linked</span>}
                  </dd>
                </div>
              </dl>
            </div>
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
