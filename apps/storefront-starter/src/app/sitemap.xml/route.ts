import { absoluteUrl, sitemapPageCount, sitemapUrls } from '@/lib/seo';
import { sitemapPaths } from '@/lib/sitemap-data';

/**
 * `/sitemap.xml` — the sitemap **index**.
 *
 * Next's `generateSitemaps` serves the pages themselves at `/sitemap/<id>.xml` and does not publish
 * an index for them, so `robots.txt` would be advertising a URL that 404s. The sitemap protocol has
 * an index file for exactly this case: one well-known entry point listing every page.
 *
 * The page count comes from the same `sitemapUrls(sitemapPaths())` the pages slice, so the index
 * can never advertise a page that does not exist — or one that exists and is empty.
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

export async function GET(): Promise<Response> {
  const pages = sitemapPageCount(sitemapUrls(await sitemapPaths()).length);

  const entries = Array.from(
    { length: pages },
    (_, id) => `  <sitemap><loc>${absoluteUrl(`/sitemap/${id}.xml`)}</loc></sitemap>`,
  ).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml',
      'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
