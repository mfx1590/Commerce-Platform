import type { StripeElementLocale } from '@stripe/stripe-js';

/**
 * The pure parts of the card payment form (#358), kept apart from `src/components/card-payment.tsx`
 * so they can be tested without loading Stripe's React bindings and the server actions behind it.
 */

/** Our locales are `en-GB` / `de-DE`; Stripe takes `en-GB` and `de`. */
export function stripeLocale(locale: string): StripeElementLocale {
  return (locale === 'en-GB' ? 'en-GB' : locale.split('-')[0]) as StripeElementLocale;
}

/**
 * What to tell the customer when Stripe did not authorise the card. An abandoned or failed 3-D Secure
 * challenge (`payment_intent_authentication_failure`) gets our own sentence — it is the one case the
 * customer caused by closing a window, and they should hear that nothing happened and the cart is
 * as it was (manager, #358). Everything else is Stripe's message, written for the customer in their
 * language; a missing message falls back to ours.
 */
export function cardErrorMessage(
  error: { code?: string; message?: string },
  messages: { threeDSecureAbandoned: string; cardFailed: string },
): string {
  if (error.code === 'payment_intent_authentication_failure') return messages.threeDSecureAbandoned;
  return error.message ?? messages.cardFailed;
}
