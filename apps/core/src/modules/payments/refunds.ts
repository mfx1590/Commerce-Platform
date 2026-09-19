// Refunds (task 2.3, #126): `createRefund` behind the Admin API `createRefund` operation and behind the returns
// module's `RefundRequester` seam. One transaction: replay on the Idempotency-Key → captured payment locked →
// ceiling (captured − already refunded) → support limit → `PaymentProvider.refund` → `refund` row +
// `refund.issued` / `refund.failed` through the outbox → the order's `payment_status` through the orders
// module's `transition()` on the same transaction. A refund the PSP has only ACCEPTED (Stripe `pending`) stays a
// `pending` row with no event: `refund.issued` is emitted when the webhook settles it, never before. A provider
// failure keeps its row (`failed`) so the same key
// replays the failure instead of charging the PSP again; a new key may try again (failed rows do not count
// against the ceiling). Outages rethrow with nothing written.
import type { Queryable, ScopedClient } from '@platform/db';
import type { AdminComponents } from '@platform/contracts';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import type { Actor } from '../../lib/audit';
import { AppError, conflict, notFound } from '../../lib/errors';
import { paymentProvider } from '../checkout';
import { loadOrder, transition, type PaymentStatus } from '../orders';
import { refundPendingAtProvider } from './provider';

export type RefundReason = 'return' | 'cancellation' | 'goodwill' | 'chargeback';
export type RefundStatus = 'pending' | 'succeeded' | 'failed';
/** The Admin API `Refund` schema. */
export type AdminRefund = AdminComponents['schemas']['Refund'];

export interface RefundRow {
  id: string;
  organization_id: string;
  store_id: string;
  order_id: string;
  payment_id: string;
  return_id: string | null;
  amount_minor: string;
  currency: string;
  reason: RefundReason;
  status: RefundStatus;
  provider_refund_id: string | null;
  requested_by: string | null;
  idempotency_key: string;
  created_at: Date;
}

export interface CreateRefundInput {
  orderId: string;
  /** Defaults to the order's captured payment. */
  paymentId?: string | null | undefined;
  amountMinor: number;
  reason: RefundReason;
  returnId?: string | null | undefined;
  /** The caller's `Idempotency-Key`; stored as `<store_id>:<key>` (per store by construction, like payments). */
  idempotencyKey: string;
  actor: Actor;
  /** `staff_user.id` of the operator (Admin API); null for system / return-driven refunds. */
  requestedBy?: string | null | undefined;
  /** `support_refund_limit_minor` for callers who are not store admins; null = no limit. */
  limitMinor?: number | null | undefined;
  /** The returns module moves the order's `payment_status` itself after a return refund: set false there. */
  transitionOrder?: boolean | undefined;
}

export interface CreateRefundOutcome {
  refund: RefundRow;
  /** True when the Idempotency-Key had already produced this refund: no provider call, nothing written. */
  replayed: boolean;
  /** Provider reason when `refund.status === 'failed'` on this call. */
  failureReason: string | null;
}

const REFUND_COLS = `id, organization_id, store_id, order_id, payment_id, return_id, amount_minor::text, currency,
  reason, status, provider_refund_id, requested_by, idempotency_key, created_at`;

interface CapturedPayment {
  id: string;
  order_id: string;
  provider: string;
  provider_payment_id: string | null;
  amount_minor: string;
  currency: string;
  status: string;
}

export function refundIdempotencyKey(storeId: string, key: string): string {
  return `${storeId}:${key}`;
}

/** Contract `Refund` from a row. */
export function renderRefund(r: RefundRow): AdminRefund {
  return {
    id: r.id,
    order_id: r.order_id,
    payment_id: r.payment_id,
    return_id: r.return_id,
    amount: { amount_minor: Number(r.amount_minor), currency: r.currency },
    reason: r.reason,
    status: r.status,
    provider_refund_id: r.provider_refund_id,
    created_at: r.created_at.toISOString(),
  };
}

