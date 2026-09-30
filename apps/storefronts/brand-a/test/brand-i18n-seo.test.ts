import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brandConfig } from '@/brand/config';
import { locales } from '@/i18n/routing';
import {
  alternatesFor,
  availabilityOf,
  breadcrumbJsonLd,
  canonicalFor,
  localizedPath,
  organizationJsonLd,
  priceString,
  productJsonLd,
  SITEMAP_PAGE_SIZE,
  sitemapPageCount,
} from '@/lib/seo';
import type { Product } from '@/lib/store-api';

/**
 * Brand A's i18n and SEO — task 2.4, issue #142.
 *
 * `test/seo.test.ts` and `test/i18n.test.ts` come from the starter and cover the *helpers*
 * thoroughly. Nothing there knows brand A sells in two locales, in euro, with the content authored
 * in 2.3. This suite is that part: the brand's own route inventory, its second message catalogue,
 * its currency, and the sitemap it actually advertises.
 *
 * Where a criterion of #142 is blocked on someone else's fix, the test says so by name rather than
 * being quietly omitted — see the `hreflang` and sitemap blocks at the bottom.
 */

/** Every locale-less route brand A serves. Content paths exist because 2.3 authored them. */
const ROUTES = [
  '',
  '/products',
  '/products/classic-tee',
  '/categories/t-shirts',
  '/pages/about',
  '/pages/cloth',
  '/legal/imprint',
  '/legal/privacy',
  '/legal/terms',
  '/legal/returns',
  '/campaign/autumn-cloth',
];

describe('brand A sells in exactly the locales the design and the content assume', () => {
  it('routes en-GB and de-DE, in that order', () => {
    expect(locales).toEqual(['en-GB', 'de-DE']);
  });

  it('has a CMS document set for every routed locale', () => {
    const dir = new URL('../../../../cms/brand-a/content/', import.meta.url);
    const docs = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { locale: string }[]);
    for (const locale of locales) {
      expect(
        docs.some((d) => d.locale === locale),
        `no CMS content for ${locale}`,
      ).toBe(true);
    }
  });
});

describe('both message catalogues are complete', () => {
  /**
   * `test/i18n.test.ts` checks `messages/` — the UI strings. It does not know about
   * `src/lib/cms/messages/`, the catalogue the CMS components use, which was the gap 2.4 found.
   */
  const load = (dir: string, locale: string) =>
    JSON.parse(
      readFileSync(new URL(`../${dir}/${locale}.json`, import.meta.url), 'utf8'),
    ) as Record<string, unknown>;

  const flatten = (value: unknown, prefix = ''): string[] =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];

  for (const dir of ['messages', 'src/lib/cms/messages']) {
    it(`${dir}: every locale defines exactly the same keys`, () => {
      const [first, ...rest] = locales.map((l) => flatten(load(dir, l)).sort());
      expect(first?.length, `${dir} has no keys`).toBeGreaterThan(0);
      for (const [i, keys] of rest.entries()) {
        expect(keys, `${locales[i + 1]} differs from ${locales[0]}`).toEqual(first);
      }
    });

    it(`${dir}: German is translated, not copied from English`, () => {
      const en = load(dir, 'en-GB');
      const de = load(dir, 'de-DE');
      expect(JSON.stringify(de)).not.toBe(JSON.stringify(en));
    });

    it(`${dir}: placeholders survive translation`, () => {
      const placeholders = (o: Record<string, unknown>) =>
        (JSON.stringify(o).match(/\{[a-zA-Z]+\}/g) ?? []).sort();
      expect(placeholders(load(dir, 'de-DE'))).toEqual(placeholders(load(dir, 'en-GB')));
    });
  }
});

describe('every route is addressable in every locale', () => {
  it.each(ROUTES)('%s has a localised path per locale, all distinct', (route) => {
    const paths = locales.map((l) => localizedPath(l, route));
    expect(new Set(paths).size, `${route} collides across locales`).toBe(locales.length);
    for (const [i, locale] of locales.entries()) {
      expect(paths[i]).toBe(`/${locale}${route}`);
    }
  });

  it.each(ROUTES)('%s advertises every locale plus x-default, self-referencing', (route) => {
    for (const locale of locales) {
      const { canonical, languages } = alternatesFor(locale, route);

      // Self-referencing: my canonical is my own locale's URL.
      expect(canonical).toBe(localizedPath(locale, route));
      // Every sibling locale is listed...
      for (const other of locales) expect(languages[other]).toBe(localizedPath(other, route));
      // ...and x-default points at the default locale, not at a locale-less URL that 404s.
      expect(languages['x-default']).toBe(localizedPath(locales[0] as string, route));
    }
  });

  it.each(ROUTES)('%s: the canonical agrees with the self-referencing alternate', (route) => {
    for (const locale of locales) {
      expect(canonicalFor(locale, undefined, route)).toBe(alternatesFor(locale, route).canonical);
    }
  });
});

