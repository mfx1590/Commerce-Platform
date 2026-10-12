import { describe, expect, it } from 'vitest';
import { envSuffix, offers, paymentOptions, stripePublishableKey } from '@/lib/payment-options';

/** #358: which payment methods a store offers, from the environment, decided on the server. */
const PK_STORE = 'pk_test_storeword';
const PK_GLOBAL = 'pk_test_globalword';
/** A store that says which methods it allows (Store API 0.5.4). */
const withMethods = (...methods: ('card' | 'invoice')[]) => ({
  code: 'brand-a',
  payment: { methods },
});

describe('stripePublishableKey', () => {
  it('names the variable like the core does: brand-a → BRAND_A', () => {
    expect(envSuffix('brand-a')).toBe('BRAND_A');
    expect(stripePublishableKey('brand-a', { STRIPE_PUBLISHABLE_KEY_BRAND_A: PK_STORE })).toBe(
      PK_STORE,
    );
  });

  it('prefers the store’s key, falls back to the global one, else none', () => {
    const env = { STRIPE_PUBLISHABLE_KEY_BRAND_A: PK_STORE, STRIPE_PUBLISHABLE_KEY: PK_GLOBAL };
    expect(stripePublishableKey('brand-a', env)).toBe(PK_STORE);
    expect(stripePublishableKey('brand-b', env)).toBe(PK_GLOBAL);
    expect(stripePublishableKey(null, env)).toBe(PK_GLOBAL);
    expect(stripePublishableKey('brand-a', {})).toBeNull();
    expect(stripePublishableKey('brand-a', { STRIPE_PUBLISHABLE_KEY_BRAND_A: '' })).toBeNull();
  });

  it('never hands a secret key (or anything not publishable) to the browser', () => {
    for (const wrong of [
      'sk_test_secretword',
      'rk_test_restrictedword',
      'whsec_word',
      'pk_test_',
    ]) {
      expect(
        stripePublishableKey('brand-a', { STRIPE_PUBLISHABLE_KEY_BRAND_A: wrong }),
        wrong,
      ).toBe(null);
    }
  });
});

describe('paymentOptions', () => {
  const KEY = { STRIPE_PUBLISHABLE_KEY_BRAND_A: PK_STORE };

  it('a store without Store.payment (a core before 0.5.4): card on the key alone, never an invoice', () => {
    const store = { code: 'brand-a' };
    expect(paymentOptions(store, KEY)).toEqual({ stripePublishableKey: PK_STORE, invoice: false });
    expect(paymentOptions(store, { STOREFRONT_ALLOW_INVOICE: '1' })).toEqual({
      stripePublishableKey: null,
      invoice: false,
    });
  });

  it('a store with Store.payment.methods: the store decides', () => {
    const both = withMethods('card', 'invoice');
    expect(paymentOptions(both, KEY)).toEqual({ stripePublishableKey: PK_STORE, invoice: true });

    const cardOnly = withMethods('card');
    expect(paymentOptions(cardOnly, KEY).invoice).toBe(false);

    const invoiceOnly = withMethods('invoice');
    expect(paymentOptions(invoiceOnly, KEY).stripePublishableKey, 'card not offered').toBeNull();

    const none = withMethods();
    expect(paymentOptions(none, KEY)).toEqual({
      stripePublishableKey: null,
      invoice: false,
    });
  });

  it('card needs both: the store saying card AND a publishable key here', () => {
    const card = withMethods('card');
    expect(paymentOptions(card, {}).stripePublishableKey).toBeNull();
  });
});

describe('offers', () => {
  it('offers only what the options hold, nothing else', () => {
    const cardOnly = paymentOptions({ code: 'brand-a' }, { STRIPE_PUBLISHABLE_KEY: PK_GLOBAL });
    expect(offers(cardOnly, 'stripe')).toBe(true);
    expect(offers(cardOnly, 'manual')).toBe(false);

    const invoiceOnly = paymentOptions(withMethods('invoice'), {});
    expect(offers(invoiceOnly, 'stripe')).toBe(false);
    expect(offers(invoiceOnly, 'manual')).toBe(true);

    expect(offers(cardOnly, 'paypal')).toBe(false);
  });
});

describe('stripeLocale', () => {
  it('maps our locales to the Payment Element’s', async () => {
    const { stripeLocale } = await import('@/lib/card-payment-messages');
    expect(stripeLocale('en-GB')).toBe('en-GB');
    expect(stripeLocale('de-DE')).toBe('de');
  });
});

describe('cardErrorMessage', () => {
  const messages = { threeDSecureAbandoned: '3ds-abandoned', cardFailed: 'card-failed' };

  it('an abandoned 3-D Secure gets our recoverable sentence (#358)', async () => {
    const { cardErrorMessage } = await import('@/lib/card-payment-messages');
    expect(
      cardErrorMessage(
        { code: 'payment_intent_authentication_failure', message: 'Stripe text' },
        messages,
      ),
    ).toBe('3ds-abandoned');
  });

  it('anything else is Stripe’s own message, or ours when Stripe gives none', async () => {
    const { cardErrorMessage } = await import('@/lib/card-payment-messages');
    expect(
      cardErrorMessage({ code: 'card_declined', message: 'Your card was declined.' }, messages),
    ).toBe('Your card was declined.');
    expect(cardErrorMessage({ code: 'card_declined' }, messages)).toBe('card-failed');
  });
});
