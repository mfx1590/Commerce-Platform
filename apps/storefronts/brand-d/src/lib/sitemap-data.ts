import { locales } from '@/i18n/routing';
import {
  campaignIsLive,
  cmsConfigFromEnv,
  createReader,
  isCmsConfigured,
  type CmsReader,
  type RoutedDocument,
} from '@/lib/cms';
import { CATALOG_PAGE_SIZE, catalogPageCount, type SitemapPath } from './seo';
import { getStoreOrNull } from './store';
import { cacheTags, storeApi } from './store-api';

/**
 * What the sitemap advertises: the catalogue from the Store API and the routed content from the CMS.
 *
 * Kept apart from `src/app/sitemap.ts` so the rules — how many API pages are walked, what happens
 * when a backend fails, which documents count as published and live — are unit-testable without
 * Next's sitemap runtime.
 */

/** A sitemap is a crawler hint, not a transaction: one stale hour is fine, a thundering herd is not. */
const SITEMAP_REVALIDATE = 3600;

/** A locale-less path, e.g. `/products/alpine-backpack`, and the locales it exists in. */
export type CatalogEntry = SitemapPath;

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

// ── CMS content ──────────────────────────────────────────────────────────────────────────────────

/**
 * The one read the sitemap needs from the CMS: window 6's `routedDocuments` (#300, on main since
 * #317). Documents with `seo.noIndex` and the `home` page (it is mounted on `/`) are filtered at
 * the source; the schedule is returned rather than applied, because the list is cached and "live
 * now" has to be decided when the sitemap is rendered. A missing schedule side is an **absent**
 * key, never `null`. Narrowed to the one method so the tests can hand in a fake.
 */
export type ContentSource = Pick<CmsReader, 'routedDocuments'>;
export type { RoutedDocument };

/** Where each document type is routed — the three `(content)` route folders. */
const CONTENT_ROUTES: Record<RoutedDocument['type'], string> = {
  page: '/pages',
  legal: '/legal',
  campaignLanding: '/campaign',
};
const CONTENT_TYPES = Object.keys(CONTENT_ROUTES) as RoutedDocument['type'][];

/** A slug is one path segment. Anything else would be advertised as a URL that does not route. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isRoutable(document: RoutedDocument): boolean {
  return (
    CONTENT_TYPES.includes(document.type) &&
    typeof document.slug === 'string' &&
    SLUG.test(document.slug)
  );
}

/**
 * Published pages, legal pages and live campaign landings, each with the locales it exists in.
 *
 * One read per locale. A locale that cannot be read contributes nothing and the others still do —
 * the same bargain as the catalogue walk: a sitemap missing some entries is a crawler inefficiency,
 * a 500 makes it back off from all of it. Order is stable (pages, legal, campaigns; by slug) so the
 * paging does not reshuffle between requests.
 */
export async function contentEntries(
  source: ContentSource,
  siteLocales: readonly string[] = locales,
  now: number = Date.now(),
): Promise<CatalogEntry[]> {
  const perLocale = await Promise.all(
    siteLocales.map(async (locale) => {
      try {
        return { locale, documents: await source.routedDocuments(locale) };
      } catch (error) {
        console.warn(`[storefront] sitemap: CMS content for ${locale} could not be read:`, error);
        return { locale, documents: [] as RoutedDocument[] };
      }
    }),
  );

  const entries: CatalogEntry[] = [];
  for (const type of CONTENT_TYPES) {
    const localesByPath = new Map<string, string[]>();
    for (const { locale, documents } of perLocale) {
      for (const document of documents) {
        if (document.type !== type || !isRoutable(document)) continue;
        // The same rule `campaign/[slug]` applies before it renders, so the sitemap never
        // advertises a landing that answers 404. Unparseable dates fail closed there too.
        if (type === 'campaignLanding' && !campaignIsLive(document, now)) continue;
        const path = `${CONTENT_ROUTES[type]}/${document.slug}`;
        const existing = localesByPath.get(path);
        if (existing === undefined) localesByPath.set(path, [locale]);
        else if (!existing.includes(locale)) existing.push(locale);
      }
    }
    for (const path of [...localesByPath.keys()].sort()) {
      entries.push({ path, locales: localesByPath.get(path)! });
    }
  }
  return entries;
}

const NO_CONTENT: ContentSource = { routedDocuments: async () => [] };

/**
 * The published CMS reader, bound for the sitemap.
 *
 * Built here with `createReader` rather than taken from `getCms()`: that one reads the preview
 * cookie, which would make a cached sitemap dynamic and could put a draft in it. No CMS configured
 * means no content and no `GET /store` either — a CI build has neither.
 */
async function cmsContentSource(): Promise<ContentSource> {
  const config = cmsConfigFromEnv();
  if (!isCmsConfigured(config)) return NO_CONTENT;

  const store = await getStoreOrNull();
  return createReader({ config, storeCode: store?.code ?? null });
}

export interface SitemapPathOptions {
  /** Defaults to the published CMS reader. */
  source?: ContentSource | undefined;
  locales?: readonly string[] | undefined;
  now?: number | undefined;
}

/**
 * Every locale-less path the sitemap advertises, in a stable order: the static routes, CMS content,
 * categories, products.
 *
 * Shared by the sitemap pages and the sitemap index so the two cannot disagree about how many pages
 * exist — an index advertising a page that 404s is worse than no index at all.
 */
export async function sitemapPaths(options: SitemapPathOptions = {}): Promise<CatalogEntry[]> {
  const [content, products, categories] = await Promise.all([
    cmsEntries(options),
    catalogEntries(),
    categoryEntries(),
  ]);
  return [...STATIC_PATHS.map((path) => ({ path })), ...content, ...categories, ...products];
}

/** Never rejects: whatever goes wrong on the CMS side, the catalogue is still listed. */
async function cmsEntries(options: SitemapPathOptions): Promise<CatalogEntry[]> {
  try {
    const source = options.source ?? (await cmsContentSource());
    return await contentEntries(source, options.locales, options.now);
  } catch (error) {
    console.warn('[storefront] sitemap: CMS content could not be read:', error);
    return [];
  }
}
