import { HqSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { listLegalEntities } from '@/lib/api/admin';
import { OnboardingWizard } from './onboarding-wizard';

export const dynamic = 'force-dynamic';

/**
 * HQ · Onboarding (#428 B, owner on organization:hq): the wizard that takes a new brand from legal
 * entity to a draft store with its domain, channel and publishable key in one `onboardStore`
 * transaction; the readiness panel (`/onboarding/{storeId}`) activates it.
 */
export default async function OnboardingPage() {
  // `finance` on hq (owner implies it); a failure leaves only the inline legal entity.
  const entities = await listLegalEntities();
  const options = entities.ok
    ? entities.data.items.map((entity) => ({
        id: entity.id,
        label: `${entity.name} (${entity.code}, ${entity.country})`,
      }))
    : [];

  return (
    <HqSectionGuard id="onboarding">
      <Card>
        <CardHeader
          title="Onboard a brand"
          description="Legal entity, store, primary domain — one transaction. The store starts as a draft."
        />
        <CardBody>
          <OnboardingWizard legalEntities={options} />
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
