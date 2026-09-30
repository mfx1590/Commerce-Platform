import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { findAll, render } from './cms-render';
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

// The real components are rendered below, so the module edges they sit on are stood in for: an
// API, a CMS and next-intl's request context. Nothing here stands in for the code under test.
// Spread the original rather than enumerate: the routes reach for several navigation exports, and
// listing them one at a time just moves the failure along.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
// The root layout reaches `@/brand/tokens`, which loads the self-hosted faces. `next/font/local` is
// a build-time transform with no runtime implementation (see test/brand-theme.test.ts).
vi.mock('next/font/local', () => ({
  default: () => ({ className: 'f', style: { fontFamily: 'f' }, variable: '--f' }),
}));
vi.mock('next-intl', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('next-intl/server', () => ({
  getMessages: async () => ({}),
  setRequestLocale: () => undefined,
  getTranslations: async () => (key: string) => key,
  getLocale: async () => 'en-GB',
}));
vi.mock('@/lib/store', () => ({
  getStoreOrNull: async () => ({
    name: 'Brand A',
    code: 'brand-a',
    locales: ['en-GB', 'de-DE'],
    currencies: ['EUR'],
    default_currency: 'EUR',
    default_locale: 'en-GB',
    default_country: 'NL',
  }),
}));
vi.mock('@/lib/catalog', () => ({
  getProduct: async () => ({
    handle: 'classic-tee',
    title: 'Classic Tee',
    subtitle: 'Organic cotton',
    description: 'A classic tee.',
    attributes: {},
    brand_name: null,
    category: null,
    seo: null,
    media: [],
    variants: [],
  }),
  getCategory: async () => ({ handle: 't-shirts', name: 'T-shirts', seo: null }),
  listProducts: async () => ({ items: [], total: 0 }),
}));

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

/**
 * The route inventory, derived from the filesystem rather than hand-listed.
 *
 * A hand-written array cannot fail when someone adds a route — it just silently does not cover it.
 * This walks `src/app/[locale]/**` for `page.tsx`, strips Next's route groups, and fills dynamic
 * segments from brand A's own CMS content. If a route appears and this suite does not know how to
 * address it, the test below says so by name.
 */
const APP_DIR = new URL('../src/app/[locale]/', import.meta.url);

interface RouteFile {
  /** The URL path, with Next route groups stripped: `/products/[handle]`. */
  route: string;
  /** The module path, groups intact — needed to import it: `/(shop)/products/[handle]`. */
  file: string;
}

function routeFiles(dir: URL, route = '', file = ''): RouteFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      const isGroup = /^\(.*\)$/.test(entry.name);
      return routeFiles(
        new URL(`${entry.name}/`, dir),
        isGroup ? route : `${route}/${entry.name}`,
        `${file}/${entry.name}`,
      );
    }
    return entry.name === 'page.tsx' ? [{ route, file }] : [];
  });
}

/** Slugs brand A actually publishes, so a dynamic route is exercised with a real document. */
const CMS_DIR = new URL('../../../../cms/brand-a/content/', import.meta.url);
const cmsDocs = readdirSync(CMS_DIR)
  .filter((f) => f.endsWith('.json'))
  .flatMap(
    (f) =>
      JSON.parse(readFileSync(new URL(f, CMS_DIR), 'utf8')) as {
        _type: string;
        locale: string;
        slug?: { current: string };
      }[],
  );

const slugFor = (type: string) =>
  cmsDocs.find((d) => d._type === type && d.slug?.current && d.slug.current !== 'home')?.slug
    ?.current ?? '';

/** How each dynamic segment is filled. Anything unlisted makes the inventory test fail loudly. */
const DYNAMIC: Record<string, string> = {
  '/products/[handle]': 'classic-tee',
  '/categories/[handle]': 't-shirts',
  '/pages/[slug]': slugFor('page'),
  '/legal/[slug]': slugFor('legal'),
  '/campaign/[slug]': slugFor('campaignLanding'),
  '/orders/[orderId]': 'order-1',
};

/** Routes behind a session; 2.5 (#143) drives these end to end. */
const AUTHENTICATED = /^\/(account|checkout|cart|orders)/;

const ROUTE_FILES = routeFiles(APP_DIR).sort((a, b) => a.route.localeCompare(b.route));
const ALL_ROUTES = ROUTE_FILES.map((r) => r.route);
const PUBLIC_ROUTES = ROUTE_FILES.filter((r) => !AUTHENTICATED.test(r.route));

