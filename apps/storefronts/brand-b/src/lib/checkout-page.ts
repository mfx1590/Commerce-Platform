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
    country: store?.default_country ?? 'NL',
  };
}
