import type { LineItem, ProductSummary, Totals } from './store-api';

/**
 * Machine-readable hooks on the pages a journey test has to read (#304).
 *
 * The end-to-end suite may not assert on anything that belongs to the dataset — a product name, a
 * price, an order number — so it has to *capture* those from the page and compare them later: the
 * lines and total in the cart against the lines and total on the confirmation. Formatted text is the
 * wrong thing to capture (`€19.99`, `19,99 €` and `EUR 19.99` are one amount), so each of these
 * pages carries the values as attributes, money in **minor units** exactly as the Store API sent it.
 *
 * One definition for cart, review and confirmation on purpose: three hand-written copies would
 * drift, and a test that reads `data-quantity` on one page and finds `data-qty` on the next fails
 * for a reason that has nothing to do with the order.
 *
 * **These attributes ship in production builds** — they are plain markup, not stripped by any
 * build step, and every visitor's browser receives them. So nothing may go into one that the
 * page would not otherwise disclose. Most are already on the same element as text (SKU,
 * quantity, the amounts, the order number). Four are not, and are public for other reasons:
 * `data-order-id` is the id in the confirmation page's own URL; `data-category` is the handle in
 * the category link next to it; `data-availability` and `data-purchasable` restate what the
 * add-to-cart button and the stock note already show. None is a secret; all are, now, a
 * promise to whoever scrapes the page, which is a reason not to add more casually.
 */

type OrderLine = Pick<LineItem, 'sku' | 'quantity' | 'total'>;

/** One line of a cart or an order. */
export function orderLineHooks(item: OrderLine) {
  return {
    'data-testid': 'order-line',
    'data-sku': item.sku,
    'data-quantity': item.quantity,
    'data-total-minor': item.total.amount_minor,
  } as const;
}

/** The totals table of a cart or an order. */
export function totalsHooks(totals: Totals) {
  return {
    'data-testid': 'order-totals',
    'data-currency': totals.total.currency,
    'data-subtotal-minor': totals.subtotal.amount_minor,
    'data-shipping-minor': totals.shipping.amount_minor,
    'data-tax-minor': totals.tax.amount_minor,
    'data-discount-minor': totals.discount.amount_minor,
    'data-total-minor': totals.total.amount_minor,
  } as const;
}

/** The confirmation header: the number the customer is told, and the id in the URL. */
export function orderConfirmationHooks(order: {
  id: string;
  display_id: number | string;
  status: string;
}) {
  return {
    'data-testid': 'order-confirmation',
    'data-order-id': order.id,
    'data-order-number': String(order.display_id),
    // The order's own status, as the API sent it (#372) — the page shows it as text too.
    'data-order-status': order.status,
  } as const;
}

/** A card in a listing: what a sort or a filter is supposed to act on. */
export function productCardHooks(
  product: Pick<ProductSummary, 'handle' | 'price' | 'category_handle'>,
) {
  return {
    'data-testid': 'product-card',
    'data-handle': product.handle,
    'data-price-minor': product.price.amount_minor,
    'data-category': product.category_handle ?? '',
  } as const;
}
