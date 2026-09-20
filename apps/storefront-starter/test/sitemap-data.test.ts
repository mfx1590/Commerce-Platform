import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StoreApi from '@/lib/store-api';

/**
 * How the sitemap walks the catalogue. The rules that matter here are the failure ones: a sitemap is
 * a crawler hint, and the worst outcome is not a missing URL but a 500 that makes a crawler back off
 * from the whole file.
 */

const listProducts = vi.fn();
const listCategories = vi.fn();

vi.mock('@/lib/store-api', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreApi>();
  return { ...actual, storeApi: () => ({ listProducts, listCategories }) };
});

const { catalogEntries, categoryEntries, sitemapPaths } = await import('@/lib/sitemap-data');

/** A page of `count` products, reporting `total` as the size of the whole catalogue. */
function page(count: number, total: number, offset = 0) {
  return {
    items: Array.from({ length: count }, (_, i) => ({ handle: `product-${offset + i}` })),
    total,
    page: 1,
    limit: 100,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  listProducts.mockReset();
  listCategories.mockReset();
  listCategories.mockResolvedValue({ items: [] });
});

describe('catalogEntries', () => {
  it('returns one entry per product for a single-page catalogue', async () => {
    listProducts.mockResolvedValueOnce(page(3, 3));

    await expect(catalogEntries()).resolves.toEqual([
      { path: '/products/product-0' },
      { path: '/products/product-1' },
      { path: '/products/product-2' },
    ]);
    expect(listProducts).toHaveBeenCalledTimes(1);
  });

  it('walks every page, because the API caps limit at 100', async () => {
    listProducts
      .mockResolvedValueOnce(page(100, 250))
      .mockResolvedValueOnce(page(100, 250, 100))
      .mockResolvedValueOnce(page(50, 250, 200));

    await expect(catalogEntries()).resolves.toHaveLength(250);
    expect(listProducts).toHaveBeenCalledTimes(3);
    expect(listProducts.mock.calls[1]?.[0]).toMatchObject({ page: 2, limit: 100 });
  });

  it('stops early when a page comes back empty, rather than trusting total', async () => {
    listProducts.mockResolvedValueOnce(page(100, 1000)).mockResolvedValueOnce(page(0, 1000));

    await expect(catalogEntries()).resolves.toHaveLength(100);
    expect(listProducts).toHaveBeenCalledTimes(2);
  });

  it('caps the walk so a wrong total cannot fan out into thousands of upstream calls', async () => {
    listProducts.mockResolvedValue(page(100, 10_000_000));

    await catalogEntries();
    expect(listProducts.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it('returns what it has when a later page fails — a partial sitemap beats a 500', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    listProducts
      .mockResolvedValueOnce(page(100, 300))
      .mockRejectedValueOnce(new Error('upstream down'));

    await expect(catalogEntries()).resolves.toHaveLength(100);
  });

  it('returns nothing, not a rejection, when the very first read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    listProducts.mockRejectedValueOnce(new Error('upstream down'));

    await expect(catalogEntries()).resolves.toEqual([]);
  });
});

describe('categoryEntries', () => {
  it('maps categories to their listing paths', async () => {
    listCategories.mockResolvedValue({ items: [{ handle: 'bags' }, { handle: 'tees' }] });

    await expect(categoryEntries()).resolves.toEqual([
      { path: '/categories/bags' },
      { path: '/categories/tees' },
    ]);
  });

  it('degrades to empty when the API fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    listCategories.mockRejectedValue(new Error('upstream down'));

    await expect(categoryEntries()).resolves.toEqual([]);
  });
});

describe('sitemapPaths', () => {
  it('puts the static routes first, then categories, then products', async () => {
    listProducts.mockResolvedValueOnce(page(1, 1));
    listCategories.mockResolvedValue({ items: [{ handle: 'bags' }] });

    await expect(sitemapPaths()).resolves.toEqual([
      { path: '' },
      { path: '/products' },
      { path: '/categories/bags' },
      { path: '/products/product-0' },
    ]);
  });

  it('never advertises the funnel or the account area', async () => {
    listProducts.mockResolvedValueOnce(page(1, 1));

    const paths = (await sitemapPaths()).map((entry) => entry.path);
    for (const forbidden of ['/cart', '/checkout', '/account', '/orders']) {
      expect(paths.some((path) => path.startsWith(forbidden))).toBe(false);
    }
  });
});
