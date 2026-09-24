import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getMe } from '@/lib/api/admin';
import { previewSegmentAction, updateSegmentAction } from '../../_actions';
import { getSegment } from '../../_api';
import { MarketingNav } from '../../section-nav';
import { toDraft, type SegmentRules } from '../_rules';
import { RuleBuilder } from '../rule-builder';

export const dynamic = 'force-dynamic';

/**
 * One segment: its rules, a live count, and the refresh.
 *
 * Editing needs `store_admin` and the server enforces it; the relations from `GET /admin/me` only decide
 * whether the Save button is offered. A principal who edits anyway gets the refusal panel, which is more
 * useful than a silently missing button.
 */
export default async function SegmentDetailPage({
  params,
}: {
  params: Promise<{ storeId: string; segmentId: string }>;
}) {
  const { storeId, segmentId } = await params;
  const [result, me] = await Promise.all([getSegment(storeId, segmentId), getMe()]);

  if (!result.ok) {
    return (
      <StoreSectionGuard storeId={storeId} id="marketing">
        <div className="space-y-4">
          <MarketingNav storeId={storeId} active="segments" />
          <ApiStatePanel
            status={result.status}
            error={result.error}
            what="segment"
            storeId={storeId}
            backHref={`/${storeId}/marketing/segments`}
            backLabel="Back to segments"
          />
        </div>
      </StoreSectionGuard>
    );
  }

  const segment = result.data;
  const relations = me.ok
    ? (me.data.stores.find((store) => store.store_id === storeId)?.relations ?? [])
    : [];
  const canWrite = relations.includes('store_admin') || relations.includes('owner');

  // Bound on the server — an arrow wrapper does not cross the boundary (global gotcha).
  const preview = previewSegmentAction.bind(null, storeId, segmentId) as (
    rules: SegmentRules,
  ) => ReturnType<typeof previewSegmentAction>;
  const save = canWrite
    ? ((async (rules: SegmentRules) =>
        updateSegmentAction(storeId, segmentId, {
          name: segment.name,
          description: segment.description ?? null,
          rules,
        })) as (rules: SegmentRules) => ReturnType<typeof updateSegmentAction>)
    : undefined;

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <div className="space-y-4">
        <MarketingNav storeId={storeId} active="segments" />
        <Card>
          <CardHeader
            title={segment.name}
            description={segment.description ?? 'No description.'}
            action={
              <span className="text-muted text-xs">
                <span className="font-mono tabular-nums">{segment.materialised_count}</span> members
                {segment.last_materialised_at === null
                  ? ' · never refreshed'
                  : ` · refreshed ${segment.last_materialised_at.slice(0, 10)}`}
              </span>
            }
          />
          <CardBody>
            <RuleBuilder
              initial={toDraft(segment.rules)}
              canEdit={canWrite}
              preview={preview}
              {...(save === undefined ? {} : { save })}
            />
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
