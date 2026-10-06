'use client';

import { Button } from '@platform/ui';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useTranslations } from 'next-intl';
import { startTransition, useActionState, useState, type FormEvent } from 'react';
import { placeOrderAction, type ActionState } from '@/lib/actions';
import { cardErrorMessage, stripeLocale } from '@/lib/card-payment-messages';

/**
 * Card payment on the review step (#358): Stripe's Payment Element — hosted fields in Stripe's
 * iframes, so card data never reaches this app — and the "Place order" button that confirms it.
 *
 * The order of things is the contract with the core: the core's `stripe` session is a manual-capture
 * PaymentIntent with redirects off, and at completion the core counts `requires_capture` as
 * authorised and anything still `requires_action` as failed. So the browser confirms first
 * (3-D Secure, if the card needs it, happens in Stripe's own modal), and only an intent that is
 * authorised goes on to `placeOrderAction` — with the cart's one idempotency key, so a retry can
 * never place a second order. An intent that is already authorised (a retry after the placement
 * failed on the network) is not confirmed again.
 *
 * Declines, an abandoned 3-D Secure and validation errors come back from Stripe as messages written
 * for the customer, in their language; they are shown as they are and the customer can try again.
 */

const EMPTY: ActionState = {};
const AUTHORISED = new Set(['requires_capture', 'succeeded']);

/** One Stripe.js instance per key for the life of the page (Stripe asks for exactly this). */
const stripeByKey = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string): Promise<Stripe | null> {
  let stripe = stripeByKey.get(publishableKey);
  if (stripe === undefined) {
    stripe = loadStripe(publishableKey);
    stripeByKey.set(publishableKey, stripe);
  }
  return stripe;
}

export function CardPayment({
  publishableKey,
  clientSecret,
  locale,
}: {
  publishableKey: string;
  clientSecret: string;
  locale: string;
}) {
  return (
    <Elements
      stripe={stripeFor(publishableKey)}
      options={{ clientSecret, locale: stripeLocale(locale) }}
    >
      <CardPaymentForm clientSecret={clientSecret} />
    </Elements>
  );
}

function CardPaymentForm({ clientSecret }: { clientSecret: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const t = useTranslations('checkout.review');
  const [state, formAction, placing] = useActionState(placeOrderAction, EMPTY);
  const [cardError, setCardError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const busy = confirming || placing;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stripe === null || elements === null || busy) return;
    setCardError(null);
    setConfirming(true);
    try {
      const current = await stripe.retrievePaymentIntent(clientSecret);
      if (current.paymentIntent === undefined || !AUTHORISED.has(current.paymentIntent.status)) {
        const { error, paymentIntent } = await stripe.confirmPayment({
          elements,
          redirect: 'if_required',
          // Required by Stripe even with redirects off; card flows never leave the page.
          confirmParams: { return_url: window.location.href },
        });
        if (error !== undefined) {
          setCardError(
            cardErrorMessage(error, {
              threeDSecureAbandoned: t('threeDSecureAbandoned'),
              cardFailed: t('cardFailed'),
            }),
          );
          return;
        }
        if (paymentIntent === undefined || !AUTHORISED.has(paymentIntent.status)) {
          setCardError(t('cardFailed'));
          return;
        }
      }
      startTransition(() => formAction(new FormData()));
    } finally {
      setConfirming(false);
    }
  }

  const message = cardError ?? state.error;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" data-testid="card-payment">
      {message === undefined || message === null ? null : (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {message}
        </p>
      )}
      <PaymentElement options={{ layout: 'tabs' }} />
      <Button type="submit" size="lg" disabled={stripe === null || busy} loading={busy}>
        {t('placeOrder')}
      </Button>
      <p className="text-sm text-muted-foreground">{t('cardNote')}</p>
    </form>
  );
}
