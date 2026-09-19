// Pure helpers of the order-side fraud mirror (#231): the flag shape, the hold guard used by transition(), and the
// Store API strip. No import of ./service — that is what lets transition() use the guard without a cycle.
import { conflict } from '../../lib/errors';

export type OrderFraudStatus = 'review' | 'cleared' | 'confirmed_fraud';

export interface OrderFraudFlag {
  status: OrderFraudStatus;
  reason_code: string;
  provider: string;
  flagged_at: string;
  resolved_at?: string;
  /** How the review ended (a code: `approved`, `refunded_as_fraud`, `disputed`, `manual` …). */
  resolution?: string;
}

/** The mirror on an order row's metadata, or null. */
export function orderFraudOf(
  metadata: Record<string, unknown> | null | undefined,
): OrderFraudFlag | null {
  const f = metadata?.fraud as Partial<OrderFraudFlag> | undefined;
  return f && typeof f.status === 'string' && typeof f.reason_code === 'string'
    ? (f as OrderFraudFlag)
    : null;
}

/** Orders held by a review cannot move on: 409 until the review is `cleared` (used by the confirm transition). */
export function assertNotHeldByFraud(metadata: Record<string, unknown>, to: string): void {
  const flag = orderFraudOf(metadata);
  if (flag && (flag.status === 'review' || flag.status === 'confirmed_fraud')) {
    throw conflict(`order is held by a fraud review (${flag.status})`, {
      field: 'status',
      to,
      fraud_status: flag.status,
    });
  }
}

/** Keys of `order.metadata` that are ours, not the storefront's: never rendered on the Store API (#100 exposes the rest). */
export const INTERNAL_ORDER_METADATA_KEYS = ['fraud'] as const;

export function stripInternalMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...metadata };
  for (const key of INTERNAL_ORDER_METADATA_KEYS) delete out[key];
  return out;
}
