import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreApi from '@/lib/store-api';

/**
 * How the sitemap binds to the CMS when nobody hands it a source (#293) — the wiring the fakes in
 * `sitemap-content.test.ts` go around.
 *
 * Three states, and the middle one is today's: window 6's reader does not have `routedDocuments`
 * yet (#300). The sitemap must list the catalogue unchanged until it does, and pick the content up
 * the moment it does. And it must never ask for a preview reader: a sitemap is cached and public.
 */

const createReader = vi.fn();
const isCmsConfigured = vi.fn();
const getStoreOrNull = vi.fn();

vi.mock('@/lib/cms', () => ({
  cmsConfigFromEnv: () => ({ projectId: 'project-under-test' }),
  isCmsConfigured: (...args: unknown[]) => isCmsConfigured(...args),
  createReader: (...args: unknown[]) => createReader(...args),
}));
vi.mock('@/lib/store', () => ({ getStoreOrNull: () => getStoreOrNull() }));
vi.mock('@/lib/store-api', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreApi>();
  return {
    ...actual,
    storeApi: () => ({
      listProducts: async () => ({ items: [], total: 0, page: 1, limit: 100 }),
      listCategories: async () => ({ items: [] }),
    }),
  };
});

const { sitemapPaths } = await import('@/lib/sitemap-data');

const LOCALES = ['en-GB', 'de-DE'] as const;

beforeEach(() => {
  createReader.mockReset();
  isCmsConfigured.mockReset().mockReturnValue(true);
  getStoreOrNull.mockReset().mockResolvedValue({ code: 'brand-a' });
});

describe('the sitemap and the CMS reader', () => {
  it('lists content from a reader that has routedDocuments, calling it as a method', async () => {
    const reader = {
      dataset: 'brand-a',
      async routedDocuments(this: { dataset: string }, locale: string) {
        // `this` must survive: the real reader's methods close over its client.
        return locale === 'en-GB' && this.dataset === 'brand-a'
          ? [{ type: 'legal', slug: 'imprint' }]
          : [];
      },
    };
    createReader.mockReturnValue(reader);

    await expect(sitemapPaths({ locales: LOCALES })).resolves.toEqual([
      { path: '' },
      { path: '/products' },
      { path: '/legal/imprint', locales: ['en-GB'] },
    ]);
  });

  it('builds a published reader for the store, never a preview one', async () => {
    createReader.mockReturnValue({ routedDocuments: async () => [] });

    await sitemapPaths({ locales: LOCALES });

    expect(createReader).toHaveBeenCalledOnce();
    const options = createReader.mock.calls[0]![0] as Record<string, unknown>;
    expect(options['storeCode']).toBe('brand-a');
    expect(options['preview']).toBeUndefined();
  });

  it('lists the catalogue unchanged while the reader has no routedDocuments (before #300)', async () => {
    createReader.mockReturnValue({ pageSlugs: async () => ['about'], legalSlugs: async () => [] });

    await expect(sitemapPaths({ locales: LOCALES })).resolves.toEqual([
      { path: '' },
      { path: '/products' },
    ]);
  });

  it('does not read the store, or build a reader, when no CMS is configured', async () => {
    isCmsConfigured.mockReturnValue(false);

    await expect(sitemapPaths({ locales: LOCALES })).resolves.toEqual([
      { path: '' },
      { path: '/products' },
    ]);
    expect(getStoreOrNull).not.toHaveBeenCalled();
    expect(createReader).not.toHaveBeenCalled();
  });

  it('survives the reader factory throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    createReader.mockImplementation(() => {
      throw new Error('bad dataset');
    });

    await expect(sitemapPaths({ locales: LOCALES })).resolves.toEqual([
      { path: '' },
      { path: '/products' },
    ]);
  });
});
