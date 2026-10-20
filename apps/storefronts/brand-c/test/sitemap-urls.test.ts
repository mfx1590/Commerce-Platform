import { describe, expect, it } from 'vitest';
import { SITEMAP_PAGE_SIZE, sitemapPageCount, sitemapUrls } from '@/lib/seo';

/**
 * From paths to sitemap URLs (#293).
 *
 * Catalogue paths exist in every locale; a CMS document exists only in the locales it was published
 * in. So the number of URLs is no longer `paths × locales`, and the two places that used that
 * product — the sitemap pages and the index that advertises them — now both count the output of
 * this one function. If they ever disagree, the index lists a page that is empty or missing.
 */

const LOCALES = ['en-GB', 'de-DE'] as const;
const ENV = { SITE_URL: 'https://brand-a.example' };

describe('sitemapUrls', () => {
  it('gives a path with no locale list one URL per locale, each with the full alternate set', () => {
    expect(sitemapUrls([{ path: '/products' }], LOCALES, ENV)).toEqual([
      {
        url: 'https://brand-a.example/en-GB/products',
        alternates: {
          languages: {
            'en-GB': 'https://brand-a.example/en-GB/products',
            'de-DE': 'https://brand-a.example/de-DE/products',
          },
        },
      },
      {
        url: 'https://brand-a.example/de-DE/products',
        alternates: {
          languages: {
            'en-GB': 'https://brand-a.example/en-GB/products',
            'de-DE': 'https://brand-a.example/de-DE/products',
          },
        },
      },
    ]);
  });

  it('gives a document published in one locale one URL, and no alternate that would 404', () => {
    expect(sitemapUrls([{ path: '/legal/impressum', locales: ['de-DE'] }], LOCALES, ENV)).toEqual([
      {
        url: 'https://brand-a.example/de-DE/legal/impressum',
        alternates: { languages: { 'de-DE': 'https://brand-a.example/de-DE/legal/impressum' } },
      },
    ]);
  });

  it('pairs the locales a document shares, in the configured order', () => {
    const urls = sitemapUrls([{ path: '/pages/about', locales: ['de-DE', 'en-GB'] }], LOCALES, ENV);

    expect(urls.map((entry) => entry.url)).toEqual([
      'https://brand-a.example/en-GB/pages/about',
      'https://brand-a.example/de-DE/pages/about',
    ]);
    expect(Object.keys(urls[0]!.alternates.languages)).toEqual(['en-GB', 'de-DE']);
  });

  it('ignores a locale this build does not route', () => {
    expect(sitemapUrls([{ path: '/pages/about', locales: ['fr-FR'] }], LOCALES, ENV)).toEqual([]);
    expect(
      sitemapUrls([{ path: '/pages/about', locales: ['fr-FR', 'en-GB'] }], LOCALES, ENV),
    ).toHaveLength(1);
  });

  it('carries lastModified onto every URL of the path', () => {
    const lastModified = new Date('2026-09-30T10:00:00.000Z');
    const urls = sitemapUrls([{ path: '/products/tee', lastModified }], LOCALES, ENV);
    expect(urls.map((entry) => entry.lastModified)).toEqual([lastModified, lastModified]);
  });
});

describe('sitemap paging with documents that are not in every locale', () => {
  const everyLocale = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ path: `/products/product-${i}` }));
  const oneLocale = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ path: `/legal/doc-${i}`, locales: ['de-DE'] }));

  it('counts URLs, not paths × locales, so the index never advertises an empty page', () => {
    // 2 499 × 2 + 2 × 1 = 5 000 URLs: exactly one full page. `paths × locales` says 5 002 — two
    // pages, the second of which would be empty.
    const paths = [...everyLocale(SITEMAP_PAGE_SIZE / 2 - 1), ...oneLocale(2)];
    const urls = sitemapUrls(paths, LOCALES, ENV);

    expect(urls).toHaveLength(SITEMAP_PAGE_SIZE);
    expect(sitemapPageCount(urls.length)).toBe(1);
    expect(sitemapPageCount(paths.length * LOCALES.length)).toBe(2);
  });

  it('opens a second page for the first URL past the boundary, and that page holds it', () => {
    const paths = [...everyLocale(SITEMAP_PAGE_SIZE / 2 - 1), ...oneLocale(3)];
    const urls = sitemapUrls(paths, LOCALES, ENV);
    const pages = sitemapPageCount(urls.length);

    expect(pages).toBe(2);
    for (let id = 0; id < pages; id += 1) {
      const slice = urls.slice(id * SITEMAP_PAGE_SIZE, (id + 1) * SITEMAP_PAGE_SIZE);
      expect(slice.length, `page ${id} is not empty`).toBeGreaterThan(0);
    }
    expect(urls.slice(SITEMAP_PAGE_SIZE)).toHaveLength(1);
  });
});
