import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreApiError } from '@/lib/store-api';
import type * as StoreApiModule from '@/lib/store-api';

/**
 * `placeOrderAction` end to end inside the server: the action, `asCustomerOrGuest` and
 * `mapCompletionError` together, with only the network, the cookies and the session mocked
 * (#329 review). The unit tests of `mapCompletionError` could not see the defect this guards: the
 * action passed `'guest'` for an error thrown by the customer attempt, so the link-conflict message
 * was unreachable.
 */

const mocks = vi.hoisted(() => ({
  completeCart: vi.fn(),
  createPaymentSession: vi.fn(),
  getAccessToken: vi.fn<() => Promise<string | null>>(),
  clearSession: vi.fn(async () => {}),
  cookies: new Map<string, string>(),
  session: { status: 'pending', provider: 'manual' } as { status: string; provider: string } | null,
  store: { code: 'brand-a' } as { code: string; payment?: { methods: string[] } },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.cookies.has(name) ? { name, value: mocks.cookies.get(name) } : undefined,
    set: (name: string, value: string) => {
      mocks.cookies.set(name, value);
    },
    delete: (name: string) => {
      mocks.cookies.delete(name);
    },
  }),
}));
vi.mock('@/lib/navigate', () => ({
  redirectLocalized: async (href: string) => ({ redirectedTo: href }),
}));
vi.mock('@/lib/cart', () => ({
  getCart: async () => ({
    id: 'cart_word',
    email: null,
    payment_session: mocks.session,
  }),
  getOrCreateCart: vi.fn(),
  clearCart: async () => {},
  refreshCartAttribution: async () => {},
}));
vi.mock('@/lib/idempotency', () => ({
  checkoutIdempotencyKey: async () => 'key-word',
  clearIdempotencyKey: async () => {},
}));
vi.mock('@/lib/auth/session', () => ({
  getAccessToken: mocks.getAccessToken,
  clearSession: mocks.clearSession,
}));
vi.mock('@/lib/store', () => ({ getStoreOrNull: async () => mocks.store }));
vi.mock('@/lib/store-api', async (importActual) => ({
  ...(await importActual<typeof StoreApiModule>()),
  storeApi: () => ({
    completeCart: mocks.completeCart,
    createPaymentSession: mocks.createPaymentSession,
  }),
}));

const { createPaymentSessionAction, placeOrderAction } = await import('@/lib/actions');

const LINK_MESSAGE = /different customer account/;
const GENERIC_CONFLICT = 'Your cart changed while you were checking out. Please review it.';

const conflict = (details?: Record<string, unknown>) =>
  new StoreApiError(409, {
    code: 'conflict',
    message: 'conflict',
    ...(details === undefined ? {} : { details }),
  } as never);
const unauthorized = () => new StoreApiError(401, { code: 'unauthorized', message: 'refused' });

const place = () => placeOrderAction({}, new FormData());

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.session = { status: 'pending', provider: 'manual' };
  mocks.store = { code: 'brand-a' };
  mocks.cookies.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('placeOrderAction — a 409 at completion', () => {
  it('signed in, the customer attempt answered 409 for the cart link: the link-conflict message', async () => {
    mocks.getAccessToken.mockResolvedValue('session-word');
    mocks.completeCart.mockRejectedValue(conflict());

    const state = await place();

    expect(state).toMatchObject({ error: expect.stringMatching(LINK_MESSAGE) });
    expect(mocks.completeCart).toHaveBeenCalledTimes(1);
    expect(mocks.completeCart).toHaveBeenCalledWith('cart_word', 'key-word', {
      token: 'session-word',
    });
    expect(mocks.clearSession).not.toHaveBeenCalled();
  });

  it('signed in, a promotion or key-reuse 409 (with details): the generic text, not the link message', async () => {
    mocks.getAccessToken.mockResolvedValue('session-word');
    for (const details of [
      { promotion_id: 'promo_spring' },
      { 'Idempotency-Key': 'reuse across carts' },
    ]) {
      mocks.completeCart.mockRejectedValueOnce(conflict(details));
      expect(await place()).toEqual({ error: GENERIC_CONFLICT });
    }
  });

  it('as a guest, the same empty-details 409: the generic text', async () => {
    mocks.getAccessToken.mockResolvedValue(null);
    mocks.completeCart.mockRejectedValue(conflict());

    expect(await place()).toEqual({ error: GENERIC_CONFLICT });
    expect(mocks.completeCart).toHaveBeenCalledWith('cart_word', 'key-word', undefined);
  });

  it('after a refused token, a 409 on the guest attempt is read as the guest’s', async () => {
    mocks.getAccessToken.mockResolvedValue('session-word');
    mocks.completeCart.mockRejectedValueOnce(unauthorized()).mockRejectedValueOnce(conflict());

    expect(await place()).toEqual({ error: GENERIC_CONFLICT });
    expect(mocks.clearSession).toHaveBeenCalledTimes(1);
    expect(mocks.completeCart).toHaveBeenCalledTimes(2);
  });

  it('a successful completion still goes to the order', async () => {
    mocks.getAccessToken.mockResolvedValue('session-word');
    mocks.completeCart.mockResolvedValue({ id: 'order_word' });

    expect(await place()).toEqual({ redirectedTo: '/orders/order_word' });
  });
});

/**
 * #358: the payment session decides how an order is placed, and the action never picks a method on
 * the customer's behalf.
 */
