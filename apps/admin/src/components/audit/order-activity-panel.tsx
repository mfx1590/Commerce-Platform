import { RequestErrorPanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import type { ActivityData } from '@/lib/audit/projection';
import { ActivityRows } from './activity-panel';

/**
 * "Payment activity" on an order (#870 wave 1 item 3).
 *
 * This panel shows the order's **payments'** audit rows — `payment.capture`,
 * `payment.capture_failed`, written with "ids and amounts only — no PII". The order's own rows
 * arrived with #920, the REQUEST this screen filed (#887), and are rendered by the ordinary
 * `ActivityPanel` beside this one. Nothing here had to move, which is what naming the panel after
 * what it could actually show bought.
 *
 * It stays separate rather than merged: a merge would have to invent an ordering across two paged
 * queries, and "who took the money" and "who changed the order" are the two questions people
 * arrive with anyway.
 */
export function OrderActivityPanel({
  activity,
  hasPayments,
}: {
  activity: ActivityData;
  hasPayments: boolean;
}) {
  return (
    <Card>
      <CardHeader
        title="Payment activity"
        description="Who captured or tried to capture money on this order, and when. Changes to the order itself are in Activity, above."
      />
      <CardBody>
        {!hasPayments ? (
          <p className="text-muted text-sm">
            No payment on this order yet, so there is nothing audited to show.
          </p>
        ) : activity.error !== undefined ? (
          <RequestErrorPanel status={activity.error.status} error={activity.error.error} />
        ) : activity.rows.length === 0 ? (
          <p className="text-muted text-sm">
            Nothing recorded against this order&rsquo;s payment yet. A capture or a failed capture
            appears here with the person who ran it.
          </p>
        ) : (
          <ActivityRows rows={activity.rows} caption="Payment activity on this order" />
        )}
      </CardBody>
    </Card>
  );
}
