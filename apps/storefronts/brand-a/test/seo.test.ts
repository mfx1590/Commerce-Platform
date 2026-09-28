import { describe, expect, it } from 'vitest';
import { serializeJsonLd } from '@/components/json-ld';
import {
  absoluteUrl,
  alternatesFor,
  availabilityOf,
  breadcrumbJsonLd,
  canonicalFor,
  catalogPageCount,
  localizedPath,
  priceString,
  productJsonLd,
  sitemapPageCount,
  SITEMAP_PAGE_SIZE,
} from '@/lib/seo';
import type { Product, Variant } from '@/lib/store-api';

/**
 * Task 2.2. SEO fails silently by nature — a wrong canonical, a missing `hreflang`, an availability
 * that disagrees with the buy button — so the rules live in pure functions and are asserted here
 * rather than inferred from a rendered page.
 */

const ENV = { SITE_URL: 'https://brand-a.example' };

function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    id: 'variant-alpha',
    sku: 'SKU-ALPHA',
    title: 'M / Red',
    options: { Size: 'M', Colour: 'Red' },
    price: { amount_minor: 1999, currency: 'EUR' },
    compare_at_price: null,
    in_stock: true,
    available_quantity: 5,
    allow_backorder: false,
    ...overrides,
  } as Variant;
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-alpha',
    handle: 'alpine-backpack',
    title: 'Alpine Backpack',
    subtitle: 'For long walks',
    description: 'A roomy pack.',
    status: 'published',
    category: { id: 'c1', handle: 'bags', name: 'Bags', parent_id: null, position: 1 },
    brand_name: 'Alpine',
    tags: [],
    attributes: {},
    seo: {},
    options: [],
    variants: [variant()],
    media: [
      { url: 'https://cdn.example/b.jpg', alt: null, position: 2, variant_id: null },
      { url: 'https://cdn.example/a.jpg', alt: 'Front', position: 1, variant_id: null },
    ],
    ...overrides,
  } as Product;
}

describe('URLs', () => {
  it('builds absolute URLs and never doubles a slash', () => {
    expect(absoluteUrl('/en-GB/products', ENV)).toBe('https://brand-a.example/en-GB/products');
    expect(absoluteUrl('en-GB/products', ENV)).toBe('https://brand-a.example/en-GB/products');
    expect(absoluteUrl('', ENV)).toBe('https://brand-a.example');
  });

  it('strips a trailing slash from SITE_URL — //products is a different URL to a crawler', () => {
    expect(absoluteUrl('/products', { SITE_URL: 'https://brand-a.example/' })).toBe(
      'https://brand-a.example/products',
    );
  });

  it('scopes a path to a locale', () => {
    expect(localizedPath('de-DE', '/products')).toBe('/de-DE/products');
    expect(localizedPath('de-DE')).toBe('/de-DE');
    expect(localizedPath('de-DE', '/')).toBe('/de-DE');
  });
});

describe('alternates', () => {
  it('is self-referencing and lists every locale plus x-default', () => {
    const { canonical, languages } = alternatesFor('de-DE', '/products/alpine-backpack');

    expect(canonical).toBe('/de-DE/products/alpine-backpack');
    expect(languages['en-GB']).toBe('/en-GB/products/alpine-backpack');
    expect(languages['de-DE']).toBe('/de-DE/products/alpine-backpack');
    // Somewhere to send a visitor whose language the store does not sell in.
    expect(languages['x-default']).toBe('/en-GB/products/alpine-backpack');
  });

  it('returns relative paths — metadataBase does the join, and doing it twice corrupts the URL', () => {
    const { canonical, languages } = alternatesFor('en-GB', '/products');
    expect(canonical.startsWith('/')).toBe(true);
    for (const value of Object.values(languages)) expect(value.startsWith('/')).toBe(true);
  });
});

describe('canonicalFor', () => {
  it('localises a relative canonical from the API', () => {
    // The API does not know which locale is rendering, so it returns a locale-less path. Used
    // verbatim it points at a URL that only redirects — Lighthouse scored the PDP 0.92 on exactly
    // this, and a crawler would follow the canonical away from the page it identifies.
    expect(canonicalFor('de-DE', '/products/classic-tee', '/products/classic-tee')).toBe(
      '/de-DE/products/classic-tee',
    );
  });

  it('leaves an absolute canonical alone — that is a deliberate cross-site pin', () => {
    expect(
      canonicalFor('en-GB', 'https://origin.example/p/classic-tee', '/products/classic-tee'),
    ).toBe('https://origin.example/p/classic-tee');
  });

  it('falls back to the page’s own localised path when the API has no opinion', () => {
    expect(canonicalFor('en-GB', undefined, '/products/classic-tee')).toBe(
      '/en-GB/products/classic-tee',
    );
    expect(canonicalFor('en-GB', '   ', '/products/classic-tee')).toBe(
      '/en-GB/products/classic-tee',
    );
  });

  it('agrees with the self-referencing alternate when the API has no opinion', () => {
    const { canonical } = alternatesFor('en-GB', '/products/classic-tee');
    expect(canonicalFor('en-GB', undefined, '/products/classic-tee')).toBe(canonical);
  });
});

describe('availability follows the buy button, not a second opinion', () => {
  it('in stock', () => {
    expect(availabilityOf(variant())).toBe('https://schema.org/InStock');
  });

  it('out of stock but backorderable is BackOrder, not OutOfStock', () => {
    expect(availabilityOf(variant({ in_stock: false, allow_backorder: true }))).toBe(
      'https://schema.org/BackOrder',
    );
  });

  it('out of stock', () => {
    expect(availabilityOf(variant({ in_stock: false }))).toBe('https://schema.org/OutOfStock');
  });

  it('unmanaged inventory (available_quantity null) is still in stock', () => {
    expect(availabilityOf(variant({ available_quantity: null }))).toBe(
      'https://schema.org/InStock',
    );
  });

  it('a missing variant is out of stock rather than a crash', () => {
    expect(availabilityOf(undefined)).toBe('https://schema.org/OutOfStock');
  });
});