/**
 * RESERVED money: Σ refunds that hold or will hold money (`pending` + `succeeded`); failed ones never count.
 * Drives the CEILING — a pending refund may still settle, so its amount cannot be refunded a second time.
 */
export async function refundedMinor(tx: Queryable, paymentId: string): Promise<number> {
  const r = await tx.query<{ n: string }>(
    `SELECT coalesce(sum(amount_minor), 0)::text AS n FROM refund
     WHERE payment_id = $1 AND status IN ('pending', 'succeeded')`,
    [paymentId],
  );
  return Number(r.rows[0]!.n);
}

/**
 * SETTLED money: Σ `succeeded` refunds only. Drives the order's `payment_status` — an order is `refunded` when
 * the money has actually gone back, never while part of it is still pending at the PSP (and may fail).
 */
export async function settledRefundedMinor(tx: Queryable, paymentId: string): Promise<number> {
  const r = await tx.query<{ n: string }>(
    `SELECT coalesce(sum(amount_minor), 0)::text AS n FROM refund
     WHERE payment_id = $1 AND status = 'succeeded'`,
    [paymentId],
  );
  return Number(r.rows[0]!.n);
}

/** The order's target `payment_status` after `refundedTotal` of `capturedMinor` has been refunded. */
export function paymentStatusAfterRefund(
  refundedTotal: number,
  capturedMinor: number,
): Extract<PaymentStatus, 'partially_refunded' | 'refunded'> {
  return refundedTotal >= capturedMinor ? 'refunded' : 'partially_refunded';
}

/**
 * Moves the order's payment_status to where the SETTLED refunded total says it should be (settled money
 * drives status; reserved money drives the ceiling), through the orders module's `transition()` on the caller's
 * transaction (one `order.updated`); a no-op when already there.
 */
export async function syncOrderPaymentStatus(
  tx: Queryable,
  orderId: string,
  paymentId: string,
  capturedMinor: number,
  actor: Actor,
): Promise<void> {
  const order = await loadOrder(tx, orderId, true);
  const total = await settledRefundedMinor(tx, paymentId);
  if (total <= 0) return;
  const target = paymentStatusAfterRefund(total, capturedMinor);
  if (order.payment_status === target) return;
  await transition(tx, orderId, { payment_status: target, actor });
}

/**
 * The refund use case on the caller's transaction (the returns module calls it inside its own; the Admin API
 * through `createRefund`). Throws the contract's 404 (order / payment), 409 (ceiling, non-captured payment,
 * key reused for a different refund) and 403 (support limit); returns a `failed` outcome — never throws — for
 * a definitive provider refusal so the row and its event commit with the caller's transaction.
 */
