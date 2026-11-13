import { describe, expect, it } from 'vitest';
import { productJsonLd } from '@/lib/seo';
import type { Product } from '@/lib/store-api';
import {
  categoryName,
  firstBlock,
  firstText,
  imageAlt,
  productName,
  STORE_NAME_FALLBACK,
  storeDisplayName,
} from '@/lib/text';

/**
 * Brand D sweep. The Store API declares its strings without `minLength`, and the onboarding wizard
 * leaves several empty (`seo: {}`, `subtitle: ""`, blank alt, brand and names). A `??` fallback
 * stops at `""`, so the page rendered an empty heading, link, alt, title or JSON-LD name. Every
 * fallback the starter renders goes through these helpers; they are pinned on wizard-shaped data.
 */

/** What the onboarding wizard can leave behind: every optional string empty or blank. */
function wizardProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-wizard',
    handle: 'linen-tea-towel',
    title: '',
    subtitle: '',
    description: '',
    status: 'published',
    category: { id: 'c1', handle: 'kitchen', name: ' ', parent_id: null, position: 1 },
    brand_name: '',
    tags: [],
    attributes: {},
    seo: {},
    options: [],
    variants: [],
    media: [{ url: 'https://cdn.example/a.jpg', alt: '', position: 1, variant_id: null }],
    ...overrides,
  } as Product;
}

describe('display names on wizard-shaped data', () => {
  it('a blank product title falls back to the handle', () => {
    expect(productName(wizardProduct())).toBe('linen-tea-towel');
    expect(productName(wizardProduct({ title: '  \n ' }))).toBe('linen-tea-towel');
    expect(productName(wizardProduct({ title: ' Tea  towel ' }))).toBe('Tea towel');
  });

  it('a blank category name falls back to the handle', () => {
    expect(categoryName({ name: '', handle: 'kitchen' })).toBe('kitchen');
    expect(categoryName({ name: 'Kitchen', handle: 'kitchen' })).toBe('Kitchen');
  });

  it('a blank or missing store name falls back to the starter default', () => {
    expect(storeDisplayName({ name: '' })).toBe(STORE_NAME_FALLBACK);
    expect(storeDisplayName(null)).toBe(STORE_NAME_FALLBACK);
    expect(storeDisplayName({ name: 'Brand D' })).toBe('Brand D');
  });

  it('a blank alt falls back to the name of what the image shows, never ""', () => {
    expect(imageAlt('', 'Tea towel')).toBe('Tea towel');
    expect(imageAlt(null, 'Tea towel')).toBe('Tea towel');
    expect(imageAlt(' ', 'Tea towel')).toBe('Tea towel');
    expect(imageAlt('Folded, front', 'Tea towel')).toBe('Folded, front');
  });

  it('a blank SEO title falls through to the product name (seo {} and seo.title "")', () => {
    const title = (p: Product) => firstText(p.seo?.title) ?? productName(p);
    expect(title(wizardProduct({ title: 'Tea towel' }))).toBe('Tea towel');
    expect(title(wizardProduct({ title: 'Tea towel', seo: { title: '' } as Product['seo'] }))).toBe(
      'Tea towel',
    );
  });
});

describe('productJsonLd on wizard-shaped data', () => {
  const data = productJsonLd(wizardProduct(), {
    url: 'https://brand-d.example/ja-JP/products/linen-tea-towel',
    locale: 'ja-JP',
  }) as Record<string, unknown>;

  it('names the product by its handle, never ""', () => {
    expect(data.name).toBe('linen-tea-towel');
  });

  it('emits no brand, no description and no category (optional; a handle is not a name)', () => {
    expect('brand' in data).toBe(false);
    expect('description' in data).toBe(false);
    expect('category' in data).toBe(false);
  });
});

describe('#838 nits', () => {
  it('firstText keeps ideographic and no-break spaces; only ASCII whitespace is folded', () => {
    expect(firstText('リネン　タオル')).toBe('リネン　タオル');
    expect(firstText('Prix : 12 €')).toBe('Prix : 12 €');
    expect(firstText(' two \n\t lines ')).toBe('two lines');
  });

  it('a text of only ideographic spaces is still blank', () => {
    expect(firstText('　　', 'Next')).toBe('Next');
  });

  it('JSON-LD description keeps its paragraphs', () => {
    expect(firstBlock('  First line.  \r\nSecond.\n\n\n\nThird. ')).toBe(
      'First line.\nSecond.\n\nThird.',
    );
    const data = productJsonLd(
      wizardProduct({ title: 'Tea towel', description: 'Woven.\n\nWashed twice.' }),
      { url: 'https://brand-d.example/en-GB/products/linen-tea-towel', locale: 'en-GB' },
    ) as { description?: string };
    expect(data.description).toBe('Woven.\n\nWashed twice.');
  });
});
