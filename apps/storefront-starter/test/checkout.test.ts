import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_STEPS,
  isCheckoutable,
  isStepReachable,
  mapCheckoutError,
  nextIncompleteStep,
  parseAddressForm,
  stepPath,
} from '@/lib/checkout';
import { formatStoredKey, parseStoredKey } from '@/lib/idempotency';
import { StoreApiError } from '@/lib/store-api';
import type { Cart } from '@/lib/store-api';

const ADDRESS = {
  first_name: 'Jane',
  last_name: 'Doe',
  company: null,
  line1: 'Keizersgracht 1',
  line2: null,
  city: 'Amsterdam',
  region: null,
  postal_code: '1015 CC',
  country: 'NL',
  phone: null,
};

function cart(overrides: Partial<Cart> = {}): Cart {
  return {
    id: 'cart-1',
    status: 'active',
    currency: 'EUR',
    locale: 'en-GB',
    country: 'NL',
    email: null,
    items: [{ id: 'li-1', quantity: 1 }],
    shipping_address: null,
    billing_address: null,
    shipping_option: null,
    promotion_codes: [],
    payment_session: null,
    totals: {},
    order_id: null,
    ...overrides,
  } as unknown as Cart;
}

describe('nextIncompleteStep', () => {
  it('walks the steps as the cart fills in', () => {
    expect(nextIncompleteStep(cart())).toBe('address');
    expect(nextIncompleteStep(cart({ email: 'jane@example.com' }))).toBe('address');
    expect(nextIncompleteStep(cart({ email: 'jane@example.com', shipping_address: ADDRESS }))).toBe(
      'shipping',
    );
    expect(
      nextIncompleteStep(
        cart({
          email: 'jane@example.com',
          shipping_address: ADDRESS,
          shipping_option: { id: 'so-1' },
        } as Partial<Cart>),
      ),
    ).toBe('payment');
    expect(
      nextIncompleteStep(
        cart({
          email: 'jane@example.com',
          shipping_address: ADDRESS,
          shipping_option: { id: 'so-1' },
          payment_session: { status: 'pending' },
        } as Partial<Cart>),
      ),
    ).toBe('review');
  });

  it('sends a failed payment back to the payment step', () => {
    expect(
      nextIncompleteStep(
        cart({
          email: 'jane@example.com',
          shipping_address: ADDRESS,
          shipping_option: { id: 'so-1' },
          payment_session: { status: 'failed' },
        } as Partial<Cart>),
      ),
    ).toBe('payment');
  });
});

describe('isStepReachable', () => {
  const addressed = cart({ email: 'jane@example.com', shipping_address: ADDRESS });
  const delivered = cart({
    email: 'jane@example.com',
    shipping_address: ADDRESS,
    shipping_option: { id: 'so-1' },
  } as Partial<Cart>);

  it('always allows the address step', () => {
    expect(isStepReachable(cart(), 'address')).toBe(true);
  });

  it('refuses to skip ahead of the customer’s own input', () => {
    expect(isStepReachable(cart(), 'shipping')).toBe(false);
    expect(isStepReachable(addressed, 'payment')).toBe(false);
    expect(isStepReachable(addressed, 'review')).toBe(false);
  });

  it('opens delivery once there is an address', () => {
    expect(isStepReachable(addressed, 'shipping')).toBe(true);
  });

  it('opens payment and review once delivery is chosen, without needing a payment session', () => {
    // The session is a PSP artifact created at placement; gating review on it would strand a
    // customer whose session expired between steps.
    expect(delivered.payment_session).toBeNull();
    expect(isStepReachable(delivered, 'payment')).toBe(true);
    expect(isStepReachable(delivered, 'review')).toBe(true);
  });

  it('still points a customer with no session at the payment step', () => {
    expect(nextIncompleteStep(delivered)).toBe('payment');
  });
});

describe('isCheckoutable', () => {
  it('needs an active cart with items', () => {
    expect(isCheckoutable(null)).toBe(false);
    expect(isCheckoutable(cart({ items: [] }))).toBe(false);
    expect(isCheckoutable(cart({ status: 'completed' }))).toBe(false);
    expect(isCheckoutable(cart())).toBe(true);
  });
});

describe('stepPath', () => {
  it('maps every step to its route', () => {
    expect(CHECKOUT_STEPS.map(stepPath)).toEqual([
      '/checkout/address',
      '/checkout/shipping',
      '/checkout/payment',
      '/checkout/review',
    ]);
  });
});

