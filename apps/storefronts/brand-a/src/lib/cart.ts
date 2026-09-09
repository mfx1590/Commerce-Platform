import { getLocale } from 'next-intl/server';
import { cookies } from 'next/headers';
import { cache } from 'react';
import {
  ATTRIBUTION_COOKIE,
  metadataFor,
  parseAttribution,
  type CartMetadata,
} from './attribution';
import { getCurrency } from './i18n';
import { getStoreOrNull } from './store';
import { isNotFound, storeApi, type Body, type Cart } from './store-api';

/** The attribution captured by the middleware, ready for `cart.metadata`. */
export async function cartMetadata(): Promise<CartMetadata | undefined> {
  const raw = (await cookies()).get(ATTRIBUTION_COOKIE)?.value;
  return metadataFor(parseAttribution(raw));
}

/**
 * Re-send the attribution just before the order is placed, so the last touch is the campaign that
 * closed the sale rather than the one that created the cart. `POST …/complete` takes no body, so
 * the cart is where it has to go.
 *
 * Never fatal: losing a marketing attribute must not cost the order.
 */
export async function refreshCartAttribution(cartId: string): Promise<void> {
  const metadata = await cartMetadata();
  if (metadata === undefined) return;

  const body: Body<'updateCart'> = { metadata };
  try {
    await storeApi().updateCart(cartId, body);
  } catch (error) {
    console.warn('[storefront] could not refresh cart attribution:', error);
  }
}

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
 *
 * Currency and locale are the customer's own choices, not the store's defaults: the contract fixes
 * both at creation, so a `/de-DE` shopper paying in GBP must have that cart created as `de-DE`/`GBP`
 * rather than the store's `en-GB`/`EUR`. Country stays the store's — it is the market, not a
 * preference, and the delivery address decides where it actually ships.
 */
export async function getOrCreateCart(): Promise<Cart> {
  const existing = await getCart();
  if (existing) return existing;

  const store = await getStoreOrNull();
  const [currency, locale, metadata] = await Promise.all([
    getCurrency(store),
    getLocale(),
    cartMetadata(),
  ]);
  const body: Body<'createCart'> = {
    currency,
    locale,
    ...(store === null ? {} : { country: store.default_country }),
    ...(metadata === undefined ? {} : { metadata }),
  };
  const cart = await storeApi().createCart(body);

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
