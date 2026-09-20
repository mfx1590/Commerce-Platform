import { StoreSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { MarketingNav } from '../../section-nav';
import { CampaignForm } from './campaign-form';

export const dynamic = 'force-dynamic';

export default async function NewCampaignPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <div className="space-y-4">
        <MarketingNav storeId={storeId} active="campaigns" />
        <Card>
          <CardHeader
            title="New campaign"
            description="Creating a campaign needs store_admin. It starts as a draft."
          />
          <CardBody>
            <CampaignForm storeId={storeId} />
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
