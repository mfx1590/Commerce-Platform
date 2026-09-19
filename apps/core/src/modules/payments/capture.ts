// Capture on confirm (#124): the authorized `payment` row → Stripe capture → row `captured` (+ `fee_minor` from
// the expanded balance transaction) + `payment.captured` through the outbox, all in ONE transaction; then the
// order's `payment_status` through the orders module's idempotent wrapper (its own transaction, PR #174 — local
// mirror in ./orders-seam until it lands). A definitive Stripe failure writes `failed` + `payment.failed` the
// same way and throws 402. Replay on an already-captured row is a no-op that still converges the order status.
import type { ScopedClient } from '@platform/db';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import type { Actor } from '../../lib/audit';
import { AppError, conflict, notFound, validationError } from '../../lib/errors';
import { markPaymentCaptured, markPaymentFailed } from './orders-seam';
import { stripeCredentialsFor, type StripeCredentials } from './credentials';
import { StripeClient, StripeError, type StripeApi, type StripeCharge } from './stripe-client';

export interface CapturePaymentOptions {
  actor: Actor;
  /** Injectable for tests; default a real StripeClient per credential set. */
  apiFactory?: (credentials: StripeCredentials) => StripeApi;
  env?: NodeJS.ProcessEnv;
}

export interface PaymentRow {
  id: string;
  organization_id: string;
  store_id: string;
  order_id: string;
  provider: string;
  provider_payment_id: string | null;
  amount_minor: string;
  currency: string;
  status: 'pending' | 'authorized' | 'captured' | 'failed' | 'cancelled';
  fee_minor: string | null;
  captured_at: Date | null;
  failure_reason: string | null;
}

export interface CapturePaymentResult {
  payment: PaymentRow;
  /** True when the row was already captured: no Stripe call, no new events. */
  replayed: boolean;
}

const SELECT_PAYMENT = `SELECT id, organization_id, store_id, order_id, provider, provider_payment_id,
  amount_minor::text, currency, status, fee_minor::text, captured_at, failure_reason
  FROM payment WHERE id = $1`;

function feeFrom(charge: string | StripeCharge | null | undefined): number | null {
  if (!charge || typeof charge === 'string') return null;
  const txn = charge.balance_transaction;
  if (!txn || typeof txn === 'string') return null;
  return txn.fee;
}

type CaptureOutcome =
  | { kind: 'replayed'; payment: PaymentRow }
  | { kind: 'captured'; payment: PaymentRow }
  | { kind: 'failed'; payment: PaymentRow; reason: string };

/**
 * Captures the full authorized amount of a `stripe` payment. Idempotent end to end: the Stripe idempotency key
 * is `capture_<payment_id>`, a replay on a captured row makes no Stripe call, and the order transition is
 * idempotent on the target state — so a crash between the payment transaction and the order transition is
 * healed by calling this again. Window 1's confirm flow (core 2.3) is the intended caller.
 */
