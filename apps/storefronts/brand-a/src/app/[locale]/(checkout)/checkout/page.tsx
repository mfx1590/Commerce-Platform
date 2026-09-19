import { getCart } from '@/lib/cart';
import { isCheckoutable, nextIncompleteStep, stepPath } from '@/lib/checkout';
import { redirectLocalized } from '@/lib/navigate';

export const dynamic = 'force-dynamic';

/** `/checkout` is not a page: it sends the customer to whichever step the cart still needs. */
export default async function CheckoutEntryPage() {
  const cart = await getCart();
  if (!isCheckoutable(cart)) return redirectLocalized('/cart');
  return redirectLocalized(stepPath(nextIncompleteStep(cart)));
}
