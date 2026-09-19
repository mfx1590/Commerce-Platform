// The review flag of an order (task 2.5, #128): `payment.metadata.fraud` + one `order.updated`, same transaction.
//
// WHERE THE FLAG LIVES. Only the orders module may update the `"order"` row (window 1's structural guard in
// test/guards.test.ts) and it has no function for flagging an order yet (REQUEST #231). So this module does NOT
// touch the order row: the flag is written on the order's PAYMENT row — the payments side's own aggregate, the
// thing a fraud review actually holds — and the order-level signal is the `order.updated` event, emitted through
// the orders module's public `transition()`, never hand-built. When #231 lands, `order.metadata.fraud` becomes a
// mirror written by the orders module's function and the two writers here call it as well.
//
// What "held" means: the order stays `pending` (nothing here confirms it), and the payments module refuses to
// CAPTURE a payment whose `metadata.fraud.status` is `review` or `confirmed_fraud` (`capturePayment` → 409). The
// authorization hold stays on the card until a human clears the review or cancels the order (which voids it).
//
// `order.updated` v1 has no reason field and forbids extra properties, so the reason code travels as a
// `changed_fields` entry: `fraud.reason_code=<code>`. Codes are a closed set — no PII can ride along.
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { transition } from '../orders';
import type { FraudProviderName, FraudReasonCode } from './types';

export type OrderFraudStatus = 'review' | 'cleared' | 'confirmed_fraud';

export interface OrderFraudFlag {
  status: OrderFraudStatus;
  reason_code: FraudReasonCode;
  provider: FraudProviderName;
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

export async function readOrderFraud(
  tx: Queryable,
  orderId: string,
): Promise<OrderFraudFlag | null> {
  return (await paymentOfOrder(tx, orderId, false))?.fraud ?? null;
}

async function writeFlag(
  tx: Queryable,
  orderId: string,
  paymentId: string,
  flag: OrderFraudFlag,
  changed: string[],
  actor: Actor,
): Promise<void> {
  await tx.query(
    `UPDATE payment SET metadata = jsonb_set(metadata, '{fraud}', $2::jsonb), updated_at = now() WHERE id = $1`,
    [paymentId, JSON.stringify(flag)],
  );
  await transition(tx, orderId, { changed_fields: ['fraud', ...changed], actor });
}

/** Holds the order for review. Idempotent: an order already under review is left as it is (no second event). */
export async function flagOrderForReview(
  tx: Queryable,
  orderId: string,
  input: { reasonCode: FraudReasonCode; provider: FraudProviderName; actor: Actor },
): Promise<OrderFraudFlag> {
  const payment = await paymentOfOrder(tx, orderId, true);
  if (!payment) throw notFound('payment for order', orderId);
  if (payment.fraud?.status === 'review') return payment.fraud;
  const flag: OrderFraudFlag = {
    status: 'review',
    reason_code: input.reasonCode,
    provider: input.provider,
    flagged_at: new Date().toISOString(),
  };
  await writeFlag(
    tx,
    orderId,
    payment.id,
    flag,
    ['fraud.status=review', `fraud.reason_code=${input.reasonCode}`],
    input.actor,
  );
  return flag;
}

/**
 * Ends a review: `cleared` (the payment may be captured) or `confirmed_fraud` (it stays uncapturable; cancel
 * the order). Idempotent on the target status; an order that was never flagged is left alone.
 */
export async function resolveOrderReview(
  tx: Queryable,
  orderId: string,
  input: { status: Exclude<OrderFraudStatus, 'review'>; resolution: string; actor: Actor },
): Promise<OrderFraudFlag | null> {
  const payment = await paymentOfOrder(tx, orderId, true);
  if (!payment?.fraud) return null;
  if (payment.fraud.status === input.status) return payment.fraud;
  const flag: OrderFraudFlag = {
    ...payment.fraud,
    status: input.status,
    resolved_at: new Date().toISOString(),
    resolution: input.resolution.replace(/[^a-z0-9_]/gi, '_').slice(0, 40),
  };
  await writeFlag(tx, orderId, payment.id, flag, [`fraud.status=${input.status}`], input.actor);
  return flag;
}
