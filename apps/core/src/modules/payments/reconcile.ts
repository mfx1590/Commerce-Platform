// Refund reconciliation (#918, window 1 on an integration branch; window 7's module).
//
// 1. `recordFailedRefundAttempt` — a refund the PSP REFUSED while the caller's transaction rolled back (an order
//    cancel: the order stays uncancelled) is still recorded, in its own transaction: a `failed` refund row under the
//    attempt's key + `refund.failed`. Idempotent on the key. The cancel's next attempt then derives the NEXT key, so a
//    deliberate retry is a new PSP request instead of Stripe replaying the saved refusal for ~24 h.
// 2. `reconcilePaymentRefunds` — a refund that HAPPENED at the PSP with no row of ours (the transaction did not
//    commit after the PSP answered and nobody retried; a Dashboard refund) is recorded from Stripe: refund row +
//    `refund.issued` + the order's `payment_status`. Amount and currency from STRIPE, never from the order; the reason
//    from the refund's metadata (ours carry it), else `goodwill`. A row of ours is found by `provider_refund_id`
//    whatever its status — a `pending` row is never duplicated. Idempotent: a second run finds the row it made.
//    Called by the `charge.refunded` webhook (after its commit) and by `pnpm --filter @platform/core refunds:reconcile`.
import type { ScopedClient } from '@platform/db';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import type { Actor } from '../../lib/audit';
import { clearRefundAttentionInTx } from './orders-seam';
import { refundIdempotencyKey, syncOrderPaymentStatus, type RefundReason } from './refunds';
import type { StripeApi } from './stripe-client';

const REASONS: readonly RefundReason[] = ['return', 'cancellation', 'goodwill', 'chargeback'];

export interface FailedRefundAttempt {
  orderId: string;
  paymentId: string;
  amountMinor: number;
  /** The attempt's key, as the caller sent it (stored with the store prefix, like every refund key). */
  idempotencyKey: string;
  reason: RefundReason;
  failureReason: string;
  actor: Actor;
}

/** Records a refused attempt in its own transaction (see above). Returns the row id, or null when already recorded. */
export async function recordFailedRefundAttempt(
  client: ScopedClient,
  input: FailedRefundAttempt,
): Promise<string | null> {
  return client.transaction(async (tx) => {
    const p = await tx.query<{ organization_id: string; store_id: string; currency: string }>(
      `SELECT organization_id, store_id, currency FROM payment WHERE id = $1 AND order_id = $2 FOR UPDATE`,
      [input.paymentId, input.orderId],
    );
    const payment = p.rows[0];
    if (!payment) return null;
    const key = refundIdempotencyKey(payment.store_id, input.idempotencyKey);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO refund (organization_id, store_id, order_id, payment_id, amount_minor, currency, reason, status,
         requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', $8, $9)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [
        payment.organization_id,
        payment.store_id,
        input.orderId,
        input.paymentId,
        input.amountMinor,
        payment.currency,
        input.reason,
        input.actor.type === 'staff' ? input.actor.id : null,
        key,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) return null;
    const now = new Date();
    await withEvents(tx, [
      await buildEvent({
        topic: 'refund.failed',
        organizationId: payment.organization_id,
        storeId: payment.store_id,
        aggregateType: 'refund',
        aggregateId: id,
        actor: eventActor(input.actor),
        occurredAt: now,
        payload: {
          refund_id: id,
          payment_id: input.paymentId,
          order_id: input.orderId,
          amount_minor: input.amountMinor,
          currency: payment.currency,
          failure_reason: input.failureReason,
          failed_at: now.toISOString(),
        },
      }),
    ]);
    return id;
  });
}

interface PaymentForReconcile {
  id: string;
  organization_id: string;
  store_id: string;
  order_id: string;
  provider: string;
  provider_payment_id: string | null;
  amount_minor: string;
  status: string;
}

/** Records the PSP's succeeded refunds of one payment that have no row of ours (see above). Returns the new row ids. */
export async function reconcilePaymentRefunds(
  client: ScopedClient,
  input: { paymentId: string; api: StripeApi; actor: Actor },
): Promise<string[]> {
  return client.transaction(async (tx) => {
    const p = await tx.query<PaymentForReconcile>(
      `SELECT id, organization_id, store_id, order_id, provider, provider_payment_id, amount_minor::text, status
       FROM payment WHERE id = $1 FOR UPDATE`,
      [input.paymentId],
    );
    const payment = p.rows[0];
    if (!payment || payment.provider !== 'stripe' || !payment.provider_payment_id) return [];
    if (payment.status !== 'captured') return []; // only captured money can have been refunded
    const list = await input.api.listRefunds({
      payment_intent: payment.provider_payment_id,
      limit: 100,
    });
    const store = await tx.query<{ legal_entity_id: string }>(
      `SELECT legal_entity_id FROM store WHERE id = $1`,
      [payment.store_id],
    );
    const created: string[] = [];
    for (const r of list.data) {
      if (r.status !== 'succeeded') continue; // pending: not money yet; failed: nothing moved
      const known = await tx.query(`SELECT 1 FROM refund WHERE provider_refund_id = $1`, [r.id]);
      if (known.rows.length > 0) continue; // ours, whatever its status (a pending row is never duplicated)
      const reason = REASONS.find((x) => x === r.metadata?.reason) ?? 'goodwill';
      const currency = r.currency.toUpperCase();
      const row = await tx.query<{ id: string }>(
        `INSERT INTO refund (organization_id, store_id, order_id, payment_id, amount_minor, currency, reason, status,
           provider_refund_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'succeeded', $8, $9) RETURNING id`,
        [
          payment.organization_id,
          payment.store_id,
          payment.order_id,
          payment.id,
          r.amount,
          currency,
          reason,
          r.id,
          refundIdempotencyKey(payment.store_id, `reconciled_${r.id}`),
        ],
      );
      const refundId = row.rows[0]!.id;
      const now = new Date();
      await withEvents(tx, [
        await buildEvent({
          topic: 'refund.issued',
          organizationId: payment.organization_id,
          storeId: payment.store_id,
          aggregateType: 'refund',
          aggregateId: refundId,
          actor: eventActor(input.actor),
          occurredAt: now,
          payload: {
            refund_id: refundId,
            payment_id: payment.id,
            order_id: payment.order_id,
            return_id: null,
            legal_entity_id: store.rows[0]!.legal_entity_id,
            amount_minor: r.amount,
            currency,
            reason,
            provider_refund_id: r.id,
            issued_at: now.toISOString(),
          },
        }),
      ]);
      await syncOrderPaymentStatus(
        tx,
        payment.order_id,
        payment.id,
        Number(payment.amount_minor),
        input.actor,
      );
      await clearRefundAttentionInTx(tx, payment.order_id, { refundId }, input.actor);
      created.push(refundId);
    }
    return created;
  });
}
