import { describe, expect, it } from 'vitest';
import type { Product, Variant } from '@/lib/store-api';
import {
  availability,
  defaultSelection,
  findVariant,
  isPurchasable,
  LOW_STOCK_THRESHOLD,
  mediaFor,
  optionNames,
  reachableValues,
  selectionOf,
  withOption,
} from '@/lib/variant';

function variant(overrides: Partial<Variant> & { options: Record<string, string> }): Variant {
  return {
    id: `v-${Object.values(overrides.options).join('-')}`,
    sku: `SKU-${Object.values(overrides.options).join('-')}`,
    title: Object.values(overrides.options).join(' / '),
    price: { amount_minor: 1999, currency: 'EUR' },
    compare_at_price: null,
    in_stock: true,
    available_quantity: 50,
    allow_backorder: false,
    ...overrides,
  };
}

/** Size S/M/L × Colour Blue/Black, with "S / Black" deliberately missing from the matrix. */
function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-1',
    handle: 'classic-tee',
    title: 'Classic Tee',
    subtitle: null,
    description: null,
    status: 'published',
    category: null,
    brand_name: null,
    tags: [],
    attributes: {},
    seo: {},
    options: [
      { name: 'Size', values: ['S', 'M', 'L'] },
      { name: 'Colour', values: ['Blue', 'Black'] },
    ],
    variants: [
      variant({ options: { Size: 'S', Colour: 'Blue' } }),
      variant({ options: { Size: 'M', Colour: 'Blue' } }),
      variant({ options: { Size: 'M', Colour: 'Black' } }),
      variant({ options: { Size: 'L', Colour: 'Black' } }),
    ],
    media: [],
    ...overrides,
  } as Product;
}

describe('findVariant', () => {
  it('resolves a complete selection to its variant', () => {
    const found = findVariant(product(), { Size: 'M', Colour: 'Black' });
    expect(found?.sku).toBe('SKU-M-Black');
  });

  it('returns undefined for a partial selection', () => {
    expect(findVariant(product(), { Size: 'M' })).toBeUndefined();
  });

  it('returns undefined for a combination that does not exist', () => {
    expect(findVariant(product(), { Size: 'S', Colour: 'Black' })).toBeUndefined();
  });

  it('ignores extra keys that are not product options', () => {
    expect(findVariant(product(), { Size: 'L', Colour: 'Black', Gift: 'yes' })?.sku).toBe(
      'SKU-L-Black',
    );
  });

  it('handles a product with a single option', () => {
    const single = product({
      options: [{ name: 'Size', values: ['One size'] }],
      variants: [variant({ options: { Size: 'One size' } })],
    });
    expect(findVariant(single, { Size: 'One size' })?.sku).toBe('SKU-One size');
  });
});

describe('isPurchasable', () => {
  it('is false without a variant', () => {
    expect(isPurchasable(undefined)).toBe(false);
  });

  it('is true for stock on hand and for unmanaged inventory', () => {
    expect(isPurchasable(variant({ options: {}, available_quantity: 3 }))).toBe(true);
    expect(isPurchasable(variant({ options: {}, available_quantity: null }))).toBe(true);
  });

  it('is false when the variant is out of stock', () => {
    expect(isPurchasable(variant({ options: {}, in_stock: false, available_quantity: 0 }))).toBe(
      false,
    );
    expect(isPurchasable(variant({ options: {}, in_stock: true, available_quantity: 0 }))).toBe(
      false,
    );
  });

  it('is true when backorder is allowed, even with no stock', () => {
    expect(
      isPurchasable(
        variant({ options: {}, in_stock: false, available_quantity: 0, allow_backorder: true }),
      ),
    ).toBe(true);
  });
});

