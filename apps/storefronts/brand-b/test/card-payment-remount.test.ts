// @vitest-environment jsdom
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import enGB from '../messages/en-GB.json';

/**
 * #365 review: react-stripe-js ignores a changed `clientSecret` on a mounted `<Elements>`. After a
 * `409 price_changed` the session — and so the secret — is recreated; the Element must remount with
 * the new one, or "Place order" would confirm the stale PaymentIntent. Stripe itself is mocked: what
 * is under test is that a new secret means a new `<Elements>`.
 */

const mounts = vi.hoisted(() => [] as string[]);

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children, options }: { children: ReactNode; options: { clientSecret: string } }) => {
    useEffect(() => {
      mounts.push(options.clientSecret);
    }, []); // once per mount, on purpose: a re-render with new props is exactly what must not suffice
    return children;
  },
  PaymentElement: () => null,
  useStripe: () => null,
  useElements: () => null,
}));
vi.mock('@stripe/stripe-js', () => ({ loadStripe: () => Promise.resolve(null) }));
vi.mock('@/lib/actions', () => ({ placeOrderAction: async () => ({}) }));

const { CardPayment } = await import('@/components/card-payment');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  mounts.length = 0;
  document.body.innerHTML = '';
});

function view(clientSecret: string) {
  return createElement(NextIntlClientProvider, {
    locale: 'en-GB',
    messages: enGB,
    timeZone: 'Europe/London',
    children: createElement(CardPayment, {
      publishableKey: 'pk_test_word',
      clientSecret,
      locale: 'en-GB',
    }),
  });
}

describe('CardPayment', () => {
  it('remounts the Payment Element when the session’s client secret changes', async () => {
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root.render(view('pi_first_secret_word')));
    await act(async () => root.render(view('pi_second_secret_word')));
    expect(mounts).toEqual(['pi_first_secret_word', 'pi_second_secret_word']);
    await act(async () => root.unmount());
  });

  it('keeps the same Element while the secret stays the same', async () => {
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root.render(view('pi_same_secret_word')));
    await act(async () => root.render(view('pi_same_secret_word')));
    expect(mounts).toEqual(['pi_same_secret_word']);
    await act(async () => root.unmount());
  });
});
