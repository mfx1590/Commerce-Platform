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
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
vi.mock('@/lib/navigate', () => ({
  redirectLocalized: async (href: string) => ({ redirectedTo: href }),
}));
vi.mock('@/lib/cart', () => ({
  getCart: async () => ({
    id: 'cart_word',
    email: null,
    payment_session: { status: 'pending' },
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
vi.mock('@/lib/store-api', async (importActual) => ({
  ...(await importActual<typeof StoreApiModule>()),
  storeApi: () => ({
    completeCart: mocks.completeCart,
    createPaymentSession: mocks.createPaymentSession,
  }),
}));

const { placeOrderAction } = await import('@/lib/actions');

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