describe('availability', () => {
  it('reports in stock, low stock, backorder and out of stock', () => {
    expect(availability(variant({ options: {}, available_quantity: 50 }))).toEqual({
      state: 'in_stock',
    });
    expect(availability(variant({ options: {}, available_quantity: null }))).toEqual({
      state: 'in_stock',
    });
    expect(availability(variant({ options: {}, available_quantity: LOW_STOCK_THRESHOLD }))).toEqual(
      {
        state: 'low_stock',
        quantity: LOW_STOCK_THRESHOLD,
      },
    );
    expect(
      availability(
        variant({ options: {}, in_stock: false, available_quantity: 0, allow_backorder: true }),
      ),
    ).toEqual({ state: 'backorder' });
    expect(availability(variant({ options: {}, in_stock: false, available_quantity: 0 }))).toEqual({
      state: 'out_of_stock',
    });
    expect(availability(undefined)).toEqual({ state: 'out_of_stock' });
  });
});

describe('defaultSelection', () => {
  it('picks the first purchasable variant', () => {
    const p = product({
      variants: [
        variant({ options: { Size: 'S', Colour: 'Blue' }, in_stock: false, available_quantity: 0 }),
        variant({ options: { Size: 'M', Colour: 'Blue' } }),
      ],
    });
    expect(defaultSelection(p)).toEqual({ Size: 'M', Colour: 'Blue' });
  });

  it('falls back to the first variant when everything is sold out', () => {
    const p = product({
      variants: [
        variant({ options: { Size: 'S', Colour: 'Blue' }, in_stock: false, available_quantity: 0 }),
        variant({ options: { Size: 'M', Colour: 'Blue' }, in_stock: false, available_quantity: 0 }),
      ],
    });
    expect(defaultSelection(p)).toEqual({ Size: 'S', Colour: 'Blue' });
  });

  it('is empty for a product with no variants', () => {
    expect(defaultSelection(product({ variants: [] }))).toEqual({});
  });
});

describe('reachableValues', () => {
  it('lists every value when nothing else is chosen', () => {
    expect([...reachableValues(product(), {}, 'Size')].sort()).toEqual(['L', 'M', 'S']);
  });

  it('narrows to the values that exist with the other choices held fixed', () => {
    expect([...reachableValues(product(), { Colour: 'Black' }, 'Size')].sort()).toEqual(['L', 'M']);
    expect([...reachableValues(product(), { Size: 'S' }, 'Colour')]).toEqual(['Blue']);
  });
});

describe('withOption', () => {
  it('keeps the rest of the selection when the combination exists', () => {
    expect(withOption(product(), { Size: 'M', Colour: 'Blue' }, 'Colour', 'Black')).toEqual({
      Size: 'M',
      Colour: 'Black',
    });
  });

  it('drops an option the new choice makes impossible instead of getting stuck', () => {
    // "S / Black" does not exist, so choosing S clears the colour rather than selecting nothing.
    expect(withOption(product(), { Size: 'M', Colour: 'Black' }, 'Size', 'S')).toEqual({
      Size: 'S',
    });
  });
});

describe('selectionOf and optionNames', () => {
  it('round-trips a variant through its selection', () => {
    const target = product().variants[2]!;
    expect(findVariant(product(), selectionOf(target))?.sku).toBe(target.sku);
    expect(optionNames(product())).toEqual(['Size', 'Colour']);
  });
});

describe('mediaFor', () => {
  const media = [
    { url: 'shared-1.jpg', alt: null, position: 1, variant_id: null },
    { url: 'blue.jpg', alt: 'Blue', position: 0, variant_id: 'v-M-Blue' },
    { url: 'black.jpg', alt: 'Black', position: 0, variant_id: 'v-M-Black' },
  ];

  it('puts the variant’s own images first, then the shared ones, by position', () => {
    const p = product({ media });
    const chosen = findVariant(p, { Size: 'M', Colour: 'Blue' });
    expect(mediaFor(p, chosen).map((m) => m.url)).toEqual(['blue.jpg', 'shared-1.jpg']);
  });

  it('falls back to every image when no variant is resolved', () => {
    const p = product({ media });
    expect(mediaFor(p, undefined)).toHaveLength(3);
  });
});
