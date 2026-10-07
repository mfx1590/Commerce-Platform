import { describe, expect, it, vi } from 'vitest';
import { checkoutEmailDefault } from '@/lib/checkout-email';

/** #351: the address step's email is pre-filled for a signed-in customer — and never breaks. */
describe('checkoutEmailDefault', () => {
  it('keeps what the cart already has, without asking for the customer', async () => {
    const getAccessToken = vi.fn(async () => 'session-word');
    expect(await checkoutEmailDefault('typed@example.com', { getAccessToken })).toBe(
      'typed@example.com',
    );
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('fills in the signed-in customer’s email when the cart has none', async () => {
    const getMeEmail = vi.fn(async () => 'jane@example.com');
    const email = await checkoutEmailDefault(null, {
      getAccessToken: async () => 'session-word',
      getMeEmail,
    });
    expect(email).toBe('jane@example.com');
    expect(getMeEmail).toHaveBeenCalledWith('session-word');
  });

  it('leaves it empty for a guest', async () => {
    const getMeEmail = vi.fn(async () => 'jane@example.com');
    expect(await checkoutEmailDefault(null, { getAccessToken: async () => null, getMeEmail })).toBe(
      '',
    );
    expect(getMeEmail).not.toHaveBeenCalled();
  });

  it('leaves it empty, without throwing, when the lookup fails (stale token, core down)', async () => {
    expect(
      await checkoutEmailDefault(null, {
        getAccessToken: async () => 'session-word',
        getMeEmail: async () => {
          throw new Error('401');
        },
      }),
    ).toBe('');
  });
});
