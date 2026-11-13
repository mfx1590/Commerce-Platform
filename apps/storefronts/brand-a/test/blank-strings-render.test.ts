import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LineItem, Product, ShippingOption } from '@/lib/store-api';

/**
 * Brand D sweep, #846 review: the blank-string fallbacks asserted on RENDERED markup, not only on
 * the helpers. A wizard-shaped product (`seo: {}`, empty subtitle, brand, description and alt) must
 * not render an empty element; a blank cart-line title and shipping-option name must still label
 * their heading, image and radio.
 */

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja-JP',
  getTranslations: async () => (key: string) => key,
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));
vi.mock('next/navigation', () => ({ notFound: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/actions', () => ({
  addToCartAction: async () => ({}),
  updateLineItemAction: async () => ({}),
  removeLineItemAction: async () => undefined,
  saveAddressAction: async () => ({}),
  saveShippingAction: async () => ({}),
  savePaymentAction: async () => ({}),
  placeOrderAction: async () => ({}),
}));
vi.mock('@/components/product-image', () => ({
  ProductImage: ({ alt }: { alt: string }) => createElement('img', { alt }),
}));
// Async server components (and a network read) outside what this file asserts.
vi.mock('@/components/product-reviews', () => ({ ProductReviews: () => null }));
vi.mock('@/components/recommendation-rail', () => ({ RecommendationRail: () => null }));
vi.mock('@/lib/recommendations', () => ({
  EMPTY_RECOMMENDATIONS: { items: [] },
  loadRecommendations: async () => ({ items: [] }),
}));
vi.mock('@/lib/store', () => ({ getStoreOrNull: async () => null }));

const wizard: { product: Product } = { product: undefined as unknown as Product };
vi.mock('@/lib/catalog', () => ({ getProduct: async () => wizard.product }));

const PdpModule = await import('@/app/[locale]/(shop)/products/[handle]/page');
const { CartLine } = await import('@/components/cart-line');
const { ShippingForm } = await import('@/components/checkout-forms');
const { checkoutCountry, UNREACHABLE_STORE_COUNTRY } = await import('@/lib/checkout-page');

const money = (amount_minor: number) => ({ amount_minor, currency: 'JPY' });

function wizardProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-wizard',
    handle: 'linen-tea-towel',
    title: 'リネンのタオル',
    subtitle: '',
    description: '  ',
    status: 'published',
    category: null,
    brand_name: '',
    tags: [],
    attributes: {},
    seo: {},
    options: [],
    variants: [
      {
        id: 'v1',
        sku: 'TOWEL-1',
        title: 'One size',
        options: {},
        price: money(1200),
        compare_at_price: null,
        inventory_quantity: 3,
        allow_backorder: false,
        manage_inventory: true,
      },
    ],
    media: [{ url: 'https://cdn.example/a.jpg', alt: '', position: 1, variant_id: null }],
    ...overrides,
  } as unknown as Product;
}

const params = Promise.resolve({ handle: 'linen-tea-towel', locale: 'ja-JP' });

async function renderPdp(product: Product): Promise<string> {
  wizard.product = product;
  const element = (await PdpModule.default({ params })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('PDP on a wizard-shaped product (rendered)', () => {
  it('renders no empty <p> and no "Description" heading over nothing', async () => {
    const html = await renderPdp(wizardProduct());
    expect(html).not.toMatch(/<p[^>]*>\s*<\/p>/);
    expect(html).not.toContain('id="description"');
  });

  it('every image has a non-empty alt (blank alt falls back to the product name)', async () => {
    const html = await renderPdp(wizardProduct());
    expect(html).not.toMatch(/alt=""/);
    expect(html).toContain('alt="リネンのタオル"');
  });

  it('a blank title gives an h1 with the handle, never an empty one', async () => {
    const html = await renderPdp(wizardProduct({ title: '' }));
    expect(html).toMatch(/<h1[^>]*>linen-tea-towel<\/h1>/);
  });

  it('a real description still renders under its heading', async () => {
    const html = await renderPdp(wizardProduct({ description: 'Woven in Portugal.' }));
    expect(html).toContain('id="description"');
    expect(html).toContain('Woven in Portugal.');
  });

  it('metadata: seo {} gives the product name as the title, not ""', async () => {
    wizard.product = wizardProduct();
    const metadata = await PdpModule.generateMetadata({ params });
    expect(metadata.title).toBe('リネンのタオル');
    expect('description' in metadata).toBe(false);
  });

  it('metadata: seo.title "" also falls through (a ?? chain rendered " · Brand")', async () => {
    wizard.product = wizardProduct({ seo: { title: '' } as Product['seo'] });
    const metadata = await PdpModule.generateMetadata({ params });
    expect(metadata.title).toBe('リネンのタオル');
  });
});

function line(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: 'line-1',
    variant_id: 'v1',
    product_id: 'p1',
    title: '',
    variant_title: 'One size',
    sku: 'TOWEL-1',
    thumbnail_url: 'https://cdn.example/a.jpg',
    quantity: 1,
    unit_price: money(1200),
    total: money(1200),
    ...overrides,
  } as unknown as LineItem;
}

describe('cart line with a blank title (rendered)', () => {
  it('heading and alt fall back to the variant title', () => {
    const html = renderToStaticMarkup(createElement(CartLine, { item: line(), locale: 'ja-JP' }));
    expect(html).toMatch(/<h3[^>]*>One size<\/h3>/);
    expect(html).toContain('alt="One size"');
  });

  it('then to the SKU when the variant title is blank too', () => {
    const html = renderToStaticMarkup(
      createElement(CartLine, { item: line({ variant_title: ' ' }), locale: 'ja-JP' }),
    );
    expect(html).toMatch(/<h3[^>]*>TOWEL-1<\/h3>/);
    expect(html).not.toMatch(/alt=""/);
  });
});

describe('checkout country pre-fill (#846 review: money)', () => {
  it("uses the store's default_country when it has one", () => {
    expect(checkoutCountry({ default_country: 'JP' }, { country: 'NL' })).toBe('JP');
  });

  it("a blank default_country falls back to the cart's country, never a hard-coded one", () => {
    expect(checkoutCountry({ default_country: '' }, { country: 'JP' })).toBe('JP');
  });

  it('both blank: nothing pre-filled, so the customer must choose', () => {
    expect(checkoutCountry({ default_country: ' ' }, { country: '' })).toBe('');
  });

  it('only an unreachable store keeps the old fallback', () => {
    expect(checkoutCountry(null, { country: 'JP' })).toBe(UNREACHABLE_STORE_COUNTRY);
  });
});

describe('shipping radio with a blank option name (rendered)', () => {
  it('labels the radio with the option code', () => {
    const option = {
      id: 'so-1',
      code: 'standard',
      name: '',
      carrier: 'manual',
      price: money(500),
    } as unknown as ShippingOption;
    const html = renderToStaticMarkup(
      createElement(ShippingForm, { options: [option], selectedId: null, locale: 'ja-JP' }),
    );
    expect(html).toMatch(/<span class="font-medium">standard<\/span>/);
    expect(html).not.toMatch(/<span class="font-medium"><\/span>/);
  });
});
