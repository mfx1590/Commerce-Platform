import type { MetadataRoute } from 'next';
import { SITEMAP_PAGE_SIZE, sitemapPageCount, sitemapUrls } from '@/lib/seo';
import { sitemapPaths } from '@/lib/sitemap-data';

/**
 * `/sitemap.xml`, paged.
 *
 * It sits outside `[locale]` on purpose — a sitemap is one file for the whole site, listing every
 * locale's URL with `hreflang` alternates, not one sitemap per language. The middleware already
 * ignores paths with a file extension, so it is never rewritten into the locale tree.
 *
 * The paging is counted in **URLs**, not in paths: a product yields one URL per locale, a CMS
 * document one per locale it is published in. `sitemapUrls` does that expansion once, and the index
 * route counts the same list, so the two cannot disagree about how many pages exist.
 */

/**
 * Rendered **per request**, never prerendered (#302). Every URL here is absolute and built from
 * `SITE_URL`, and one image is promoted through every environment: as a prerendered route with
 * `revalidate`, this file carried the build machine's origin — `http://localhost:3100` — for the
 * first hour after every deploy, `hreflang` alternates included. The upstream reads are what is
 * cached (`SITEMAP_REVALIDATE` and tags in `src/lib/sitemap-data.ts`), so a request costs a render,
 * not a walk of the catalogue. Same rule, and same fix, as `robots.txt`.
 */
export const dynamic = 'force-dynamic';

/** One sitemap file per `SITEMAP_PAGE_SIZE` URLs; Next serves them as `/sitemap/<id>.xml`. */
export async function generateSitemaps(): Promise<{ id: number }[]> {
  const urls = sitemapUrls(await sitemapPaths());
  return Array.from({ length: sitemapPageCount(urls.length) }, (_, id) => ({ id }));
}

export default async function sitemap({ id }: { id: number }): Promise<MetadataRoute.Sitemap> {
  const urls = sitemapUrls(await sitemapPaths());
  const start = id * SITEMAP_PAGE_SIZE;
  return urls.slice(start, start + SITEMAP_PAGE_SIZE);
}
