import { HqSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { createStoreAction } from '@/app/actions/stores';
import { listLegalEntities } from '@/lib/api/admin';
import { StoreForm } from '../store-form';

export const dynamic = 'force-dynamic';

/** Brand onboarding step 1 (`createStore`, `x-permission: owner on organization:hq`). */
export default async function NewStorePage() {
  // Needs `finance` on organization:hq; a failure here is not fatal, the form falls back to an id.
  const entities = await listLegalEntities();

  return (
    <HqSectionGuard id="onboarding">
      <Card>
        <CardHeader
          title="New store"
          description="Creating a store is the first step of brand onboarding."
        />
        <CardBody>
          <StoreForm
            action={createStoreAction}
            legalEntities={entities.ok ? entities.data.items : []}
            submitLabel="Create store"
            redirectBase="/stores"
            defaultValues={{
              legal_entity_id: '',
              code: '',
              name: '',
              status: 'draft',
              default_currency: 'EUR',
              default_locale: 'en-GB',
              default_country: 'NL',
              timezone: 'Europe/Amsterdam',
            }}
          />
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