export async function createRefundIn(
  tx: Queryable,
  input: CreateRefundInput,
): Promise<CreateRefundOutcome> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 1) {
    throw new AppError('validation_error', 'amount_minor must be a positive integer', {
      amount_minor: 'minimum 1',
    });
  }
  const order = await loadOrder(tx, input.orderId, true);
  const key = refundIdempotencyKey(order.store_id, input.idempotencyKey);

  // ---- replay ----
  const existing = await tx.query<RefundRow>(
    `SELECT ${REFUND_COLS} FROM refund WHERE idempotency_key = $1`,
    [key],
  );
  const prior = existing.rows[0];
  if (prior) {
    // A replay must be the SAME refund in every field the caller controls: a key reused with another reason,
    // return or payment is a different request, never a silent replay of the old one.
    const differs: string[] = [];
    if (prior.order_id !== order.id) differs.push('order_id');
    if (Number(prior.amount_minor) !== input.amountMinor) differs.push('amount_minor');
    if (prior.reason !== input.reason) differs.push('reason');
    if ((prior.return_id ?? null) !== (input.returnId ?? null)) differs.push('return_id');
    if (input.paymentId && prior.payment_id !== input.paymentId) differs.push('payment_id');
    if (differs.length > 0) {
      throw conflict('Idempotency-Key was already used for a different refund', {
        'Idempotency-Key': 'reuse with the same order, amount, reason, return and payment only',
        differs,
        refund_id: prior.id,
      });
    }
    return { refund: prior, replayed: true, failureReason: null };
  }

  // ---- the captured payment ----
  const payment = input.paymentId
    ? (
        await tx.query<CapturedPayment>(
          `SELECT id, order_id, provider, provider_payment_id, amount_minor::text, currency, status
           FROM payment WHERE id = $1 AND order_id = $2 FOR UPDATE`,
          [input.paymentId, order.id],
        )
      ).rows[0]
    : (
        await tx.query<CapturedPayment>(
          `SELECT id, order_id, provider, provider_payment_id, amount_minor::text, currency, status
           FROM payment WHERE order_id = $1 AND status = 'captured'
           ORDER BY captured_at NULLS LAST, created_at LIMIT 1 FOR UPDATE`,
          [order.id],
        )
      ).rows[0];
  if (!payment) {
    if (input.paymentId) throw notFound('payment', input.paymentId);
    throw conflict('no captured payment to refund against (capture first)', {
      field: 'payment_status',
      from: order.payment_status,
      to: 'captured',
    });
  }
  if (payment.status !== 'captured' || !payment.provider_payment_id) {
    throw conflict(`payment is ${payment.status}; only a captured payment can be refunded`, {
      field: 'status',
      from: payment.status,
      to: 'captured',
    });
  }

  // ---- support limit FIRST (authorization: a capped caller gets their 403, never a 409 that reveals the
  // refundable amount), then the ceiling ----
  if (
    input.limitMinor !== null &&
    input.limitMinor !== undefined &&
    input.amountMinor > input.limitMinor
  ) {
    throw new AppError('forbidden', `refund exceeds the support limit of ${input.limitMinor}`, {
      limit_minor: input.limitMinor,
      requested_minor: input.amountMinor,
    });
  }
  const captured = Number(payment.amount_minor);
  const refunded = await refundedMinor(tx, payment.id);
  const available = captured - refunded;
  if (input.amountMinor > available) {
    throw conflict('refund exceeds the refundable amount (captured minus already refunded)', {
      field: 'amount_minor',
      captured_minor: captured,
      refunded_minor: refunded,
      available_minor: available,
      requested_minor: input.amountMinor,
    });
  }

  const provider = paymentProvider(payment.provider);
  if (!provider) {
    throw new AppError(
      'internal',
      `payment provider ${payment.provider} is not registered`,
      undefined,
      503,
    );
  }

  // ---- row first (pending), then the provider: the UNIQUE key makes a retry after a crash replay, not repeat ----
  const inserted = await tx.query<RefundRow>(
    `INSERT INTO refund (organization_id, store_id, order_id, payment_id, return_id, amount_minor, currency,
       reason, status, requested_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
     RETURNING ${REFUND_COLS}`,
    [
      order.organization_id,
      order.store_id,
      order.id,
      payment.id,
      input.returnId ?? null,
      input.amountMinor,
      payment.currency,
      input.reason,
      input.requestedBy ?? null,
      key,
    ],
  );
  const row = inserted.rows[0]!;
  const result = await provider.refund({
    tx,
    organizationId: order.organization_id,
    storeId: order.store_id,
    providerPaymentId: payment.provider_payment_id,
    amountMinor: input.amountMinor,
    currency: payment.currency,
    idempotencyKey: key,
    reason: input.reason,
  });
  const now = new Date();

  // Accepted but not settled (Stripe `pending` / `requires_action`): the row stays `pending` with the provider
  // id, NO `refund.issued`, NO order transition — accounting must never see a refund that can still fail. The
  // webhook receiver settles it (`refund.updated` → succeeded + `refund.issued` + order / return; or failed +
  // `refund.failed`). A pending row already holds its money against the ceiling.
  if (refundPendingAtProvider(result)) {
    await tx.query(`UPDATE refund SET provider_refund_id = $2, updated_at = now() WHERE id = $1`, [
      row.id,
      result.providerRefundId,
    ]);
    const pending = await tx.query<RefundRow>(`SELECT ${REFUND_COLS} FROM refund WHERE id = $1`, [
      row.id,
    ]);
    return { refund: pending.rows[0]!, replayed: false, failureReason: null };
  }

  if (result.status === 'succeeded') {
    await tx.query(
      `UPDATE refund SET status = 'succeeded', provider_refund_id = $2, updated_at = now() WHERE id = $1`,
      [row.id, result.providerRefundId],
    );
    const store = await tx.query<{ legal_entity_id: string }>(
      `SELECT legal_entity_id FROM store WHERE id = $1`,
      [order.store_id],
    );
    await withEvents(tx, [
      await buildEvent({
        topic: 'refund.issued',
        organizationId: order.organization_id,
        storeId: order.store_id,
        aggregateType: 'refund',
        aggregateId: row.id,
        actor: eventActor(input.actor),
        occurredAt: now,
        payload: {
          refund_id: row.id,
          payment_id: payment.id,
          order_id: order.id,
          return_id: input.returnId ?? null,
          legal_entity_id: store.rows[0]!.legal_entity_id,
          amount_minor: input.amountMinor,
          currency: payment.currency,
          reason: input.reason,
          provider_refund_id: result.providerRefundId,
          issued_at: now.toISOString(),
        },
      }),
    ]);
    if (input.transitionOrder !== false) {
      await syncOrderPaymentStatus(tx, order.id, payment.id, captured, input.actor);
    }
    const reloaded = await tx.query<RefundRow>(`SELECT ${REFUND_COLS} FROM refund WHERE id = $1`, [
      row.id,
    ]);
    return { refund: reloaded.rows[0]!, replayed: false, failureReason: null };
  }

  const reason = result.failureReason ?? 'refund failed';
  await tx.query(
    `UPDATE refund SET status = 'failed', provider_refund_id = $2, updated_at = now() WHERE id = $1`,
    [row.id, result.providerRefundId],
  );
  await withEvents(tx, [
    await buildEvent({
      topic: 'refund.failed',
      organizationId: order.organization_id,
      storeId: order.store_id,
      aggregateType: 'refund',
      aggregateId: row.id,
      actor: eventActor(input.actor),
      occurredAt: now,
      payload: {
        refund_id: row.id,
        payment_id: payment.id,
        order_id: order.id,
        amount_minor: input.amountMinor,
        currency: payment.currency,
        failure_reason: reason,
        failed_at: now.toISOString(),
      },
    }),
  ]);
  const reloaded = await tx.query<RefundRow>(`SELECT ${REFUND_COLS} FROM refund WHERE id = $1`, [
    row.id,
  ]);
  return { refund: reloaded.rows[0]!, replayed: false, failureReason: reason };
}

/**
 * Admin API `createRefund`: the use case in its own transaction on a store-scoped client; a provider refusal
 * commits the `failed` row + `refund.failed`, then answers 402 `payment_failed` carrying the refund id (a replay
 * of that key answers the same 402: the PSP is never asked twice for one key).
 */
export async function createRefund(
  client: ScopedClient,
  input: CreateRefundInput,
): Promise<{ refund: AdminRefund; replayed: boolean }> {
  const outcome = await client.transaction((tx) => createRefundIn(tx, input));
  if (outcome.refund.status === 'failed') {
    throw new AppError(
      'payment_failed',
      `refund failed${outcome.failureReason ? `: ${outcome.failureReason}` : ''}`,
      { refund_id: outcome.refund.id, replayed: outcome.replayed },
    );
  }
  return { refund: renderRefund(outcome.refund), replayed: outcome.replayed };
}

/** One refund by id (route helpers, tests). */
export async function getRefund(
  client: ScopedClient,
  refundId: string,
): Promise<AdminRefund | null> {
  const r = await client.query<RefundRow>(`SELECT ${REFUND_COLS} FROM refund WHERE id = $1`, [
    refundId,
  ]);
  return r.rows[0] ? renderRefund(r.rows[0]) : null;
}
