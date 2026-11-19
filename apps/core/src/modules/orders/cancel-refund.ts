// Cancel refunds a captured payment (#905, manager decision 2026-11-18). The orders module cannot import the payments
// module (payments imports orders), so the refund is a SEAM, like the returns module's RefundRequester: the orders
// module asks, window 7's `createRefundIn` answers — registered at boot by src/wiring.ts (`registerModuleSeams`).
// Nothing registered = fail closed: a captured order is not cancelled at all (503), never cancelled without its refund.
import type { Queryable, ScopedClient } from '@platform/db';
import type { Actor } from '../../lib/audit';
import { AppError } from '../../lib/errors';

export interface CancelRefundRequest {
  orderId: string;
  paymentId: string;
  /**
   * The payment's own `idempotency_key`. The refunder derives the attempt key from it (#918):
   * `cancel_refund_<sha256(<key>:cancel-refund:<n>)>`, n = the payment's RECORDED failed cancel attempts + 1 — so a
   * deliberate retry after a recorded refusal is a new request, an unknown outcome (nothing recorded) reuses its key.
   */
  paymentKey: string;
  actor: Actor;
}

/** A definitive refusal, as the refunder saw it: what to record once the cancel's transaction has rolled back. */
export interface FailedCancelRefund {
  orderId: string;
  paymentId: string;
  amountMinor: number;
  /** The attempt's key (as sent to the provider, without the store prefix). */
  idempotencyKey: string;
  failureReason: string;
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
  /** The attempt's key (for `failed`: what `recordFailedAttempt` records). */
  idempotencyKey: string | null;
}

export interface CancelRefunder {
  /** Refunds what is still captured on the payment (captured − already refunded), on the caller's transaction. */
  refundRemaining(tx: Queryable, request: CancelRefundRequest): Promise<CancelRefundOutcome>;
  /**
   * Records a refused attempt in its OWN transaction, after the cancel rolled back (#918): a `failed` refund row
   * under the attempt's key + `refund.failed`. Idempotent on the key. The next attempt then gets the next key.
   */
  recordFailedAttempt(client: ScopedClient, attempt: FailedCancelRefund): Promise<void>;
}

/** The cancel's 402 when the provider refused the refund; carries the attempt so `cancelOrder` can record it. */
export class CancelRefundRefused extends AppError {
  constructor(
    readonly attempt: FailedCancelRefund,
    provider: string,
  ) {
    super('payment_failed', attempt.failureReason, { provider });
  }
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
