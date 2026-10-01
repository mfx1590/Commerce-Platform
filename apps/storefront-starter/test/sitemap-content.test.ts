import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreApi from '@/lib/store-api';
import type { ContentSource, RoutedDocument } from '@/lib/sitemap-data';

/**
 * The CMS half of the sitemap (#293): published pages, legal pages and live campaign landings.
 *
 * The reader is a fake of the signature requested from window 6 in #300 — `routedDocuments(locale)`
 * returns type, slug and schedule, already without noIndex documents and without `home`. What is
 * asserted here is what this module adds on top: which route a document lives under, which locales
 * it exists in, whether a campaign is live *now*, and that a CMS failure costs the content entries
 * and nothing else.
 */

const listProducts = vi.fn();
const listCategories = vi.fn();

vi.mock('@/lib/store-api', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreApi>();
  return { ...actual, storeApi: () => ({ listProducts, listCategories }) };
});

const { contentEntries, sitemapPaths } = await import('@/lib/sitemap-data');

const LOCALES = ['en-GB', 'de-DE'] as const;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function fakeSource(byLocale: Record<string, RoutedDocument[] | Error>): ContentSource {
  return {
    routedDocuments: async (locale) => {
      const result = byLocale[locale] ?? [];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  listProducts.mockReset();
  listCategories.mockReset();
  listProducts.mockResolvedValue({ items: [], total: 0, page: 1, limit: 100 });
  listCategories.mockResolvedValue({ items: [] });
});

describe('contentEntries', () => {
  it('lists each document under its route, with the locales it is published in', async () => {
    const source = fakeSource({
      'en-GB': [
        { type: 'page', slug: 'about' },
        { type: 'legal', slug: 'imprint' },
        { type: 'campaignLanding', slug: 'autumn' },
      ],
      'de-DE': [
        { type: 'page', slug: 'about' },
        { type: 'legal', slug: 'impressum' },
      ],
    });

    await expect(contentEntries(source, LOCALES, NOW)).resolves.toEqual([
      { path: '/pages/about', locales: ['en-GB', 'de-DE'] },
      { path: '/legal/impressum', locales: ['de-DE'] },
      { path: '/legal/imprint', locales: ['en-GB'] },
      { path: '/campaign/autumn', locales: ['en-GB'] },
    ]);
  });

  it('keeps a campaign only while it is live', async () => {
    const source = fakeSource({
      'en-GB': [
        { type: 'campaignLanding', slug: 'unbounded' },
        {
          type: 'campaignLanding',
          slug: 'running',
          startsAt: '2026-09-01T00:00:00.000Z',
          endsAt: '2026-10-31T23:59:59.000Z',
        },
        { type: 'campaignLanding', slug: 'expired', endsAt: '2026-09-30T23:59:59.000Z' },
        { type: 'campaignLanding', slug: 'not-yet', startsAt: '2026-10-02T00:00:00.000Z' },
        // Fails closed, exactly as the route does: a schedule nobody can read is not shown.
        { type: 'campaignLanding', slug: 'unreadable', endsAt: 'next week' },
      ],
    });

    const paths = (await contentEntries(source, LOCALES, NOW)).map((entry) => entry.path);
    expect(paths).toEqual(['/campaign/running', '/campaign/unbounded']);
  });

  it('lists a campaign only in the locales where it is live', async () => {
    const source = fakeSource({
      'en-GB': [{ type: 'campaignLanding', slug: 'sale', endsAt: '2026-10-31T00:00:00.000Z' }],
      'de-DE': [{ type: 'campaignLanding', slug: 'sale', endsAt: '2026-09-15T00:00:00.000Z' }],
    });

    await expect(contentEntries(source, LOCALES, NOW)).resolves.toEqual([
      { path: '/campaign/sale', locales: ['en-GB'] },
    ]);
  });

  it('ignores a schedule on anything that is not a campaign', async () => {
    const source = fakeSource({
      'en-GB': [{ type: 'page', slug: 'about', endsAt: '2020-01-01T00:00:00.000Z' }],
    });

    await expect(contentEntries(source, LOCALES, NOW)).resolves.toEqual([
      { path: '/pages/about', locales: ['en-GB'] },
    ]);
  });

  it('lists nothing the reader did not return — unpublished, noIndex and home never reach it', async () => {
    const source = fakeSource({ 'en-GB': [], 'de-DE': [] });
    await expect(contentEntries(source, LOCALES, NOW)).resolves.toEqual([]);
  });

  it('drops a document it could not route rather than advertising a broken URL', async () => {
    const source = fakeSource({
      'en-GB': [
        { type: 'page', slug: 'about' },
        { type: 'page', slug: '' },
        { type: 'page', slug: 'a/b' },
        { type: 'page', slug: 'with space' },
        { type: 'navigation', slug: 'main' } as unknown as RoutedDocument,
        { type: 'page' } as unknown as RoutedDocument,
      ],
    });

    await expect(contentEntries(source, LOCALES, NOW)).resolves.toEqual([
      { path: '/pages/about', locales: ['en-GB'] },
    ]);
  });

  it('keeps one locale when the other cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = fakeSource({
      'en-GB': new Error('sanity 503'),
      'de-DE': [{ type: 'legal', slug: 'impressum' }],
    });

    await expect(contentEntries(source, LOCALES, NOW)).resolves.toEqual([
      { path: '/legal/impressum', locales: ['de-DE'] },
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('asks the reader once per locale and for nothing else', async () => {
    const routedDocuments = vi.fn(async () => [] as RoutedDocument[]);
    await contentEntries({ routedDocuments }, LOCALES, NOW);
    expect(routedDocuments.mock.calls).toEqual([['en-GB'], ['de-DE']]);
  });
});

describe('sitemapPaths with CMS content', () => {
  it('puts content after the static routes and before the catalogue', async () => {
    listProducts.mockResolvedValueOnce({
      items: [{ handle: 'tee' }],
      total: 1,
      page: 1,
      limit: 100,
    });
    listCategories.mockResolvedValue({ items: [{ handle: 'bags' }] });
    const source = fakeSource({ 'en-GB': [{ type: 'legal', slug: 'imprint' }] });

    await expect(sitemapPaths({ source, locales: LOCALES, now: NOW })).resolves.toEqual([
      { path: '' },
      { path: '/products' },
      { path: '/legal/imprint', locales: ['en-GB'] },
      { path: '/categories/bags' },
      { path: '/products/tee' },
    ]);
  });

  it('still lists the catalogue when the CMS fails outright — a short sitemap beats a 500', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    listProducts.mockResolvedValueOnce({
      items: [{ handle: 'tee' }],
      total: 1,
      page: 1,
      limit: 100,
    });
    const source: ContentSource = {
      routedDocuments: () => {
        throw new Error('reader exploded before returning a promise');
      },
    };

    await expect(sitemapPaths({ source, locales: LOCALES, now: NOW })).resolves.toEqual([
      { path: '' },
      { path: '/products' },
      { path: '/products/tee' },
    ]);
  });

  it('lists no content, and does not fail, when no CMS is configured', async () => {
    // The default binding: no SANITY_PROJECT_ID in the test environment.
    const paths = (await sitemapPaths()).map((entry) => entry.path);
    expect(paths).toEqual(['', '/products']);
  });
});
