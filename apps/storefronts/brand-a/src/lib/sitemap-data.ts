import { cacheTags, storeApi } from './store-api';
import { CATALOG_PAGE_SIZE, catalogPageCount } from './seo';

/**
 * The catalogue the sitemap advertises.
 *
 * Kept apart from `src/app/sitemap.ts` so the walking rules — how many API pages, what happens when
 * the API fails, what a "published" product is — are unit-testable without Next's sitemap runtime.
 */

/** A sitemap is a crawler hint, not a transaction: one stale hour is fine, a thundering herd is not. */
const SITEMAP_REVALIDATE = 3600;

export interface CatalogEntry {
  /** Locale-less path, e.g. `/products/alpine-backpack`. */
  path: string;
  lastModified?: Date;
}

/**
 * Every published product, walked page by page because the Store API caps `limit` at 100.
 *
 * Two deliberate limits. The walk is bounded by `catalogPageCount`, so a wrong `total` from the API
 * cannot turn one crawler request into thousands of upstream calls. And a failure part-way through
 * returns what was collected rather than throwing: a sitemap missing its tail is a crawler
 * inefficiency, while a 500 tells the crawler the whole sitemap is broken and it backs off from all
 * of it.
 */
export async function catalogEntries(): Promise<CatalogEntry[]> {
  const api = storeApi();
  const entries: CatalogEntry[] = [];

  let first;
  try {
    first = await api.listProducts(
      { page: 1, limit: CATALOG_PAGE_SIZE },
      { tags: [cacheTags.products], revalidate: SITEMAP_REVALIDATE },
    );
  } catch (error) {
    console.warn('[storefront] sitemap: the catalogue could not be read:', error);
    return entries;
  }

  entries.push(...first.items.map(toEntry));

  const pages = catalogPageCount(first.total);
  for (let page = 2; page <= pages; page += 1) {
    try {
      const next = await api.listProducts(
        { page, limit: CATALOG_PAGE_SIZE },
        { tags: [cacheTags.products], revalidate: SITEMAP_REVALIDATE },
      );
      if (next.items.length === 0) break;
      entries.push(...next.items.map(toEntry));
    } catch (error) {
      console.warn(`[storefront] sitemap: stopped at page ${page}:`, error);
      break;
    }
  }

  return entries;
}

function toEntry(product: { handle: string }): CatalogEntry {
  return { path: `/products/${product.handle}` };
}

/** Every category, which is a single unpaged read in the contract. */
export async function categoryEntries(): Promise<CatalogEntry[]> {
  try {
    const { items } = await storeApi().listCategories({
      tags: [cacheTags.categories],
      revalidate: SITEMAP_REVALIDATE,
    });
    return items.map((category) => ({ path: `/categories/${category.handle}` }));
  } catch (error) {
    console.warn('[storefront] sitemap: categories could not be read:', error);
    return [];
  }
}

/** Routes that exist regardless of catalogue data. Checkout and account are deliberately absent. */
export const STATIC_PATHS: string[] = ['', '/products'];

/**
 * Every locale-less path the sitemap advertises, in a stable order.
 *
 * Shared by the sitemap pages and the sitemap index so the two cannot disagree about how many pages
 * exist — an index advertising a page that 404s is worse than no index at all.
 */
export async function sitemapPaths(): Promise<CatalogEntry[]> {
  const [products, categories] = await Promise.all([catalogEntries(), categoryEntries()]);
  return [...STATIC_PATHS.map((path) => ({ path })), ...categories, ...products];
}
