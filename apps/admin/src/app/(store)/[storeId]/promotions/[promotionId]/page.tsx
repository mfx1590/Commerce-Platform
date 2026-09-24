import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { updatePromotionAction } from '@/app/actions/promotions';
import { getPromotion, getStore } from '@/lib/api/admin';
import { loadPrincipal } from '@/lib/principal';
import { describeValue, fromPromotion, readPromotion } from '@/lib/promotions/form';
import { canManagePromotions } from '../page';
import { PromotionForm } from '../promotion-form';
import { promotionTone } from '../promotions-table.config';

export const dynamic = 'force-dynamic';

export default async function PromotionDetailPage({
  params,
}: {
  params: Promise<{ storeId: string; promotionId: string }>;
}) {
  const { storeId, promotionId } = await params;
  const [promotion, store, principal] = await Promise.all([
    getPromotion(storeId, promotionId),
    getStore(storeId),
    loadPrincipal(),
  ]);

  if (!promotion.ok) {
    return (
      <StoreSectionGuard storeId={storeId} id="promotions">
        <ApiStatePanel
          status={promotion.status}
          error={promotion.error}
          what="This promotion"
          storeId={storeId}
          backHref={`/${storeId}/promotions`}
          backLabel="All promotions"
        />
      </StoreSectionGuard>
    );
  }

  const current = promotion.data;
  const read = readPromotion(current);
  const locale = store.ok ? store.data.default_locale : 'en-GB';
  const manage = principal.ok && canManagePromotions(principal.data, storeId);

  return (
    <StoreSectionGuard storeId={storeId} id="promotions">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{current.name}</h1>
          <Badge tone={promotionTone(read.status)}>{read.status}</Badge>
          <span className="text-muted text-sm">
            {describeValue(current, locale)} · used {current.usage_count}
            {read.usage_limit === null ? '' : ` of ${read.usage_limit}`}
          </span>
          <Link
            href={`/${storeId}/promotions`}
            className="text-accent ml-auto text-sm hover:underline"
          >
            All promotions
          </Link>
        </div>

        <Card>
          <CardHeader
            title={manage ? 'Edit' : 'Details'}
            description={
              manage
                ? 'Code and type are immutable; everything else is a partial update.'
                : 'Editing needs store_admin on this store.'
            }
          />
          <CardBody>
            {manage ? (
              <PromotionForm
                action={updatePromotionAction.bind(null, storeId, promotionId)}
                defaultValues={fromPromotion(current)}
                mode="edit"
                submitLabel="Save changes"
                storeCurrency={store.ok ? store.data.default_currency : 'EUR'}
              />
            ) : (
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted text-xs uppercase">Code</dt>
                  <dd className="font-mono">{current.code ?? 'automatic'}</dd>
                </div>
                <div>
                  <dt className="text-muted text-xs uppercase">Type</dt>
                  <dd>{current.type.replaceAll('_', ' ')}</dd>
                </div>
                <div>
                  <dt className="text-muted text-xs uppercase">Schedule</dt>
                  <dd className="font-mono text-xs">
                    {read.starts_at ?? '—'} → {read.ends_at ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted text-xs uppercase">Combines</dt>
                  <dd>{read.exclusive ? 'exclusive' : read.stackable ? 'stackable' : 'neither'}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted text-xs uppercase">Rules</dt>
                  <dd>
                    <code className="text-xs">{JSON.stringify(current.rules ?? {})}</code>
                  </dd>
                </div>
              </dl>
            )}
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
