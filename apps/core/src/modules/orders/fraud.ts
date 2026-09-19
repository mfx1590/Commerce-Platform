// The order-side MIRROR of a fraud review (#231). Source of truth = the payment row (`payment.metadata.fraud`,
// window 7's aggregate); these functions only write `order.metadata.fraud` and emit ONE `order.updated` through
// `transition()`, idempotent on the target status. The reason code travels as a `changed_fields` entry
// (`fraud.reason_code=<code>`) — `order.updated` v1 has no reason field, and a real one waits for the Phase 4
// events window (manager ruling 2026-09-19). The key never crosses the Store API: see `stripInternalMetadata`.
import type { Queryable, ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { orderFraudOf, type OrderFraudFlag, type OrderFraudStatus } from './fraud-flag';
import { loadOrder } from './read-model';
import { mergeOrderMetadataIn, transition } from './service';

export type { OrderFraudFlag, OrderFraudStatus } from './fraud-flag';

const fields = (flag: OrderFraudFlag): string[] => [
  'fraud',
  `fraud.reason_code=${flag.reason_code}`,
  `fraud.status=${flag.status}`,
];

/** Flags the order for review on the caller's transaction. Idempotent: an order already in `review` is returned as is. */
export async function flagOrderForReview(
  tx: Queryable,
  orderId: string,
  input: { reasonCode: string; provider: string; actor: Actor; flaggedAt?: string },
): Promise<OrderFraudFlag> {
  const order = await loadOrder(tx, orderId, true);
  const existing = orderFraudOf(order.metadata);
  if (existing?.status === 'review') return existing;
  const flag: OrderFraudFlag = {
    status: 'review',
    reason_code: input.reasonCode,
    provider: input.provider,
    flagged_at: input.flaggedAt ?? new Date().toISOString(),
  };
  await mergeOrderMetadataIn(tx, orderId, { fraud: flag });
  await transition(tx, orderId, { changed_fields: fields(flag), actor: input.actor });
  return flag;
}

/** Ends a review (`cleared` lifts the hold, `confirmed_fraud` keeps it). Null when the order was never flagged. */
export async function resolveOrderReview(
  tx: Queryable,
  orderId: string,
  input: { status: Exclude<OrderFraudStatus, 'review'>; resolution: string; actor: Actor },
): Promise<OrderFraudFlag | null> {
  const order = await loadOrder(tx, orderId, true);
  const existing = orderFraudOf(order.metadata);
  if (!existing) return null;
  if (existing.status === input.status) return existing;
  const flag: OrderFraudFlag = {
    ...existing,
    status: input.status,
    resolved_at: new Date().toISOString(),
    resolution: input.resolution,
  };
  await mergeOrderMetadataIn(tx, orderId, { fraud: flag });
  await transition(tx, orderId, { changed_fields: fields(flag), actor: input.actor });
  return flag;
}

/** Client-taking twins (one transaction each), like the other order markers. */
export const flagOrderForReviewWith = (
  client: ScopedClient,
  orderId: string,
  input: Parameters<typeof flagOrderForReview>[2],
) => client.transaction((tx) => flagOrderForReview(tx, orderId, input));
export const resolveOrderReviewWith = (
  client: ScopedClient,
  orderId: string,
  input: Parameters<typeof resolveOrderReview>[2],
) => client.transaction((tx) => resolveOrderReview(tx, orderId, input));
