// The review flag of an order (task 2.5, #128; mirror since core #236).
//
// SOURCE OF TRUTH = the order's PAYMENT row (`payment.metadata.fraud`) — the payments side's own aggregate and the
// thing a review actually holds: `capturePayment` refuses a payment in `review` or `confirmed_fraud`. The ORDER
// carries a MIRROR (`order.metadata.fraud`) written ONLY by the orders module's own functions (only that module
// may update the `"order"` row — its structural guard), which also emit the ONE `order.updated` of each change,
// with the reason code in `changed_fields` (`fraud.reason_code=<code>`; `order.updated` v1 has no reason field).
//
// Every flag change made by this module goes through the two writers below — the Radar `review.*` webhook
// handlers included — so a review opened AFTER placement gets its order mirror exactly like one decided at
// placement (that one is written by the checkout itself: payment row + mirror, core #236). This module never
// builds an `order.updated` and never touches the order row.
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import {
  flagOrderForReview as mirrorFlagOnOrder,
  resolveOrderReview as mirrorResolveOnOrder,
} from '../orders';
import type { FraudProviderName, FraudReasonCode } from './types';

export type OrderFraudStatus = 'review' | 'cleared' | 'confirmed_fraud';

export interface OrderFraudFlag {
  status: OrderFraudStatus;
  /** One of `FRAUD_REASON_CODES` for flags this module wrote; the checkout writes what the check decided. */
  reason_code: FraudReasonCode | string;
  provider: FraudProviderName | string;
  flagged_at: string;
  resolved_at?: string;
  /** How the review ended: `approved`, `refunded_as_fraud`, `disputed`, `manual` … (a code). */
  resolution?: string;
}

interface FlaggedPayment {
  id: string;
  fraud: OrderFraudFlag | null;
}

/** The order's payment (the first one: placement creates exactly one), locked when asked. */
async function paymentOfOrder(
  tx: Queryable,
  orderId: string,
  lock: boolean,
): Promise<FlaggedPayment | null> {
  const r = await tx.query<FlaggedPayment>(
    `SELECT id, metadata->'fraud' AS fraud FROM payment WHERE order_id = $1
     ORDER BY created_at, id LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [orderId],
  );
  return r.rows[0] ?? null;
}

/** The review flag of an order — read from the payment row, the source of truth. */
export async function readOrderFraud(
  tx: Queryable,
  orderId: string,
): Promise<OrderFraudFlag | null> {
  return (await paymentOfOrder(tx, orderId, false))?.fraud ?? null;
}

async function writePaymentFlag(
  tx: Queryable,
  paymentId: string,
  flag: OrderFraudFlag,
): Promise<void> {
  await tx.query(
    `UPDATE payment SET metadata = jsonb_set(metadata, '{fraud}', $2::jsonb), updated_at = now() WHERE id = $1`,
    [paymentId, JSON.stringify(flag)],
  );
}

/**
 * Holds the order for review: payment row first, then the order mirror (one `order.updated`, from the orders
 * module). Idempotent — and a review a human (or Radar) already RESOLVED is never re-opened by a later signal:
 * a `cleared` or `confirmed_fraud` flag is returned as it is, nothing is written, no event.
 */
export async function flagOrderForReview(
  tx: Queryable,
  orderId: string,
  input: { reasonCode: FraudReasonCode; provider: FraudProviderName; actor: Actor },
): Promise<OrderFraudFlag> {
  const payment = await paymentOfOrder(tx, orderId, true);
  if (!payment) throw notFound('payment for order', orderId);
  if (payment.fraud) return payment.fraud; // in review already, or resolved: never re-flag
  const flag: OrderFraudFlag = {
    status: 'review',
    reason_code: input.reasonCode,
    provider: input.provider,
    flagged_at: new Date().toISOString(),
  };
  await writePaymentFlag(tx, payment.id, flag);
  await mirrorFlagOnOrder(tx, orderId, {
    reasonCode: flag.reason_code,
    provider: flag.provider,
    flaggedAt: flag.flagged_at,
    actor: input.actor,
  });
  return flag;
}

/**
 * Ends a review: `cleared` (the payment may be captured) or `confirmed_fraud` (it stays uncapturable; cancel
 * the order). Idempotent on the target status; an order that was never flagged is left alone. The order mirror
 * follows; a payment flagged before the mirror existed (pre-#236 rows) gets its mirror first, then the
 * resolution, so the two never disagree.
 */
export async function resolveOrderReview(
  tx: Queryable,
  orderId: string,
  input: { status: Exclude<OrderFraudStatus, 'review'>; resolution: string; actor: Actor },
): Promise<OrderFraudFlag | null> {
  const payment = await paymentOfOrder(tx, orderId, true);
  if (!payment?.fraud) return null;
  if (payment.fraud.status === input.status) return payment.fraud;
  const resolution = input.resolution.replace(/[^a-z0-9_]/gi, '_').slice(0, 40);
  const flag: OrderFraudFlag = {
    ...payment.fraud,
    status: input.status,
    resolved_at: new Date().toISOString(),
    resolution,
  };
  await writePaymentFlag(tx, payment.id, flag);
  const mirror = { status: input.status, resolution, actor: input.actor };
  if ((await mirrorResolveOnOrder(tx, orderId, mirror)) === null) {
    await mirrorFlagOnOrder(tx, orderId, {
      reasonCode: payment.fraud.reason_code,
      provider: payment.fraud.provider,
      flaggedAt: payment.fraud.flagged_at,
      actor: input.actor,
    });
    await mirrorResolveOnOrder(tx, orderId, mirror);
  }
  return flag;
}