/** A route pattern with its dynamic segment filled from real content, or `null` if we cannot. */
function addressable(pattern: string): string | null {
  if (!pattern.includes('[')) return pattern;
  const filled = DYNAMIC[pattern];
  if (filled === undefined || filled === '') return null;
  return pattern.replace(/\[[^\]]+\]/, filled);
}

const ROUTES = PUBLIC_ROUTES.map((r) => addressable(r.route)).filter(
  (r): r is string => r !== null,
);

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

describe('the route inventory is derived, not hand-listed', () => {
  it('found the app router tree at all', () => {
    // A broken walk would make every per-route test below run zero times and pass.
    expect(ALL_ROUTES.length).toBeGreaterThanOrEqual(16);
    expect(ALL_ROUTES).toContain('');
    expect(ALL_ROUTES).toContain('/products/[handle]');
  });

  it('knows how to address every public route — a new one must be added here, not skipped', () => {
    const unaddressable = PUBLIC_ROUTES.filter((r) => addressable(r.route) === null).map(
      (r) => r.route,
    );
    expect(unaddressable, 'add these to DYNAMIC, with a real published slug').toEqual([]);
  });

  it('fills dynamic content routes from documents brand A actually publishes', () => {
    for (const [pattern, slug] of Object.entries(DYNAMIC)) {
      if (
        !pattern.startsWith('/pages') &&
        !pattern.startsWith('/legal') &&
        !pattern.startsWith('/campaign')
      )
        continue;
      expect(
        cmsDocs.some((d) => d.slug?.current === slug),
        `${pattern} is filled with "${slug}", which no document uses`,
      ).toBe(true);
    }
  });
});

describe('the root layout renders each locale with the right lang', () => {
  it.each(locales)('%s renders <html lang> through the real layout', async (locale) => {
    const { default: LocaleLayout } = await import('@/app/[locale]/layout');
    const out = await render(
      await LocaleLayout({
        children: 'content',
        params: Promise.resolve({ locale }),
      } as never),
    );

    const html = findAll(out, 'html');
    expect(html, 'the layout rendered no <html>').toHaveLength(1);
    expect(html[0]?.props['lang'], `<html lang> is wrong for ${locale}`).toBe(locale);
  });

  it('404s a locale this build does not route', async () => {
    const { default: LocaleLayout } = await import('@/app/[locale]/layout');
    await expect(
      LocaleLayout({ children: 'x', params: Promise.resolve({ locale: 'fr-FR' }) } as never),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

/**
 * Per-route canonical/alternate assertions live in `e2e/routes.spec.ts`, not here.
 *
 * They were attempted at unit level first and the attempt is worth recording: calling each route's
 * real `generateMetadata` in vitest means standing in for Next's request scope — `cookies`,
 * `headers`, the catalogue, the CMS — and at that point the test renders stubs rather than the
 * app. "Every route renders in both locales" is an HTTP property; it is asserted against a real
 * server, over the real stack, with nothing mocked.
 *
 * What stays here is what a unit test can actually answer: the inventory is complete, the layout
 * emits the right `lang`, and the sitemap module emits both locales.
 */

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

  it('emits one sitemap entry per path PER LOCALE, from the real module', async () => {
    // Was: `const paths = 10; expect(paths * locales.length).toBe(20)` — arithmetic that touched no
    // sitemap code and could not fail. This calls the module.
    const { STATIC_PATHS } = await import('@/lib/sitemap-data');
    const { default: sitemap } = await import('@/app/sitemap');

    // The paged sitemap takes its page id; page 0 holds the static paths.
    const entries = await sitemap({ id: 0 } as never);
    // Every static path appears once per locale...
    for (const path of STATIC_PATHS) {
      for (const locale of locales) {
        expect(
          entries.some((e) => e.url.endsWith(`/${locale}${path}`)),
          `${locale}${path} missing from the sitemap`,
        ).toBe(true);
      }
    }
    // ...and each entry carries the full language map, which is what makes hreflang work here.
    for (const entry of entries) {
      for (const locale of locales) {
        // `Languages<string>` is keyed by Next's union of known codes, so index it as a record —
        // the locales here come from routing config, not from that union.
        const languages = (entry.alternates?.languages ?? {}) as Record<string, string>;
        expect(languages[locale], `${entry.url} omits ${locale}`).toBeDefined();
      }
    }
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
   * This test pins the current, wrong state deliberately — but be precise about when it fires. It
   * reads *this app's synced copy* of `sitemap-data.ts`, not the starter's. Editing the starter
   * leaves this suite green (verified); the pin goes red on the **re-sync that brings the fix in**,
   * which is the right moment — that is when whoever is syncing should delete it and assert the
   * real inventory. It is deliberately not a tripwire on window 3's own branch.
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
