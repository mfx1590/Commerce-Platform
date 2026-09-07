import { cookies } from 'next/headers';
import { cache } from 'react';
import { getCurrency } from './i18n';
import { getStoreOrNull } from './store';
import { isNotFound, storeApi, type Cart } from './store-api';

/**
 * Cart session. The cart lives in the API; the browser only carries its id in an httpOnly cookie,
 * so nothing about pricing or stock is client-controlled.
 *
 * Reading is safe anywhere; **writing a cookie is only allowed in a server action or route
 * handler**, which is why creating a cart is a separate function from reading one.
 */

const CART_COOKIE = 'cart_id';
/** A cart is worth keeping across visits, but not forever — the API abandons stale carts anyway. */
const CART_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  secure: process.env.NODE_ENV === 'production',
} as const;

export async function readCartId(): Promise<string | undefined> {
  return (await cookies()).get(CART_COOKIE)?.value;
}

/** Deduped per render, so the cart page and its summary do not fetch the cart twice. */
export const getCart = cache(async (): Promise<Cart | null> => {
  const cartId = await readCartId();
  if (cartId === undefined) return null;

  try {
    const cart = await storeApi().getCart(cartId, { cache: 'no-store' });
    // A completed cart must not come back to life as the customer's active cart.
    return cart.status === 'active' ? cart : null;
  } catch (error) {
    // Expired, abandoned, or from another store: treat as no cart rather than a hard failure.
    if (isNotFound(error)) return null;
    throw error;
  }
});

/**
 * The cart to mutate. Server actions only — it writes the cookie.
 * The currency and country come from the store, so the cart is created in the market it belongs to.
 */
export async function getOrCreateCart(): Promise<Cart> {
  const existing = await getCart();
  if (existing) return existing;

  const store = await getStoreOrNull();
  // The currency is the customer's choice reconciled against what the store sells in; the contract
  // fixes it at creation, so it has to be right here rather than patched later.
  const currency = await getCurrency(store);
  const cart = await storeApi().createCart({
    currency,
    ...(store === null ? {} : { country: store.default_country, locale: store.default_locale }),
  });

  (await cookies()).set(CART_COOKIE, cart.id, {
    ...COOKIE_OPTIONS,
    maxAge: CART_COOKIE_MAX_AGE_SECONDS,
  });
  return cart;
}

/** After an order is placed the cart is spent; the next visit starts a fresh one. */
export async function clearCart(): Promise<void> {
  (await cookies()).delete(CART_COOKIE);
}

export function cartItemCount(cart: Cart | null): number {
  return cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
}
