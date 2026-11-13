import { getLocale as getLocaleForFormatting } from 'next-intl/server';
import { redirectLocalized } from './navigate';
import { getCart } from './cart';
import {
  isCheckoutable,
  isStepReachable,
  nextIncompleteStep,
  stepPath,
  type CheckoutStep,
} from './checkout';
import { getStoreOrNull } from './store';
import type { Cart } from './store-api';
import { firstText } from './text';

export interface CheckoutContext {
  cart: Cart;
  locale: string;
  country: string;
}

/**
 * Guard for every checkout step page. The step order is enforced on the server, not by hiding
 * links: a customer who types `/checkout/review` with no address is sent to the address step
 * instead of reaching a page that could place an incomplete order.
 */
export async function requireCheckoutStep(step: CheckoutStep): Promise<CheckoutContext> {
  const cart = await getCart();
  if (!isCheckoutable(cart)) return redirectLocalized('/cart');
  if (!isStepReachable(cart, step)) {
    return redirectLocalized(stepPath(nextIncompleteStep(cart)));
  }

  const store = await getStoreOrNull();
  return {
    // Formatting follows the locale the customer is reading, which is the one in the URL.
    cart,
    locale: await getLocaleForFormatting(),
    country: checkoutCountry(store, cart),
  };
}

/** The pre-filled country when the store cannot be read at all (unchanged behaviour). */
export const UNREACHABLE_STORE_COUNTRY = 'NL';

/**
 * The country the address form starts on (#846 review). The store's `default_country`, else the
 * cart's own `country` (required on `Cart`; the destination it was priced for), else nothing, so
 * the customer must choose. Never a hard-coded country for a store that answered: a blank
 * `default_country` pre-filling "NL" let a Japanese customer save an NL address unnoticed, which
 * picks the wrong shipping options and tax. `UNREACHABLE_STORE_COUNTRY` only when `store` is null.
 */
export function checkoutCountry(
  store: { default_country?: string | null } | null,
  cart: { country?: string | null },
): string {
  if (store === null) return UNREACHABLE_STORE_COUNTRY;
  return firstText(store.default_country, cart.country) ?? '';
}
