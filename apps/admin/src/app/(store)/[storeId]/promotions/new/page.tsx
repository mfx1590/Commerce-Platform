import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ForbiddenPanel, requiresRelation } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { createPromotionAction } from '@/app/actions/promotions';
import { getStore } from '@/lib/api/admin';
import { loadPrincipal } from '@/lib/principal';
import { EMPTY_PROMOTION } from '@/lib/promotions/form';
import { canManagePromotions } from '../page';
import { PromotionForm } from '../promotion-form';

export const dynamic = 'force-dynamic';

export default async function NewPromotionPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const [store, principal] = await Promise.all([getStore(storeId), loadPrincipal()]);
  const allowed = principal.ok && canManagePromotions(principal.data, storeId);

  return (
    <StoreSectionGuard storeId={storeId} id="promotions">
      {!allowed ? (
        <ForbiddenPanel error={requiresRelation('store_admin', `store:${storeId}`)} />
      ) : (
        <Card>
          <CardHeader
            title="New promotion"
            description="Code and type cannot be changed after creation."
          />
          <CardBody>
            <PromotionForm
              action={createPromotionAction.bind(null, storeId)}
              defaultValues={EMPTY_PROMOTION}
              mode="create"
              submitLabel="Create promotion"
              redirectBase={`/${storeId}/promotions`}
              storeCurrency={store.ok ? store.data.default_currency : 'EUR'}
            />
          </CardBody>
        </Card>
      )}
    </StoreSectionGuard>
  );
}