export async function capturePayment(
  client: ScopedClient,
  paymentId: string,
  opts: CapturePaymentOptions,
): Promise<CapturePaymentResult> {
  const outcome = await client.transaction(async (tx): Promise<CaptureOutcome> => {
    const r = await tx.query<PaymentRow>(`${SELECT_PAYMENT} FOR UPDATE`, [paymentId]);
    const payment = r.rows[0];
    if (!payment) throw notFound('payment', paymentId);
    if (payment.provider !== 'stripe') {
      throw validationError(
        `capturePayment handles stripe payments; this one is ${payment.provider}`,
        {
          provider: payment.provider,
        },
      );
    }
    if (payment.status === 'captured') return { kind: 'replayed', payment };
    if (payment.status !== 'authorized' || !payment.provider_payment_id) {
      throw conflict(`payment cannot go from ${payment.status} to captured`, {
        field: 'status',
        from: payment.status,
        to: 'captured',
      });
    }

    // An order held for fraud review — or confirmed as fraud — is never captured: the hold on the card stays
    // until a human clears the review, or cancels the order (which voids it) (2.5).
    const held = await tx.query<{ fraud_status: string | null; reason_code: string | null }>(
      `SELECT metadata->'fraud'->>'status' AS fraud_status, metadata->'fraud'->>'reason_code' AS reason_code
       FROM payment WHERE id = $1`,
      [payment.id],
    );
    const fraudStatus = held.rows[0]?.fraud_status;
    if (fraudStatus === 'review' || fraudStatus === 'confirmed_fraud') {
      throw conflict(`order is held for fraud (${fraudStatus}); it cannot be captured`, {
        field: 'payment.metadata.fraud.status',
        from: fraudStatus,
        to: 'cleared',
        reason_code: held.rows[0]?.reason_code ?? null,
      });
    }

    const code = await tx.query<{ code: string; legal_entity_id: string }>(
      `SELECT code, legal_entity_id FROM store WHERE id = $1`,
      [payment.store_id],
    );
    const store = code.rows[0]!;
    const credentials = stripeCredentialsFor(store.code, opts.env ?? process.env);
    const api = opts.apiFactory
      ? opts.apiFactory(credentials)
      : new StripeClient({ secretKey: credentials.secretKey });

    const now = new Date();
    try {
      const intent = await api.capturePaymentIntent(
        payment.provider_payment_id,
        {},
        {
          idempotencyKey: `capture_${payment.id}`,
          expand: ['latest_charge.balance_transaction'],
        },
      );
      const fee = feeFrom(intent.latest_charge);
      await tx.query(
        `UPDATE payment SET status = 'captured', captured_at = $2, fee_minor = $3, updated_at = now()
         WHERE id = $1`,
        [payment.id, now, fee],
      );
      await withEvents(tx, [
        await buildEvent({
          topic: 'payment.captured',
          organizationId: payment.organization_id,
          storeId: payment.store_id,
          aggregateType: 'payment',
          aggregateId: payment.id,
          actor: eventActor(opts.actor),
          occurredAt: now,
          payload: {
            payment_id: payment.id,
            order_id: payment.order_id,
            legal_entity_id: store.legal_entity_id,
            provider: 'stripe',
            provider_payment_id: payment.provider_payment_id,
            amount_minor: Number(payment.amount_minor),
            fee_minor: fee,
            currency: payment.currency,
            captured_at: now.toISOString(),
          },
        }),
      ]);
      const updated = await tx.query<PaymentRow>(SELECT_PAYMENT, [payment.id]);
      return { kind: 'captured', payment: updated.rows[0]! };
    } catch (err) {
      // Outages / 5xx / network: write nothing, rethrow — the caller retries and idempotency protects us.
      if (!(err instanceof StripeError) || !err.definitive) throw err;
      const reason = err.declineCode ?? err.code ?? err.message;
      await tx.query(
        `UPDATE payment SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
        [payment.id, reason],
      );
      await withEvents(tx, [
        await buildEvent({
          topic: 'payment.failed',
          organizationId: payment.organization_id,
          storeId: payment.store_id,
          aggregateType: 'payment',
          aggregateId: payment.id,
          actor: eventActor(opts.actor),
          occurredAt: now,
          payload: {
            payment_id: payment.id,
            order_id: payment.order_id,
            provider: 'stripe',
            provider_payment_id: payment.provider_payment_id,
            amount_minor: Number(payment.amount_minor),
            currency: payment.currency,
            failure_reason: reason,
            failed_at: now.toISOString(),
          },
        }),
      ]);
      const updated = await tx.query<PaymentRow>(SELECT_PAYMENT, [payment.id]);
      return { kind: 'failed', payment: updated.rows[0]!, reason };
    }
  });

  // The order transition runs in its own transaction (the orders wrappers open one); idempotent on the target
  // state, so the replay path converges an order left behind by a crash between the two transactions.
  if (outcome.kind === 'failed') {
    await markPaymentFailed(client, outcome.payment.order_id, opts.actor);
    throw new AppError('payment_failed', `capture failed: ${outcome.reason}`, {
      payment_id: outcome.payment.id,
    });
  }
  await markPaymentCaptured(client, outcome.payment.order_id, opts.actor);
  return { payment: outcome.payment, replayed: outcome.kind === 'replayed' };
}