describe('parseAddressForm', () => {
  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  const valid = {
    email: 'jane@example.com',
    first_name: 'Jane',
    last_name: 'Doe',
    line1: 'Keizersgracht 1',
    city: 'Amsterdam',
    postal_code: '1015 CC',
    country: 'nl',
  };

  it('builds a contract-shaped Address and upper-cases the country', () => {
    const result = parseAddressForm(form(valid));
    expect(result.errors).toEqual({});
    expect(result.email).toBe('jane@example.com');
    expect(result.address).toEqual(ADDRESS);
  });

  it('reports every missing required field at once', () => {
    const result = parseAddressForm(form({}));
    expect(result.address).toBeUndefined();
    expect(Object.keys(result.errors).sort()).toEqual([
      'city',
      'country',
      'email',
      'first_name',
      'last_name',
      'line1',
      'postal_code',
    ]);
  });

  it('rejects a malformed email and a non ISO-3166 country', () => {
    expect(parseAddressForm(form({ ...valid, email: 'jane@' })).errors.email).toBeDefined();
    expect(parseAddressForm(form({ ...valid, country: 'NLD' })).errors.country).toBeDefined();
  });

  it('trims whitespace and turns blank optional fields into null', () => {
    const result = parseAddressForm(form({ ...valid, first_name: '  Jane  ', company: '   ' }));
    expect(result.address?.first_name).toBe('Jane');
    expect(result.address?.company).toBeNull();
  });
});

describe('mapCheckoutError', () => {
  const apiError = (status: number, code: string, details = {}, message = '') =>
    new StoreApiError(status, { code, message, details } as never);

  it('turns 409 out_of_stock into the quantity actually left', () => {
    const mapped = mapCheckoutError(apiError(409, 'out_of_stock', { available_quantity: 2 }));
    expect(mapped.availableQuantity).toBe(2);
    expect(mapped.message).toContain('Only 2 left');
  });

  it('says sold out when nothing is left', () => {
    const mapped = mapCheckoutError(apiError(409, 'out_of_stock', { available_quantity: 0 }));
    expect(mapped.availableQuantity).toBe(0);
    expect(mapped.message).toMatch(/sold out/i);
  });

  it('sends 402 payment_failed back to the payment step', () => {
    const mapped = mapCheckoutError(apiError(402, 'payment_failed', {}, 'Card declined'));
    expect(mapped.step).toBe('payment');
    expect(mapped.message).toBe('Card declined');
  });

  it('carries the order id of an already-completed cart', () => {
    const mapped = mapCheckoutError(
      apiError(409, 'cart_completed', { order_id: '30000000-0000-4000-8000-000000000501' }),
    );
    expect(mapped.orderId).toBe('30000000-0000-4000-8000-000000000501');
  });

  it('ignores details of the wrong type', () => {
    const mapped = mapCheckoutError(apiError(409, 'out_of_stock', { available_quantity: 'two' }));
    expect(mapped.availableQuantity).toBeUndefined();
  });

  it('falls back for a non-API failure', () => {
    expect(mapCheckoutError(new Error('socket hang up')).message).toMatch(/went wrong/i);
    expect(mapCheckoutError(new Error('boom')).code).toBe('internal');
  });
});

describe('idempotency key storage', () => {
  it('round-trips a key for its cart', () => {
    const stored = formatStoredKey('cart-1', 'b7f1c0de-1111-2222-3333-444455556666');
    expect(parseStoredKey(stored, 'cart-1')).toBe('b7f1c0de-1111-2222-3333-444455556666');
  });

  it('refuses a key belonging to a different cart, so a new order gets a new key', () => {
    const stored = formatStoredKey('cart-1', 'b7f1c0de-1111-2222-3333-444455556666');
    expect(parseStoredKey(stored, 'cart-2')).toBeUndefined();
  });

  it('rejects a missing, malformed or too-short key', () => {
    expect(parseStoredKey(undefined, 'cart-1')).toBeUndefined();
    expect(parseStoredKey('no-separator', 'cart-1')).toBeUndefined();
    expect(parseStoredKey(':orphan', 'cart-1')).toBeUndefined();
    // The contract requires minLength 8.
    expect(parseStoredKey(formatStoredKey('cart-1', 'short'), 'cart-1')).toBeUndefined();
  });
});