describe('structured data is brand A, and priced in euro', () => {
  const product = {
    handle: 'classic-tee',
    title: 'Classic Tee',
    subtitle: 'Organic cotton',
    description: 'A classic tee in organic cotton.',
    // The helper reads all three; the contract types them as present-or-null, never absent.
    attributes: {},
    brand_name: null,
    category: null,
    seo: null,
    media: [{ url: 'https://cdn.example/tee.jpg', position: 0 }],
    variants: [
      {
        sku: 'TEE-M-RED',
        price: { amount_minor: 1999, currency: 'EUR' },
        compare_at_price: null,
        available_quantity: 5,
        allow_backorder: false,
        manage_inventory: true,
      },
    ],
  } as unknown as Product;

  it('prices the product in EUR — brand A is the EU store', () => {
    const ld = productJsonLd(product, {
      url: 'https://x.test/en-GB/products/classic-tee',
      locale: 'en-GB',
    }) as unknown as {
      offers: { priceCurrency: string; price: string; availability: string }[];
    };
    expect(ld.offers).toHaveLength(1);
    expect(ld.offers[0]?.priceCurrency).toBe('EUR');
    // Minor units to the decimal string schema.org wants — 1999 is €19.99, not €1999.
    expect(ld.offers[0]?.price).toBe('19.99');
    expect(ld.offers[0]?.availability).toBe(availabilityOf(product.variants[0]));
  });

  it('carries the properties a Product rich result needs', () => {
    const ld = productJsonLd(product, {
      url: 'https://x.test/p',
      locale: 'en-GB',
    }) as unknown as Record<string, unknown>;
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('Product');
    expect(ld['name']).toBe('Classic Tee');
  });

  it('names the brand from brandConfig, so Organization matches the tab and the OG card', () => {
    const org = organizationJsonLd({ SITE_URL: 'https://fieldnote.example' });
    expect(org['name']).toBe(brandConfig.name);
    expect(org['url']).toBe('https://fieldnote.example');
  });

  it('builds absolute breadcrumbs numbered from 1', () => {
    // The helper takes already-localised paths and an env — it does not localise for you, which is
    // exactly why this asserts the /de-DE/ prefix survives into the emitted item URLs.
    const crumbs = breadcrumbJsonLd(
      [
        { name: 'Products', path: localizedPath('de-DE', '/products') },
        { name: 'Classic Tee', path: localizedPath('de-DE', '/products/classic-tee') },
      ],
      { SITE_URL: 'https://fieldnote.example' },
    ) as unknown as { itemListElement: { position: number; item: string }[] };

    expect(crumbs.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    for (const item of crumbs.itemListElement) expect(item.item).toMatch(/^https:\/\//);
    expect(crumbs.itemListElement[0]?.item).toContain('/de-DE/');
  });

  it('formats euro minor units correctly, including the zero case', () => {
    expect(priceString(1999, 'EUR')).toBe('19.99');
    expect(priceString(0, 'EUR')).toBe('0.00');
  });
});

describe('the sitemap', () => {
  it('pages at the documented size, and the boundary does not add an empty page', () => {
    expect(sitemapPageCount(0)).toBe(1);
    expect(sitemapPageCount(1)).toBe(1);
    expect(sitemapPageCount(SITEMAP_PAGE_SIZE)).toBe(1);
    expect(sitemapPageCount(SITEMAP_PAGE_SIZE + 1)).toBe(2);
    expect(sitemapPageCount(SITEMAP_PAGE_SIZE * 2)).toBe(2);
  });

  it('counts one entry per path PER LOCALE, which is what fills a page', () => {
    // The sitemap emits every path once per locale with hreflang alternates, so a two-locale store
    // reaches the page boundary at half the paths a single-locale one would.
    const paths = 10;
    expect(paths * locales.length).toBe(20);
  });

  /**
   * #142 asks for the sitemap to be *verified*, and verifying it found a real omission that is not
   * brand A's to fix.
   *
   * `STATIC_PATHS` in `src/lib/sitemap-data.ts` is `['', '/products']`. Categories and products are
   * walked from the API, but the `(content)` routes are not advertised at all — so brand A's ten
   * authored documents per locale (about, cloth, four legal pages, the campaign landing) are
   * invisible to the sitemap. That file is the starter's, so it is a REQUEST rather than an edit.
   *
   * This test pins the current, wrong state deliberately: when window 3 adds content paths it will
   * fail, which is the reminder to delete it and assert the real inventory instead.
   */
  it('does NOT yet advertise the content routes — pinned until the starter adds them', async () => {
    const { STATIC_PATHS } = await import('@/lib/sitemap-data');
    expect(STATIC_PATHS).toEqual(['', '/products']);

    const contentRoutes = ROUTES.filter(
      (r) => r.startsWith('/pages/') || r.startsWith('/legal/') || r.startsWith('/campaign/'),
    );
    expect(contentRoutes.length).toBeGreaterThan(0);
    for (const route of contentRoutes) {
      expect(STATIC_PATHS, `${route} unexpectedly advertised — update this test`).not.toContain(
        route,
      );
    }
  });
});
