import { describe, expect, it } from 'vitest';
import {
  envSuffix,
  invoiceAllowed,
  offers,
  paymentOptions,
  stripePublishableKey,
} from '@/lib/payment-options';

/** #358: which payment methods a store offers, from the environment, decided on the server. */
const PK_STORE = 'pk_test_storeword';
const PK_GLOBAL = 'pk_test_globalword';

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

describe('invoiceAllowed', () => {
  it('is off unless STOREFRONT_ALLOW_INVOICE is exactly 1', () => {
    expect(invoiceAllowed({})).toBe(false);
    expect(invoiceAllowed({ STOREFRONT_ALLOW_INVOICE: 'true' })).toBe(false);
    expect(invoiceAllowed({ STOREFRONT_ALLOW_INVOICE: '1' })).toBe(true);
  });
});

describe('offers', () => {
  it('offers only what the store has: card with a key, invoice when allowed', () => {
    const cardOnly = paymentOptions('brand-a', { STRIPE_PUBLISHABLE_KEY: PK_GLOBAL });
    expect(offers(cardOnly, 'stripe')).toBe(true);
    expect(offers(cardOnly, 'manual')).toBe(false);

    const invoiceOnly = paymentOptions('brand-a', { STOREFRONT_ALLOW_INVOICE: '1' });
    expect(offers(invoiceOnly, 'stripe')).toBe(false);
    expect(offers(invoiceOnly, 'manual')).toBe(true);

    expect(offers(cardOnly, 'paypal')).toBe(false);
  });
});

describe('stripeLocale', () => {
  it('maps our locales to the Payment Element’s', async () => {
    const { stripeLocale } = await import('@/components/card-payment');
    expect(stripeLocale('en-GB')).toBe('en-GB');
    expect(stripeLocale('de-DE')).toBe('de');
  });
});
