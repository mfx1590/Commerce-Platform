// Capture (#124, route #355): the authorized `payment` row → Stripe capture (full, or `amount_to_capture` for a
// partial one) → row `captured` (+ `fee_minor` from the expanded balance transaction; for a partial capture the
// row's `amount_minor` becomes the CAPTURED amount and `metadata.capture` keeps the authorised one) +
// `payment.captured` through the outbox + an `audit_log` row, all in ONE transaction; then the order's
// `payment_status` through the orders module's idempotent wrapper (its own transaction). A definitive Stripe
// failure writes `failed` + `payment.failed` the same way and throws 402. Replay on an already-captured row is a
// no-op that still converges the order status. The manual provider (and any other non-Stripe provider) has
// nothing to capture: 422 `provider_unsupported`.
import type { ErrorCode } from '@platform/contracts';
import type { ScopedClient } from '@platform/db';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { writeAudit, type Actor } from '../../lib/audit';
import { AppError, conflict, notFound, validationError } from '../../lib/errors';
import { markPaymentCaptured, markPaymentFailed } from './orders-seam';
import { stripeCredentialsFor, type StripeCredentials } from './credentials';
import {
  StripeClient,
  StripeError,
  type StripeApi,
  type StripeCharge,
  type StripeParams,
} from './stripe-client';

/**
 * Admin API 0.4.9's 422 code for "the store's provider cannot perform this operation" (the shared `Unprocessable`
 * response). In `ERROR_CODES` and the core's status map since contracts 0.4.12 (manager landing 2026-10-06): the
 * status comes from `AppError` like every other code.
 */
export const PROVIDER_UNSUPPORTED: ErrorCode = 'provider_unsupported';

export function providerUnsupported(provider: string, operation = 'capture payments'): AppError {
  return new AppError(PROVIDER_UNSUPPORTED, `the ${provider} provider cannot ${operation}`, {
    provider,
  });
}

