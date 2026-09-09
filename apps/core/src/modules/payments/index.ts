// Public API of the payments module (window 7). Nothing outside this folder may import from its other files
// (ADR 0005).
import { setPaymentProvider } from '../checkout';
import { createStripePaymentProvider, type StripeProviderOptions } from './provider';

export { envSuffix, stripeCredentialsFor, type StripeCredentials } from './credentials';
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
