import { RequestErrorPanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import type { ActivityData } from '@/lib/audit/load';
import { ActivityRows } from './activity-panel';

/**
 * "Payment activity" on an order (#870 wave 1 item 3).
 *
 * **The order itself has no audit rows.** Nothing in the core calls `writeAudit` with
 * `entity_type: 'order'` — not placement, not the status machine, not cancel, not the line-item
 * edits. The only audited facts about an order are its payments (`payment.capture`,
 * `payment.capture_failed`, written with "ids and amounts only — no PII"), so that is what this
 * panel shows and that is what it is called. A panel labelled "History" querying
 * `entity_type=order` would be permanently empty, which is worse than absent: an owner reads an
 * empty history as "nobody changed it".
 *
 * The missing rows are a core change, filed as a REQUEST. When they land, this page gets the
 * ordinary `ActivityPanel` beside this one and nothing here has to move.
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
        description="Who captured or tried to capture money on this order, and when. Changes to the order itself are not recorded in the audit log yet."
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
