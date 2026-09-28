import type { MetadataRoute } from 'next';
import { locales } from '@/i18n/routing';
import { absoluteUrl, localizedPath, SITEMAP_PAGE_SIZE, sitemapPageCount } from '@/lib/seo';
import { sitemapPaths } from '@/lib/sitemap-data';

/**
 * `/sitemap.xml`, paged.
 *
 * It sits outside `[locale]` on purpose — a sitemap is one file for the whole site, listing every
 * locale's URL with `hreflang` alternates, not one sitemap per language. The middleware already
 * ignores paths with a file extension, so it is never rewritten into the locale tree.
 *
 * Every product yields one URL **per locale**, so a two-locale store with 3 000 products is 6 000
 * URLs: the paging is counted in entries, not in products.
 */

export const revalidate = 3600;

/** One sitemap file per `SITEMAP_PAGE_SIZE` URLs; Next serves them as `/sitemap/<id>.xml`. */
export async function generateSitemaps(): Promise<{ id: number }[]> {
  const paths = await sitemapPaths();
  const entries = paths.length * locales.length;
  return Array.from({ length: sitemapPageCount(entries) }, (_, id) => ({ id }));
}

export default async function sitemap({ id }: { id: number }): Promise<MetadataRoute.Sitemap> {
  const paths = await sitemapPaths();

  // Expand to one entry per locale, each carrying the full `hreflang` set, then slice the page.
  const all: MetadataRoute.Sitemap = paths.flatMap((entry) =>
    locales.map((locale) => ({
      url: absoluteUrl(localizedPath(locale, entry.path)),
      ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
      alternates: {
        languages: Object.fromEntries(
          locales.map((l) => [l, absoluteUrl(localizedPath(l, entry.path))]),
        ),
      },
    })),
  );

  const start = id * SITEMAP_PAGE_SIZE;
  return all.slice(start, start + SITEMAP_PAGE_SIZE);
}