describe('priceString', () => {
  it('converts minor units to the decimal string schema.org expects', () => {
    expect(priceString(1999, 'EUR')).toBe('19.99');
    expect(priceString(100, 'GBP')).toBe('1.00');
    expect(priceString(0, 'EUR')).toBe('0.00');
  });

  it('handles zero-decimal currencies', () => {
    expect(priceString(1999, 'JPY')).toBe('1999');
  });
});

describe('Product JSON-LD', () => {
  const url = 'https://brand-a.example/en-GB/products/alpine-backpack';

  it('carries the properties Google requires for a product rich result', () => {
    const data = productJsonLd(product(), { url, locale: 'en-GB' });

    expect(data['@context']).toBe('https://schema.org');
    expect(data['@type']).toBe('Product');
    expect(data.name).toBe('Alpine Backpack');
    expect(data.brand).toEqual({ '@type': 'Brand', name: 'Alpine' });
    expect(Array.isArray(data.offers)).toBe(true);
  });

  it('emits one offer per variant, with that variant’s own price and availability', () => {
    const data = productJsonLd(
      product({
        variants: [
          variant(),
          variant({ id: 'v2', sku: 'SKU-BETA', in_stock: false, allow_backorder: false }),
        ],
      }),
      { url, locale: 'en-GB' },
    );

    const offers = data.offers as Record<string, unknown>[];
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      '@type': 'Offer',
      price: '19.99',
      priceCurrency: 'EUR',
      availability: 'https://schema.org/InStock',
      sku: 'SKU-ALPHA',
    });
    expect(offers[1]?.availability).toBe('https://schema.org/OutOfStock');
  });

  it('orders images by position, so the first is the one the page shows', () => {
    const data = productJsonLd(product(), { url, locale: 'en-GB' });
    expect(data.image).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg']);
  });

  it('reads gtin from the free-form attributes bag when a brand sets it', () => {
    const data = productJsonLd(product({ attributes: { gtin: '01234567890128' } }), {
      url,
      locale: 'en-GB',
    });
    expect(data.gtin).toBe('01234567890128');
  });

  it('omits gtin and brand entirely rather than emitting an empty value', () => {
    const data = productJsonLd(product({ brand_name: null, attributes: { gtin: '   ' } }), {
      url,
      locale: 'en-GB',
    });
    expect('gtin' in data).toBe(false);
    expect('brand' in data).toBe(false);
  });

  it('prefers the SEO description, then the subtitle, then the body copy', () => {
    expect(
      productJsonLd(product({ seo: { description: 'From SEO' } }), { url, locale: 'en-GB' })
        .description,
    ).toBe('From SEO');
    expect(productJsonLd(product(), { url, locale: 'en-GB' }).description).toBe('For long walks');
    expect(productJsonLd(product({ subtitle: null }), { url, locale: 'en-GB' }).description).toBe(
      'A roomy pack.',
    );
  });
});

describe('BreadcrumbList JSON-LD', () => {
  it('numbers positions from 1 and makes every item absolute', () => {
    const data = breadcrumbJsonLd(
      [
        { name: 'Products', path: '/en-GB/products' },
        { name: 'Bags', path: '/en-GB/categories/bags' },
      ],
      ENV,
    );

    expect(data['@type']).toBe('BreadcrumbList');
    expect(data.itemListElement).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Products',
        item: 'https://brand-a.example/en-GB/products',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Bags',
        item: 'https://brand-a.example/en-GB/categories/bags',
      },
    ]);
  });
});

describe('JSON-LD serialisation', () => {
  it('escapes < so a product title can never close the script tag', () => {
    // The attack: a title containing </script><img onerror=...> would otherwise end the JSON-LD
    // block and turn the rest of the payload into live markup.
    const html = serializeJsonLd({ name: '</script><img src=x onerror=alert(1)>' });

    expect(html).not.toContain('</script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('\\u003c');
    // Still valid JSON, and still the same string once parsed.
    expect((JSON.parse(html) as { name: string }).name).toBe(
      '</script><img src=x onerror=alert(1)>',
    );
  });
});

describe('sitemap paging', () => {
  it('is counted in entries, because each path appears once per locale', () => {
    expect(sitemapPageCount(0)).toBe(1);
    expect(sitemapPageCount(1)).toBe(1);
    expect(sitemapPageCount(SITEMAP_PAGE_SIZE)).toBe(1);
    expect(sitemapPageCount(SITEMAP_PAGE_SIZE + 1)).toBe(2);
    expect(sitemapPageCount(SITEMAP_PAGE_SIZE * 3)).toBe(3);
  });

  it('stays under the sitemap protocol limit of 50 000 URLs per file', () => {
    expect(SITEMAP_PAGE_SIZE).toBeLessThanOrEqual(50_000);
  });

  it('walks the catalogue at the API’s maximum page size and caps the walk', () => {
    expect(catalogPageCount(0)).toBe(0);
    expect(catalogPageCount(100)).toBe(1);
    expect(catalogPageCount(101)).toBe(2);
    // A wrong `total` from the API cannot turn one crawler request into thousands of upstream calls.
    expect(catalogPageCount(1_000_000)).toBe(100);
    expect(catalogPageCount(1_000_000, 5)).toBe(5);
  });
});