export interface CapturePaymentOptions {
  actor: Actor;
  /**
   * Partial capture: the amount to take, at most the authorised one (the remainder of the hold is released by
   * Stripe). `null` / undefined = the whole authorisation. Ignored on a replay (the row is already captured).
   */
  amountMinor?: number | null;
  /** When set, the payment must belong to this order (the Admin route's path) — otherwise 404. */
  orderId?: string;
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
  /** After a capture: the CAPTURED amount (the authorised one is in `metadata.capture.authorized_minor`). */
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

/** The contract's `Payment` (admin-api.yaml), as the orders read model renders it in `Order.payments`. */
export interface AdminPayment {
  id: string;
  provider: string;
  provider_payment_id: string | null;
  amount: { amount_minor: number; currency: string };
  status: PaymentRow['status'];
  fee_minor: number | null;
  captured_at: string | null;
}

export function renderPayment(p: PaymentRow): AdminPayment {
  return {
    id: p.id,
    provider: p.provider,
    provider_payment_id: p.provider_payment_id,
    amount: { amount_minor: Number(p.amount_minor), currency: p.currency },
    status: p.status,
    fee_minor: p.fee_minor === null ? null : Number(p.fee_minor),
    captured_at: p.captured_at ? p.captured_at.toISOString() : null,
  };
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
 * Captures an authorized `stripe` payment — the whole authorisation, or `amountMinor` of it. Idempotent end to
 * end: the Stripe idempotency key is `capture_<payment_id>`, a replay on a captured row makes no Stripe call, and
 * the order transition is idempotent on the target state — so a crash between the payment transaction and the
 * order transition is healed by calling this again. Callers: the Admin route (#355) and window 1's confirm flow.
 *
 * - `amountMinor` above the authorised amount → 409 `conflict` `{ field: 'amount_minor', requested_minor,
 *   authorized_minor }`, nothing sent to Stripe; below 1 or not an integer → 400.
 * - a provider other than `stripe` (the built-in `manual`) → 422 `provider_unsupported` `{ provider }`.
 * - Stripe `idempotency_error` (a retry after an outage with a DIFFERENT amount under the same key) → 409, nothing
 *   written: the first request's parameters stand; retry with the same amount or wait for the webhook.
 */
export async function capturePayment(
  client: ScopedClient,
  paymentId: string,
  opts: CapturePaymentOptions,
): Promise<CapturePaymentResult> {
  const requested = opts.amountMinor ?? null;
  if (requested !== null && (!Number.isInteger(requested) || requested < 1)) {
    throw validationError('amount_minor must be a positive integer (minor units)', {
      amount_minor: 'integer >= 1',
    });
  }

  const outcome = await client.transaction(async (tx): Promise<CaptureOutcome> => {
    const r = opts.orderId
      ? await tx.query<PaymentRow>(`${SELECT_PAYMENT} AND order_id = $2 FOR UPDATE`, [
          paymentId,
          opts.orderId,
        ])
      : await tx.query<PaymentRow>(`${SELECT_PAYMENT} FOR UPDATE`, [paymentId]);
    const payment = r.rows[0];
    if (!payment) throw notFound('payment', paymentId);
    if (payment.provider !== 'stripe') throw providerUnsupported(payment.provider);
    if (payment.status === 'captured') return { kind: 'replayed', payment };
    if (payment.status !== 'authorized' || !payment.provider_payment_id) {
      throw conflict(`payment cannot go from ${payment.status} to captured`, {
        field: 'status',
        from: payment.status,
        to: 'captured',
      });
    }
    const authorizedMinor = Number(payment.amount_minor);
    if (requested !== null && requested > authorizedMinor) {
      throw conflict(`amount_minor ${requested} exceeds the authorised ${authorizedMinor}`, {
        field: 'amount_minor',
        requested_minor: requested,
        authorized_minor: authorizedMinor,
      });
    }
    const captureMinor = requested ?? authorizedMinor;
    const partial = captureMinor !== authorizedMinor;

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
    const params: StripeParams = partial ? { amount_to_capture: captureMinor } : {};
    try {
      const intent = await api.capturePaymentIntent(payment.provider_payment_id, params, {
        idempotencyKey: `capture_${payment.id}`,
        expand: ['latest_charge.balance_transaction'],
      });
      const fee = feeFrom(intent.latest_charge);
      // The row's amount becomes what was captured: the refund ceiling (2.3) and `Order.payments[].amount` read
      // it; the authorised amount stays on record in `metadata.capture`.
      await tx.query(
        `UPDATE payment
         SET status = 'captured', captured_at = $2, fee_minor = $3, amount_minor = $4,
             metadata = metadata || jsonb_build_object('capture', jsonb_build_object(
               'authorized_minor', $5::bigint, 'captured_minor', $4::bigint, 'partial', $6::boolean)),
             updated_at = now()
         WHERE id = $1`,
        [payment.id, now, fee, captureMinor, authorizedMinor, partial],
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
            amount_minor: captureMinor,
            fee_minor: fee,
            currency: payment.currency,
            captured_at: now.toISOString(),
          },
        }),
      ]);
      // Ids and amounts only — no PII (the audit row is an admin mutation record, docs/domain.md).
      await writeAudit(tx, {
        organizationId: payment.organization_id,
        storeId: payment.store_id,
        actor: opts.actor,
        action: 'payment.capture',
        entityType: 'payment',
        entityId: payment.id,
        before: { status: 'authorized', amount_minor: authorizedMinor },
        after: {
          status: 'captured',
          amount_minor: captureMinor,
          authorized_minor: authorizedMinor,
          partial,
          fee_minor: fee,
          order_id: payment.order_id,
        },
      });
      const updated = await tx.query<PaymentRow>(SELECT_PAYMENT, [payment.id]);
      return { kind: 'captured', payment: updated.rows[0]! };
    } catch (err) {
      // Outages / 5xx / network: write nothing, rethrow — the caller retries and idempotency protects us.
      if (!(err instanceof StripeError) || !err.definitive) throw err;
      // Same key, other parameters (a retry with another amount after an outage): Stripe refuses, and so do we —
      // nothing is written, the payment stays authorized; the first request's outcome arrives by webhook.
      if (err.type === 'idempotency_error') {
        throw conflict(
          'a capture with different parameters was already sent to Stripe for this payment; retry with the same amount',
          { field: 'amount_minor', requested_minor: captureMinor, stripe_code: err.code },
        );
      }
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
            amount_minor: authorizedMinor,
            currency: payment.currency,
            failure_reason: reason,
            failed_at: now.toISOString(),
          },
        }),
      ]);
      await writeAudit(tx, {
        organizationId: payment.organization_id,
        storeId: payment.store_id,
        actor: opts.actor,
        action: 'payment.capture_failed',
        entityType: 'payment',
        entityId: payment.id,
        before: { status: 'authorized', amount_minor: authorizedMinor },
        after: { status: 'failed', failure_reason: reason, requested_minor: captureMinor },
      });
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
