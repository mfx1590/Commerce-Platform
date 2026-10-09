import { describe, expect, it } from 'vitest';
import {
  orderConfirmationHooks,
  orderLineHooks,
  productCardHooks,
  totalsHooks,
} from '@/lib/test-hooks';

/**
 * The attributes the journey test reads (#304). They are a contract between the pages and
 * `e2e/checkout.spec.ts`: rename one here and the spec stops finding the cart — so the names and
 * the units are pinned, and money is checked to be the API's minor units, never a formatted string.
 */

const money = (amount_minor: number) => ({ amount_minor, currency: 'EUR' });

describe('test hooks', () => {
  it('a line carries its SKU, quantity and line total in minor units', () => {
    expect(orderLineHooks({ sku: 'TEE-M-RED', quantity: 2, total: money(4838) })).toEqual({
      'data-testid': 'order-line',
      'data-sku': 'TEE-M-RED',
      'data-quantity': 2,
      'data-total-minor': 4838,
    });
  });

  it('the totals table carries every amount in minor units, and the currency once', () => {
    expect(
      totalsHooks({
        subtotal: money(1999),
        discount: money(0),
        shipping: money(499),
        tax: money(420),
        total: money(2918),
      }),
    ).toEqual({
      'data-testid': 'order-totals',
      'data-currency': 'EUR',
      'data-subtotal-minor': 1999,
      'data-shipping-minor': 499,
      'data-tax-minor': 420,
      'data-discount-minor': 0,
      'data-total-minor': 2918,
    });
  });

  it('the confirmation carries the order id and the number the customer is told, as text', () => {
    expect(
      orderConfirmationHooks({ id: 'order-uuid', display_id: 1000, status: 'processing' }),
    ).toEqual({
      'data-testid': 'order-confirmation',
      'data-order-id': 'order-uuid',
      'data-order-number': '1000',
      'data-order-status': 'processing',
    });
  });

  it('a product card carries what a sort and a filter act on', () => {
    expect(
      productCardHooks({ handle: 'classic-tee', price: money(1999), category_handle: 't-shirts' }),
    ).toMatchObject({
      'data-testid': 'product-card',
      'data-handle': 'classic-tee',
      'data-price-minor': 1999,
      'data-category': 't-shirts',
    });
    // No category is an empty attribute, not the string "null".
    expect(
      productCardHooks({ handle: 'loose', price: money(500), category_handle: null })[
        'data-category'
      ],
    ).toBe('');
  });
});
