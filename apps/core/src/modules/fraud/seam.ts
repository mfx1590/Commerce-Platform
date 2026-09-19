// LOCAL STAND-IN for the fraud seam requested from window 1 (task 2.5, #128). The checkout has no fraud hook
// today: `completeCart` goes straight to `PaymentProvider.authorize`. The REQUEST asks for exactly this shape —
// `setFraudCheck` in the checkout's public API, `evaluate(ctx)` called inside the placement transaction BEFORE
// `authorize`, and the two consequences below. Until it lands, this file is the registry, and `fraud.test.ts`
// plays the checkout's part with `enforceDecision` / `applyDecisionToOrder`; when it lands, `registerFraudCheck`
// points at the checkout's `setFraudCheck` and this registry goes away.
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';
import { flagOrderForReview, type OrderFraudFlag } from './order-flag';
import type { FraudContext, FraudDecision } from './types';

export interface FraudCheck {
  evaluate(ctx: FraudContext): Promise<FraudDecision>;
}

let current: FraudCheck | null = null;

/** Registers the fraud check (null = none). Returns the previous one so tests can restore it. */
export function setFraudCheck(next: FraudCheck | null): FraudCheck | null {
  const previous = current;
  current = next;
  return previous;
}

export function currentFraudCheck(): FraudCheck | null {
  return current;
}

/**
 * What the checkout does with a decision BEFORE authorizing: a `block` is refused exactly like a decline —
 * 402 `payment_failed`, the generic message, `details.provider` only. No fraud-specific code or wording ever
 * reaches the Store API: a distinct answer would tell a probing fraudster which attempt tripped a rule.
 */
export function enforceDecision(decision: FraudDecision, paymentProvider: string): void {
  if (decision.outcome === 'block') {
    throw new AppError('payment_failed', 'payment not authorized', { provider: paymentProvider });
  }
}

/** What the checkout does AFTER inserting the order, same transaction: a `review` decision flags it. */
export async function applyDecisionToOrder(
  tx: Queryable,
  orderId: string,
  decision: FraudDecision,
  actor: Actor,
): Promise<OrderFraudFlag | null> {
  if (decision.outcome !== 'review' || !decision.reasonCode || !decision.provider) return null;
  return flagOrderForReview(tx, orderId, {
    reasonCode: decision.reasonCode,
    provider: decision.provider,
    actor,
  });
}
