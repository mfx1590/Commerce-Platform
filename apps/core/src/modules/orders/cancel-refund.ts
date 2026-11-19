// Cancel refunds a captured payment (#905, manager decision 2026-11-18). The orders module cannot import the payments
// module (payments imports orders), so the refund is a SEAM, like the returns module's RefundRequester: the orders
// module asks, window 7's `createRefundIn` answers — registered at boot by src/wiring.ts (`registerModuleSeams`).
// Nothing registered = fail closed: a captured order is not cancelled at all (503), never cancelled without its refund.
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';

export interface CancelRefundRequest {
  orderId: string;
  paymentId: string;
  /** `<payment idempotency_key>:cancel-refund` — the provider key, so a retry can never refund twice. */
  idempotencyKey: string;
  actor: Actor;
}

export interface CancelRefundOutcome {
  /**
   * `nothing` — no money left to refund (fully refunded already); `succeeded` — refund row + `refund.issued` written
   * on the caller's transaction; `pending` — the PSP accepted it, `refund.issued` follows when its webhook settles it;
   * `failed` — a definitive provider refusal (the caller throws, so nothing commits).
   */
  status: 'nothing' | 'succeeded' | 'pending' | 'failed';
  refundId: string | null;
  amountMinor: number;
  failureReason: string | null;
}

export interface CancelRefunder {
  /** Refunds what is still captured on the payment (captured − already refunded), on the caller's transaction. */
  refundRemaining(tx: Queryable, request: CancelRefundRequest): Promise<CancelRefundOutcome>;
}

let refunder: CancelRefunder | null = null;

/** Registers the refunder (returns the previous one so tests can restore it). */
export function setCancelRefunder(next: CancelRefunder | null): CancelRefunder | null {
  const previous = refunder;
  refunder = next;
  return previous;
}

export function currentCancelRefunder(): CancelRefunder | null {
  return refunder;
}