describe('placeOrderAction — the payment session (#358)', () => {
  beforeEach(() => {
    mocks.getAccessToken.mockResolvedValue(null);
  });

  it('no session and no recorded choice: back to the payment step, nothing placed', async () => {
    vi.stubEnv('STOREFRONT_ALLOW_INVOICE', '1');
    mocks.session = null;
    expect(await place()).toEqual({ redirectedTo: '/checkout/payment' });
    expect(mocks.createPaymentSession).not.toHaveBeenCalled();
    expect(mocks.completeCart).not.toHaveBeenCalled();
  });

  it('no session, the customer chose invoice for THIS cart: renewed for invoice and placed (Prism keeps no session)', async () => {
    vi.stubEnv('STOREFRONT_ALLOW_INVOICE', '1');
    mocks.session = null;
    mocks.cookies.set('checkout_payment', 'cart_word:manual');
    mocks.completeCart.mockResolvedValue({ id: 'order_word' });
    expect(await place()).toEqual({ redirectedTo: '/orders/order_word' });
    expect(mocks.createPaymentSession).toHaveBeenCalledWith('cart_word', { provider: 'manual' });
  });

  it('no session and an invoice choice made for ANOTHER cart, or a card choice: back to the payment step', async () => {
    vi.stubEnv('STOREFRONT_ALLOW_INVOICE', '1');
    mocks.session = null;
    for (const stored of ['other_cart:manual', 'cart_word:stripe']) {
      mocks.cookies.set('checkout_payment', stored);
      expect(await place(), stored).toEqual({ redirectedTo: '/checkout/payment' });
    }
    expect(mocks.createPaymentSession).not.toHaveBeenCalled();
  });

  it('no session, invoice chosen, but the store no longer offers it: back to the payment step', async () => {
    mocks.session = null;
    mocks.cookies.set('checkout_payment', 'cart_word:manual');
    expect(await place()).toEqual({ redirectedTo: '/checkout/payment' });
    expect(mocks.createPaymentSession).not.toHaveBeenCalled();
  });

  it('a failed card session: back to the payment step with the reason — never an invoice instead', async () => {
    vi.stubEnv('STOREFRONT_ALLOW_INVOICE', '1');
    mocks.session = { status: 'failed', provider: 'stripe' };
    expect(await place()).toEqual({ redirectedTo: '/checkout/payment?error=payment_failed' });
    expect(mocks.createPaymentSession).not.toHaveBeenCalled();
    expect(mocks.completeCart).not.toHaveBeenCalled();
  });

  it('a failed invoice session is renewed when the store allows invoices, then placed', async () => {
    vi.stubEnv('STOREFRONT_ALLOW_INVOICE', '1');
    mocks.session = { status: 'failed', provider: 'manual' };
    mocks.completeCart.mockResolvedValue({ id: 'order_word' });
    expect(await place()).toEqual({ redirectedTo: '/orders/order_word' });
    expect(mocks.createPaymentSession).toHaveBeenCalledWith('cart_word', { provider: 'manual' });
  });

  it('a failed invoice session where invoices are no longer allowed: back to the payment step', async () => {
    mocks.session = { status: 'failed', provider: 'manual' };
    expect(await place()).toEqual({ redirectedTo: '/checkout/payment?error=payment_failed' });
    expect(mocks.completeCart).not.toHaveBeenCalled();
  });

  it('409 price_changed on a card order: the session is refreshed and the review step says why', async () => {
    mocks.session = { status: 'pending', provider: 'stripe' };
    mocks.completeCart.mockRejectedValue(
      new StoreApiError(409, { code: 'price_changed', message: 'price changed' }),
    );
    mocks.createPaymentSession.mockResolvedValue({});
    expect(await place()).toEqual({ redirectedTo: '/checkout/review?error=price_changed' });
    expect(mocks.createPaymentSession).toHaveBeenCalledWith('cart_word', { provider: 'stripe' });
  });

  it('402 payment_failed at completion (a declined card): back to the payment step', async () => {
    mocks.session = { status: 'pending', provider: 'stripe' };
    mocks.completeCart.mockRejectedValue(
      new StoreApiError(402, { code: 'payment_failed', message: 'card_declined' }),
    );
    expect(await place()).toEqual({ redirectedTo: '/checkout/payment?error=payment_failed' });
  });
});

describe('createPaymentSessionAction (#358)', () => {
  it('Store.payment.methods decides when the core sends it — the interim switch is ignored', async () => {
    vi.stubEnv('STOREFRONT_ALLOW_INVOICE', '1');
    mocks.store = { code: 'brand-a', payment: { methods: ['card'] } };
    const form = new FormData();
    form.set('provider', 'manual');
    expect(await createPaymentSessionAction({}, form)).toMatchObject({ error: expect.any(String) });
    expect(mocks.createPaymentSession).not.toHaveBeenCalled();
  });

  const choose = (provider: string) => {
    const form = new FormData();
    form.set('provider', provider);
    return createPaymentSessionAction({}, form);
  };

  it('creates the session for an offered method and moves on to review', async () => {
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY_BRAND_A', 'pk_test_storeword');
    expect(await choose('stripe')).toEqual({ redirectedTo: '/checkout/review' });
    expect(mocks.createPaymentSession).toHaveBeenCalledWith('cart_word', { provider: 'stripe' });
    expect(mocks.cookies.get('checkout_payment'), 'the choice is remembered for this cart').toBe(
      'cart_word:stripe',
    );
  });

  it('refuses a method the store does not offer, whatever the form says', async () => {
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY_BRAND_A', '');
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', '');
    vi.stubEnv('STOREFRONT_ALLOW_INVOICE', '');
    for (const provider of ['stripe', 'manual', 'paypal', '']) {
      expect(await choose(provider), provider).toMatchObject({ error: expect.any(String) });
    }
    expect(mocks.createPaymentSession).not.toHaveBeenCalled();
  });
});
