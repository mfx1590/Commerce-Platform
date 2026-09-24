/**
 * How much of an order may still be refunded, and the idempotency key that makes a refund safe to
 * retry. Integer minor units throughout; nothing here touches a float.
 */

import type { AdminComponents } from '../api/admin-client';

type Order = AdminComponents['Order'];
type Refund = AdminComponents['Refund'];

/** Captured payments, summed — what has actually been taken from the customer. */
export function capturedMinor(order: Pick<Order, 'payments'>): number {
  return order.payments
    .filter((payment) => payment.status === 'captured')
    .reduce((sum, payment) => sum + payment.amount.amount_minor, 0);
}

/**
 * Refunds that count against the ceiling: succeeded and pending both do (a pending refund is money
 * that is leaving), failed ones do not — the manager's ruling for window 7 applied on this side.
 */
export function refundedMinor(order: Pick<Order, 'refunds'>): number {
  return order.refunds
    .filter((refund: Refund) => refund.status !== 'failed')
    .reduce((sum, refund) => sum + refund.amount.amount_minor, 0);
}

/** The most one more refund may take: captured minus everything already refunded or pending. */
export function refundableMinor(order: Pick<Order, 'payments' | 'refunds'>): number {
  return Math.max(0, capturedMinor(order) - refundedMinor(order));
}

/** `store.settings.support_refund_limit_minor`, when the store declares one. */
export function supportRefundLimitMinor(
  settings: Record<string, unknown> | undefined,
): number | null {
  const value = settings?.['support_refund_limit_minor'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * One key per *attempt*, kept until the attempt succeeds.
 *
 * The contract makes `Idempotency-Key` mandatory so that a request which timed out after the
 * provider acted cannot refund twice. That only works if the retry carries the *same* key, and a
 * fresh key only after a success — which is exactly the rule this small object enforces. It is a
 * plain object rather than React state so the rule is testable on its own and the form cannot get
 * it subtly wrong by re-rendering.
 */
export interface IdempotencyKeyHolder {
  /** The key for the current attempt (minted lazily). */
  current(): string;
  /** After a success: the next attempt is a different refund and gets a different key. */
  succeeded(): void;
  /** After a failure of any kind: the next attempt is the same refund and keeps the key. */
  failed(): void;
}

export function idempotencyKeyHolder(mint: () => string = randomKey): IdempotencyKeyHolder {
  let key: string | null = null;
  return {
    current() {
      if (key === null) key = mint();
      return key;
    },
    succeeded() {
      key = null;
    },
    failed() {
      // Deliberately nothing: the key survives.
    },
  };
}

function randomKey(): string {
  return `refund-${crypto.randomUUID()}`;
}

/** The contract's `minLength: 8` on the header, checked before a request is even built. */
export function isValidIdempotencyKey(key: string): boolean {
  return key.length >= 8;
}
