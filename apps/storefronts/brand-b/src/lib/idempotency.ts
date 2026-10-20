import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * One idempotency key per checkout attempt, reused on every retry.
 *
 * The contract requires `Idempotency-Key` on `POST …/complete` so a retry after a timeout cannot
 * charge twice. The key is stored with the cart id it belongs to: a different cart always gets a
 * fresh key, so a stale cookie can never make a new order collide with an old one.
 */

const KEY_COOKIE = 'checkout_key';
const SEPARATOR = ':';

/** `<cartId>:<key>` — the cart id is part of the value so it can be validated on read. */
export function formatStoredKey(cartId: string, key: string): string {
  return `${cartId}${SEPARATOR}${key}`;
}

/** The stored key, but only if it belongs to this cart. */
export function parseStoredKey(stored: string | undefined, cartId: string): string | undefined {
  if (stored === undefined) return undefined;
  const separator = stored.indexOf(SEPARATOR);
  if (separator <= 0) return undefined;
  if (stored.slice(0, separator) !== cartId) return undefined;
  const key = stored.slice(separator + 1);
  // The contract requires at least 8 characters; anything shorter is a corrupted cookie.
  return key.length >= 8 ? key : undefined;
}

/** Server actions only — it may write the cookie. */
export async function checkoutIdempotencyKey(cartId: string): Promise<string> {
  const jar = await cookies();
  const existing = parseStoredKey(jar.get(KEY_COOKIE)?.value, cartId);
  if (existing !== undefined) return existing;

  const key = randomUUID();
  jar.set(KEY_COOKIE, formatStoredKey(cartId, key), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24,
  });
  return key;
}

export async function clearIdempotencyKey(): Promise<void> {
  (await cookies()).delete(KEY_COOKIE);
}
