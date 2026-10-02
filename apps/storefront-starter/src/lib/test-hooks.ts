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
 * Nothing here is secret or new: every value is already rendered on the same element as text.
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
export function orderConfirmationHooks(order: { id: string; display_id: number | string }) {
  return {
    'data-testid': 'order-confirmation',
    'data-order-id': order.id,
    'data-order-number': String(order.display_id),
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
