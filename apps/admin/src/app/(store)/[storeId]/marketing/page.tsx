import { StoreSectionGuard } from '@/components/shell/section-guard';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

/**
 * Reserved for window 17 from Phase 2 (`docs/ownership.md`). Deliberately self-contained: one file,
 * no components of its own that anything else could come to depend on, and **no API calls** — there
 * is no marketing contract until contracts-v0.3.
 *
 * It exists now so the navigation gate is decided and tested once, rather than being retrofitted
 * around a half-built section later.
 */
const SECTIONS = [
  ['Overview', 'Revenue by channel and campaign, top promotions, abandoned-cart recovery rate'],
  ['Campaigns', 'Email, SMS and push, per campaign'],
  ['Segments', 'Rule builder with a live count'],
  ['Feeds', 'Status, item count, errors, publish'],
  ['Referrals', 'Programme and payouts for this store'],
  ['Reviews', 'Moderation queue'],
  ['Consent', 'Opt-in rates by channel'],
] as const;

export default async function StoreMarketingPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <Card>
        <CardHeader
          title="Marketing"
          description="Marketing for this store. Reserved now, built in Phase 2."
          action={<Badge tone="accent">reserved</Badge>}
        />
        <CardBody className="space-y-4">
          <p className="text-muted text-sm">
            You can reach this section, so your relations allow it. Window 17 builds what goes here
            from Phase 2; the scope is written up in <code>docs/marketing-scope.md</code>.
          </p>
          <ul className="divide-line divide-y text-sm">
            {SECTIONS.map(([name, description]) => (
              <li key={name} className="py-2">
                <p className="font-medium">{name}</p>
                <p className="text-muted text-xs">{description}</p>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
