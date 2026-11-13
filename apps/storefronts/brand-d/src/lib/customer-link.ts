import { clearSession, getAccessToken } from './auth/session';
import { isStoreApiError, type RequestOptions } from './store-api';

/**
 * Make a cart call **as the signed-in customer** when there is one, and as a guest when there is
 * not — or when the core refuses the token (#312, Store API 0.5.1).
 *
 * `createCart` and `completeCart` take an optional customer token: with it the cart, and the order
 * placed from it, are linked to the customer, so the order appears in their history without relying
 * on an email match (which the core allows only for verified emails). Without it the call is a guest
 * call, as it always was.
 *
 * The contract is explicit about a token that is sent but no longer good — invalid, expired, bound
 * to another store, an erased customer: **401, never silently ignored**. For the customer that is a
 * session that has gone stale, not a reason to lose a sale. So the session is dropped and the call
 * is made **once more**, as a guest. Once, not in a loop: a second 401 is a different problem (the
 * publishable key, most likely) and surfaces as such. Both call sites are server actions, where the
 * cookie can be written.
 *
 * Nothing about the token is logged — one line says the core refused it, and no more.
 */

/** Which the call ended up being. The caller needs it to read a 409 at completion correctly. */
export type CartCallMode = 'customer' | 'guest';

export interface CustomerLinkDeps {
  getAccessToken?: () => Promise<string | null>;
  clearSession?: () => Promise<void>;
  warn?: (message: string) => void;
  /**
   * Told the mode of each attempt **before** it is made. The returned `mode` exists only when the
   * call succeeds; a caller that has to read a thrown error — a 409 at completion means something
   * else when a token was sent (#329 review) — learns from this which attempt threw.
   */
  onAttempt?: (mode: CartCallMode) => void;
}

export async function asCustomerOrGuest<T>(
  call: (options: RequestOptions | undefined) => Promise<T>,
  deps: CustomerLinkDeps = {},
): Promise<{ result: T; mode: CartCallMode }> {
  const token = await (deps.getAccessToken ?? getAccessToken)();
  if (token === null) {
    deps.onAttempt?.('guest');
    return { result: await call(undefined), mode: 'guest' };
  }

  try {
    deps.onAttempt?.('customer');
    return { result: await call({ token }), mode: 'customer' };
  } catch (error) {
    if (!(isStoreApiError(error) && error.status === 401)) throw error;
    (deps.warn ?? console.warn)(
      '[storefront] the Store API refused the customer token on a cart call; the session is dropped and the call is made as a guest',
    );
    await (deps.clearSession ?? clearSession)();
    deps.onAttempt?.('guest');
    return { result: await call(undefined), mode: 'guest' };
  }
}
