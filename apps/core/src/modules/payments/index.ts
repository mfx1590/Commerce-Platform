// Public API of the payments module (window 7). Nothing outside this folder may import from its other files
// (ADR 0005).
import { setPaymentProvider } from '../checkout';
import { createStripePaymentProvider, type StripeProviderOptions } from './provider';

export {
  envSuffix,
  stripeCredentialsFor,
  stripeWebhookSecretFor,
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
 * Registers this module's providers with the checkout module's registry (next to the built-in `manual`).
 * Called once at boot by src/server.ts (REQUEST #176 to window 1). Configuration problems surface at first
 * use per store, not at boot: a store without Stripe keys simply keeps using `manual`.
 */
export function registerPaymentProviders(opts: StripeProviderOptions = {}): void {
  setPaymentProvider(createStripePaymentProvider(opts));
}
