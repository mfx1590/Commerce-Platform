import { describe, expect, it, vi } from 'vitest';
import { asCustomerOrGuest } from '@/lib/customer-link';
import { StoreApiError, type RequestOptions } from '@/lib/store-api';

/**
 * #312. A cart call is made as the signed-in customer when there is one, and as a guest otherwise
 * — or after the core has refused the token, exactly once. The rules here are the ones the contract
 * (Store API 0.5.1, #310) makes sharp: a token that is sent is never ignored, so a 401 is a stale
 * session and not a reason to lose the sale; and "retry as a guest" is one retry, never a loop.
 */

const unauthorized = () =>
  new StoreApiError(401, { code: 'unauthorized', message: 'token refused' });
const conflict = () => new StoreApiError(409, { code: 'conflict', message: 'linked elsewhere' });

function harness(token: string | null) {
  const calls: (RequestOptions | undefined)[] = [];
  const clearSession = vi.fn(async () => {});
  const warn = vi.fn();
  const deps = { getAccessToken: async () => token, clearSession, warn };
  return { calls, clearSession, warn, deps };
}

describe('asCustomerOrGuest', () => {
  it('calls as the customer, with the token, when there is a session', async () => {
    const { calls, clearSession, deps } = harness('jwt-abc');

    const outcome = await asCustomerOrGuest(async (options) => {
      calls.push(options);
      return 'cart-1';
    }, deps);

    expect(outcome).toEqual({ result: 'cart-1', mode: 'customer' });
    expect(calls).toEqual([{ token: 'jwt-abc' }]);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('calls as a guest, with no token at all, when there is no session', async () => {
    const { calls, deps } = harness(null);

    const outcome = await asCustomerOrGuest(async (options) => {
      calls.push(options);
      return 'cart-1';
    }, deps);

    expect(outcome).toEqual({ result: 'cart-1', mode: 'guest' });
    expect(calls).toEqual([undefined]);
  });

  it('on a 401 drops the session and calls once more as a guest', async () => {
    const { calls, clearSession, warn, deps } = harness('jwt-stale');

    const outcome = await asCustomerOrGuest(async (options) => {
      calls.push(options);
      if (options?.token !== undefined) throw unauthorized();
      return 'cart-2';
    }, deps);

    expect(outcome).toEqual({ result: 'cart-2', mode: 'guest' });
    expect(calls).toEqual([{ token: 'jwt-stale' }, undefined]);
    expect(clearSession).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('never loops: a second 401 is the caller’s to handle', async () => {
    const { calls, clearSession, deps } = harness('jwt-stale');

    await expect(
      asCustomerOrGuest(async (options) => {
        calls.push(options);
        throw unauthorized();
      }, deps),
    ).rejects.toMatchObject({ status: 401 });

    expect(calls).toHaveLength(2);
    expect(clearSession).toHaveBeenCalledOnce();
  });

  it('lets any other failure through untouched, session intact', async () => {
    const { calls, clearSession, deps } = harness('jwt-abc');

    await expect(
      asCustomerOrGuest(async (options) => {
        calls.push(options);
        throw conflict();
      }, deps),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });

    expect(calls).toEqual([{ token: 'jwt-abc' }]);
    expect(clearSession).not.toHaveBeenCalled();
  });

  it('logs nothing that could identify the customer', async () => {
    const { warn, deps } = harness('jwt-secret-value');

    await asCustomerOrGuest(async (options) => {
      if (options?.token !== undefined) throw unauthorized();
      return 'cart-3';
    }, deps);

    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).not.toContain('jwt-secret-value');
    expect(logged).toMatch(/refused the customer token/);
  });
});
