import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel, ForbiddenPanel, requiresRelation } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { createPromotionAction } from '@/app/actions/promotions';
import { getStore } from '@/lib/api/admin';
import { loadPrincipal } from '@/lib/principal';
import { EMPTY_PROMOTION } from '@/lib/promotions/form';
import { canManagePromotions } from '../page';
import { PromotionForm } from '../promotion-form';

export const dynamic = 'force-dynamic';

// No currency fallback (#810): amounts are parsed with the store's currency digits, so a guessed
// one turns ¥500 into ¥50,000. Without the store there is no money input at all.
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
      ) : !store.ok ? (
        <ApiStatePanel
          status={store.status}
          error={store.error}
          what="This store"
          storeId={storeId}
          backHref={`/${storeId}/promotions`}
          backLabel="All promotions"
        />
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
              storeCurrency={store.data.default_currency}
            />
          </CardBody>
        </Card>
      )}
    </StoreSectionGuard>
  );
}
