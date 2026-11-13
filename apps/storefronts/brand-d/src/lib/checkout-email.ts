import { getAccessToken } from './auth/session';
import { storeApi } from './store-api';

/**
 * The email to pre-fill in the checkout's address step (#351).
 *
 * The cart's own email wins — it is what the customer already typed. Otherwise, for a signed-in
 * customer, the account's email (`GET /store/customers/me`). Cosmetic: the field stays editable,
 * nothing is saved until the customer submits, and any failure (no session, a stale token, the
 * core unreachable) just leaves the field empty — never an error on the checkout. Server-only; only
 * the email reaches the form, never the token.
 */
export interface CheckoutEmailDeps {
  getAccessToken?: () => Promise<string | null>;
  getMeEmail?: (token: string) => Promise<string | null>;
}

export async function checkoutEmailDefault(
  cartEmail: string | null,
  deps: CheckoutEmailDeps = {},
): Promise<string> {
  if (cartEmail !== null && cartEmail !== '') return cartEmail;
  try {
    const token = await (deps.getAccessToken ?? getAccessToken)();
    if (token === null) return '';
    const email = await (deps.getMeEmail ?? meEmail)(token);
    return email ?? '';
  } catch {
    return '';
  }
}

async function meEmail(token: string): Promise<string | null> {
  const me = await storeApi().getMe({ token, cache: 'no-store' });
  return me.email ?? null;
}
