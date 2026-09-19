// Stripe Radar review webhooks (task 2.5, #128), registered with the payments module's receiver
// (`registerWebhookHandler`) so they run under its rules: signature, redacted extract, exactly-once, replay,
// state guards. Radar can open a review AFTER placement (a rule matched at confirmation or later):
//
//   - `review.opened`  → the order is flagged for review (`radar_review_opened`) — capture is refused meanwhile;
//   - `review.closed`  → `approved` clears the flag; anything else (`refunded`, `refunded_as_fraud`, `disputed`,
//                         `redacted`) marks it `confirmed_fraud` — it stays uncapturable; a human cancels/refunds.
//
// Both resolve the order from the review's PaymentIntent through the `payment` row (RLS-scoped). Idempotent: the
// flag functions are no-ops on the target state, so a duplicate, a replay or a late `opened` after `closed`
// changes nothing (a closed review is never re-opened by a late event).
import type { ProcessResult, WebhookHandler } from '../payments';
import { flagOrderForReview, readOrderFraud, resolveOrderReview } from './order-flag';

const skipped = (reason: string, aggregate: ProcessResult['aggregate'] = null): ProcessResult => ({
  status: 'skipped',
  reason,
  aggregate,
  followUps: [],
});

async function orderOfIntent(
  tx: Parameters<WebhookHandler>[0]['tx'],
  intentId: string,
): Promise<{ payment_id: string; order_id: string } | null> {
  const r = await tx.query<{ payment_id: string; order_id: string }>(
    `SELECT id AS payment_id, order_id FROM payment
     WHERE provider = 'stripe' AND provider_payment_id = $1 FOR UPDATE`,
    [intentId],
  );
  return r.rows[0] ?? null;
}

export const reviewOpenedHandler: WebhookHandler = async ({ tx, extract, actor }) => {
  const intentId = extract.object.payment_intent;
  if (extract.object.object !== 'review' || !intentId)
    return skipped('review without a payment intent');
  const found = await orderOfIntent(tx, intentId);
  if (!found) return skipped(`no payment row for ${intentId}`);
  const aggregate = { type: 'payment' as const, id: found.payment_id };
  const existing = await readOrderFraud(tx, found.order_id);
  if (existing?.status === 'review') return skipped('already under review', aggregate);
  if (existing) {
    return skipped(
      `review already resolved (${existing.status}); a late opened event does not reopen it`,
      aggregate,
    );
  }
  await flagOrderForReview(tx, found.order_id, {
    reasonCode: 'radar_review_opened',
    provider: 'radar',
    actor,
  });
  return { status: 'processed', reason: null, aggregate, followUps: [] };
};

export const reviewClosedHandler: WebhookHandler = async ({ tx, extract, actor }) => {
  const intentId = extract.object.payment_intent;
  if (extract.object.object !== 'review' || !intentId)
    return skipped('review without a payment intent');
  const found = await orderOfIntent(tx, intentId);
  if (!found) return skipped(`no payment row for ${intentId}`);
  const aggregate = { type: 'payment' as const, id: found.payment_id };
  const closedReason = extract.object.closed_reason ?? 'unknown';
  const target = closedReason === 'approved' ? 'cleared' : 'confirmed_fraud';
  let existing = await readOrderFraud(tx, found.order_id);
  if (!existing) {
    // `closed` delivered before `opened` (out of order): record the review first so the resolution has a flag.
    existing = await flagOrderForReview(tx, found.order_id, {
      reasonCode: 'radar_review_opened',
      provider: 'radar',
      actor,
    });
  }
  if (existing.status === target) return skipped(`already ${target}`, aggregate);
  await resolveOrderReview(tx, found.order_id, { status: target, resolution: closedReason, actor });
  return { status: 'processed', reason: null, aggregate, followUps: [] };
};

export const RADAR_WEBHOOK_HANDLERS: Readonly<Record<string, WebhookHandler>> = {
  'review.opened': reviewOpenedHandler,
  'review.closed': reviewClosedHandler,
};
