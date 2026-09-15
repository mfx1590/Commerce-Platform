// Public API of the payments module (window 7). Nothing outside this folder may import from its other files
// (ADR 0005).
import { setPaymentProvider } from '../checkout';
import { setRefundRequester } from '../returns';
import { createStripePaymentProvider, type StripeProviderOptions } from './provider';
import { paymentsRefundRequester } from './refund-requester';

export {
  envSuffix,
  stripeCredentialsFor,
  stripeWebhookSecretFor,
  stripeWebhookSecretsFor,
  type StripeCredentials,
} from './credentials';
// Webhook receiver (task 2.2, #125): signature, redacted extract + seal, exactly-once processing, replay.
export {
  computeStripeSignature,
  DEFAULT_TOLERANCE_SECONDS,
  parseStripeSignature,
  signStripePayload,
  verifyStripeSignature,
  type SignatureVerdict,
} from './webhook-signature';
export {
  canonicalJson,
  computeSeal,
  MalformedEventError,
  redactStripeEvent,
  sealExtract,
  sha256Hex,
  verifySeal,
  type ExtractObject,
  type WebhookExtract,
} from './webhook-extract';
export {
  getWebhookEvent,
  handleStripeWebhook,
  IN_FLIGHT_TAKEOVER_SECONDS,
  replayWebhookEvent,
  WEBHOOK_PROVIDER,
  type ReplayOptions,
  type StripeWebhookInput,
  type WebhookEventRow,
  type WebhookEventStatus,
  type WebhookOutcome,
} from './webhook-receiver';
export {
  paymentsWebhookRouter,
  STRIPE_WEBHOOK_BODY_LIMIT,
  STRIPE_WEBHOOK_PATH,
  type PaymentsWebhookRouterOptions,
} from './webhook-router';
// Refunds (task 2.3, #126): Admin API createRefund, the returns module's RefundRequester, webhook settlement.
export {
  createRefund,
  createRefundIn,
  getRefund,
  paymentStatusAfterRefund,
  refundedMinor,
  refundIdempotencyKey,
  renderRefund,
  syncOrderPaymentStatus,
  type AdminRefund,
  type CreateRefundInput,
  type CreateRefundOutcome,
  type RefundReason,
  type RefundRow,
  type RefundStatus,
} from './refunds';
export { paymentsRefundRequester } from './refund-requester';
export { paymentsAdminRouter, REFUNDS_PATH, SUPPORT_REFUND_LIMIT_SETTING } from './refund-router';
export {
  formEncode,
  STRIPE_API_VERSION,
  StripeClient,
  StripeError,
  type StripeApi,
  type StripeBalanceTransaction,
  type StripeCharge,
  type StripeClientOptions,
  type StripeIntentStatus,
  type StripeLastPaymentError,
  type StripeParams,
  type StripePaymentIntent,
  type StripeRefund,
  type StripeRequestOptions,
} from './stripe-client';
export { FakeStripe, type FakeCall } from './fake-stripe';
export {
  confirmIdempotencyKey,
  createStripePaymentProvider,
  voidIdempotencyKey,
  type StripeProviderOptions,
} from './provider';
export {
  capturePayment,
  type CapturePaymentOptions,
  type CapturePaymentResult,
  type PaymentRow,
} from './capture';

/**
 * Registers this module's providers with the checkout module's registry (next to the built-in `manual`) and
 * this module's `RefundRequester` with the returns module (return-driven refunds write `refund` rows + events
 * here, task 2.3). Called once at boot by src/server.ts (REQUEST #176 to window 1). Configuration problems
 * surface at first use per store, not at boot: a store without Stripe keys simply keeps using `manual`.
 */
export function registerPaymentProviders(opts: StripeProviderOptions = {}): void {
  setPaymentProvider(createStripePaymentProvider(opts));
  setRefundRequester(paymentsRefundRequester);
}
