// The `stripe` PaymentProvider (checkout module seam, #124): manual-capture PaymentIntents carrying only ids and
// amounts — card data never reaches this process (hosted fields / Payment Element, ADR 0004). Registered next to
// the built-in `manual` provider by `registerPaymentProviders()` (called by src/server.ts at boot, REQUEST #176).
import { createHash } from 'node:crypto';
import type { Queryable } from '@platform/db';
import type {
  AuthorizeInput,
  AuthorizeResult,
  CreatePaymentSessionInput,
  PaymentProvider,
  PaymentSessionResult,
  PaymentSessionStatus,
  RefundInput,
  RefundResult,
  VoidInput,
  VoidResult,
  StorePaymentSession,
} from '../checkout';
import { validationError } from '../../lib/errors';
import { stripeCredentialsFor, type StripeCredentials } from './credentials';
import {
  StripeClient,
  StripeError,
  type StripeApi,
  type StripePaymentIntent,
} from './stripe-client';

export interface StripeProviderOptions {
  /** Injectable for tests; default a real StripeClient per credential set. */
  apiFactory?: (credentials: StripeCredentials) => StripeApi;
  /** Injectable for tests; default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Stripe statuses that mean "the money is authorized (or already captured)". */
const AUTHORIZED_STATUSES: ReadonlyArray<StripePaymentIntent['status']> = [
  'requires_capture',
  'succeeded',
];

/** Stripe's code when an operation does not match the intent's current state (cancel of a canceled intent). */
const UNEXPECTED_STATE = 'payment_intent_unexpected_state';

function sessionStatus(intent: StripePaymentIntent): PaymentSessionStatus {
  return AUTHORIZED_STATUSES.includes(intent.status) ? 'authorized' : 'pending';
}

/** The Stripe idempotency key for the server-side confirm, derived from the placement `Idempotency-Key`. */
export function confirmIdempotencyKey(placementKey: string): string {
  return `confirm_${createHash('sha256').update(placementKey).digest('hex')}`;
}

/**
 * The Stripe idempotency key for the cancel, derived from the void key the orders module passes
 * (`<payment.idempotency_key>:void`): a retried cancel replays Stripe's recorded response instead of erroring.
 */
export function voidIdempotencyKey(voidKey: string): string {
  return `void_${createHash('sha256').update(voidKey).digest('hex')}`;
}

async function storeCodeFor(tx: Queryable, storeId: string): Promise<string> {
  const r = await tx.query<{ code: string }>(`SELECT code FROM store WHERE id = $1`, [storeId]);
  const code = r.rows[0]?.code;
  if (!code) throw new Error(`store ${storeId} not found while resolving stripe credentials`);
  return code;
}

function declineReason(err: StripeError): string {
  return err.declineCode ?? err.code ?? err.message;
}

export function createStripePaymentProvider(opts: StripeProviderOptions = {}): PaymentProvider {
  const apiFor = async (tx: Queryable, storeId: string): Promise<StripeApi> => {
    const code = await storeCodeFor(tx, storeId);
    let credentials: StripeCredentials;
    try {
      credentials = stripeCredentialsFor(code, opts.env ?? process.env);
    } catch (err) {
      // Fail closed at first use with the variable names (never values); the route renders it as a 400.
      throw validationError((err as Error).message, { provider: 'stripe' });
    }
    return opts.apiFactory
      ? opts.apiFactory(credentials)
      : new StripeClient({ secretKey: credentials.secretKey });
  };

  return {
    name: 'stripe',

    /**
     * Creates a manual-capture PaymentIntent for the cart's current total, or updates the intent already on
     * `cart.payment_session` (the storefront re-creates the session right before completing: reusing the intent
     * keeps the mounted Payment Element valid). Metadata carries ids only — no email, no address.
     */
    async createSession({ tx, cart }: CreatePaymentSessionInput): Promise<PaymentSessionResult> {
      const api = await apiFor(tx, cart.storeId);
      const existing = await tx.query<{ payment_session: StorePaymentSession | null }>(
        `SELECT payment_session FROM cart WHERE id = $1`,
        [cart.cartId],
      );
      const session = existing.rows[0]?.payment_session;
      const currency = cart.currency.toLowerCase();

      if (session?.provider === 'stripe' && session.session_id.startsWith('pi_')) {
        try {
          const updated = await api.updatePaymentIntent(session.session_id, {
            amount: cart.amountMinor,
            currency,
          });
          return {
            sessionId: updated.id,
            clientSecret: updated.client_secret,
            status: sessionStatus(updated),
          };
        } catch (err) {
          if (!(err instanceof StripeError) || !err.definitive) throw err;
          // Not updatable (already confirmed or canceled): reuse when it already matches, replace otherwise.
          const intent = await api.retrievePaymentIntent(session.session_id).catch(() => null);
          if (
            intent &&
            AUTHORIZED_STATUSES.includes(intent.status) &&
            intent.amount === cart.amountMinor &&
            intent.currency === currency
          ) {
            return {
              sessionId: intent.id,
              clientSecret: intent.client_secret,
              status: 'authorized',
            };
          }
          if (intent && intent.status !== 'canceled') {
            await api.cancelPaymentIntent(intent.id).catch(() => undefined); // best effort, never blocks
          }
        }
      }

      const created = await api.createPaymentIntent({
        amount: cart.amountMinor,
        currency,
        capture_method: 'manual',
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: {
          cart_id: cart.cartId,
          store_id: cart.storeId,
          organization_id: cart.organizationId,
        },
      });
      return {
        sessionId: created.id,
        clientSecret: created.client_secret,
        status: sessionStatus(created),
      };
    },

    /**
     * Inside the placement transaction: retrieve the intent, verify amount and currency against the cart
     * BEFORE any confirm — a stale session must never place an authorization hold for the wrong total — then
     * confirm server-side only when the intent still awaits confirmation (Stripe idempotency key derived from
     * the placement key: a retried placement can never create a second authorization). Definitive declines →
     * `failed` (402 upstream, nothing written); outages/5xx are rethrown so the placement aborts as retryable.
     */
    async authorize({
      tx,
      cart,
      session,
      idempotencyKey,
    }: AuthorizeInput): Promise<AuthorizeResult> {
      const api = await apiFor(tx, cart.storeId);
      let intent: StripePaymentIntent;
      try {
        intent = await api.retrievePaymentIntent(session.session_id);
      } catch (err) {
        if (err instanceof StripeError && err.definitive) {
          return {
            status: 'failed',
            providerPaymentId: session.session_id,
            failureReason: declineReason(err),
          };
        }
        throw err;
      }
      // The check runs on the retrieved intent, before confirming: an amount can only change while the intent
      // is unconfirmed, so a mismatch caught here is caught before any money is held.
      if (intent.amount !== cart.amountMinor || intent.currency !== cart.currency.toLowerCase()) {
        return {
          status: 'failed',
          providerPaymentId: intent.id,
          failureReason: 'amount mismatch: create a new payment session for the current total',
        };
      }
      if (intent.status === 'requires_confirmation') {
        try {
          intent = await api.confirmPaymentIntent(
            intent.id,
            {},
            { idempotencyKey: confirmIdempotencyKey(idempotencyKey) },
          );
        } catch (err) {
          if (err instanceof StripeError && err.definitive) {
            return {
              status: 'failed',
              providerPaymentId: intent.id,
              failureReason: declineReason(err),
            };
          }
          throw err;
        }
      }
      if (!AUTHORIZED_STATUSES.includes(intent.status)) {
        const reason =
          intent.status === 'requires_payment_method'
            ? (intent.last_payment_error?.decline_code ??
              intent.last_payment_error?.code ??
              'no payment method attached')
            : intent.status === 'requires_action'
              ? 'authentication required (requires_action)'
              : intent.status === 'processing'
                ? 'payment is still processing'
                : `payment intent is ${intent.status}`;
        return { status: 'failed', providerPaymentId: intent.id, failureReason: reason };
      }
      return { status: 'authorized', providerPaymentId: intent.id };
    },

    /**
     * `POST /v1/payment_intents/{id}/cancel` — releases the authorisation hold when an order with an authorised,
     * uncaptured payment is cancelled (orders module 2.3) or a placement fails after authorising. Idempotency key
     * derived from the orders module's `<payment.idempotency_key>:void`, so a retried cancel replays.
     *
     * Already-cancelled is a no-op success: the hold is gone, which is all the caller wants, and a retry after a
     * lost response must not turn into a 402. Already-captured (`succeeded`) is NOT voided — the money left the
     * customer's account and only a refund returns it, which is what window 1's own `cancelOrder` doc says
     * ("a captured payment is window 7's to refund"). It comes back as `failed` with an explicit reason so the
     * cancel is refused loudly instead of cancelling an order that was charged.
     */
    async void({ tx, providerPaymentId, idempotencyKey, reason }: VoidInput): Promise<VoidResult> {
      const payment = await tx.query<{ store_id: string }>(
        `SELECT store_id FROM payment WHERE provider = 'stripe' AND provider_payment_id = $1`,
        [providerPaymentId],
      );
      const storeId = payment.rows[0]?.store_id;
      if (!storeId) return { status: 'failed', failureReason: 'unknown stripe payment' };
      const api = await apiFor(tx, storeId);
      try {
        await api.cancelPaymentIntent(providerPaymentId, {
          idempotencyKey: voidIdempotencyKey(idempotencyKey),
        });
        return { status: 'voided' };
      } catch (err) {
        if (!(err instanceof StripeError) || !err.definitive) throw err; // outage → retryable, abort the cancel
        if (err.code !== UNEXPECTED_STATE)
          return { status: 'failed', failureReason: declineReason(err) };
        // The intent refused the cancel because of its state: ask what that state is before deciding.
        const intent = await api.retrievePaymentIntent(providerPaymentId);
        if (intent.status === 'canceled') return { status: 'voided' }; // already released
        if (intent.status === 'succeeded') {
          return {
            status: 'failed',
            failureReason: `payment was captured (${reason} needs a refund, not a void)`,
          };
        }
        return { status: 'failed', failureReason: `payment intent is ${intent.status}` };
      }
    },

    /**
     * `POST /v1/refunds` on the PaymentIntent with the refund's own idempotency key. The store is resolved from
     * the `payment` row (the input carries only the provider payment id); `pending` counts as succeeded — funds
     * are on their way, the 2.2 webhook receiver picks up a later failure.
     */
    async refund({
      tx,
      providerPaymentId,
      amountMinor,
      idempotencyKey,
      reason,
    }: RefundInput): Promise<RefundResult> {
      const payment = await tx.query<{ store_id: string }>(
        `SELECT store_id FROM payment WHERE provider = 'stripe' AND provider_payment_id = $1`,
        [providerPaymentId],
      );
      const storeId = payment.rows[0]?.store_id;
      if (!storeId) {
        return {
          status: 'failed',
          providerRefundId: null,
          failureReason: 'unknown stripe payment',
        };
      }
      const api = await apiFor(tx, storeId);
      try {
        const refund = await api.createRefund(
          { payment_intent: providerPaymentId, amount: amountMinor, metadata: { reason } },
          { idempotencyKey: `refund_${idempotencyKey}` },
        );
        if (refund.status === 'succeeded' || refund.status === 'pending') {
          return { status: 'succeeded', providerRefundId: refund.id };
        }
        return {
          status: 'failed',
          providerRefundId: refund.id,
          failureReason: refund.failure_reason ?? refund.status,
        };
      } catch (err) {
        if (err instanceof StripeError && err.definitive) {
          return { status: 'failed', providerRefundId: null, failureReason: declineReason(err) };
        }
        throw err;
      }
    },
  };
}
