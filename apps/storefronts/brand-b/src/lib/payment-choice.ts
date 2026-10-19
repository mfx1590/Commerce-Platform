import { cookies } from 'next/headers';
import type { PaymentProviderId } from './payment-options';

/**
 * The payment method the customer chose at the payment step, remembered for this cart (#358).
 *
 * The payment session is a PSP artifact with its own lifetime; the *choice* is the customer's. When
 * "Place order" finds no session (it expired, or a backend that keeps none — Prism answers every cart
 * with `payment_session: null`), the session is created again **for the method the customer
 * chose** — never for one picked on their behalf. No recorded choice sends them back to choose.
 *
 * Stored as `<cartId>:<provider>`, like the idempotency key, so a choice made for one cart can
 * never apply to another.
 */

const CHOICE_COOKIE = 'checkout_payment';
const SEPARATOR = ':';
const PROVIDERS: readonly PaymentProviderId[] = ['stripe', 'manual'];

export function formatChoice(cartId: string, provider: PaymentProviderId): string {
  return `${cartId}${SEPARATOR}${provider}`;
}

/** The recorded choice, but only for this cart and only a known provider. */
export function parseChoice(stored: string | undefined, cartId: string): PaymentProviderId | null {
  if (stored === undefined) return null;
  const separator = stored.lastIndexOf(SEPARATOR);
  if (separator <= 0 || stored.slice(0, separator) !== cartId) return null;
  const provider = stored.slice(separator + 1);
  return (PROVIDERS as readonly string[]).includes(provider)
    ? (provider as PaymentProviderId)
    : null;
}

/** Server actions only — writes a cookie. */
export async function rememberPaymentChoice(cartId: string, provider: PaymentProviderId) {
  (await cookies()).set(CHOICE_COOKIE, formatChoice(cartId, provider), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24,
  });
}

export async function paymentChoice(cartId: string): Promise<PaymentProviderId | null> {
  return parseChoice((await cookies()).get(CHOICE_COOKIE)?.value, cartId);
}
