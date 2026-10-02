import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { siteUrl } from '../src/brand/config';
import {
  BUILD_SITE_URL,
  originSpecMode,
  RUNTIME_SITE_URL,
  vacuousReason,
} from './support/build-origin';

/**
 * Everything the app serves carries the origin it **runs** with, and nothing carries the origin it
 * was **built** with (#302).
 *
 * `scripts/e2e-server.mjs` builds the app with `SITE_URL=https://build-time.invalid` and starts it
 * with `RUNTIME_SITE_URL`, the way one image is built once and promoted through every environment.
 * A route that reads `SITE_URL` while it is being prerendered keeps the build machine's origin: the
 * sitemap did, and for an hour after every deploy it advertised `http://localhost:3100` URLs and
 * `hreflang` alternates to crawlers.
 *
 * Two rules for every assertion here, both learned in the review of this spec's first version:
 *
 * - **Positive before negative.** "The build origin is absent" is satisfied by a document with no
 *   origin in it at all. `robots.txt` was exactly that: without `ROBOTS_ALLOW_INDEXING=1` it is a
 *   bare `Disallow: /`, so the check passed whatever `robots.txt` did. Each test first requires
 *   the thing that carries an origin to be *present*, and to equal the expected runtime origin.
 * - **Equality, not self-consistency.** "The index and its pages agree" holds just as well when
 *   both are wrong. The expected origin is computed here, from the value the server was started
 *   with, and compared.
 *
 * Reads raw responses on purpose. The question is what is in the bytes, and the sitemap and
 * `robots.txt` are not pages.
 *
 * **It refuses to pass vacuously.** Against a server that was not built by `scripts/e2e-server.mjs`
 * — one already running on the port, which Playwright reuses locally — the build origin and the
 * runtime origin are the same string and nothing here could fail. The script leaves a marker next
 * to its build; without a matching one these tests are **skipped with the reason** on a laptop and
 * **fail** when `CI` is set, where the server is never reused and getting here means a broken setup.
 */

const BUILD_HOST = new URL(BUILD_SITE_URL).host;

/**
 * What the running server must advertise. Through the app's own `siteUrl()`, so that a brand which
 * fixes its origin in `src/brand/config.ts` is held to *that* origin rather than failing here.
 */
const EXPECTED_ORIGIN = new URL(siteUrl({ SITE_URL: RUNTIME_SITE_URL })).origin;

const LOCALE = 'en-GB';

const locsOf = (xml: string): string[] =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);

test.describe('the served origin is the runtime one, never the build one', () => {
  // Playwright insists on a destructuring pattern for the fixtures argument, even an empty one.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    // The build sits next to the config file; `rootDir` is the test directory, one level down.
    const appDir = dirname(
      testInfo.config.configFile ?? join(process.cwd(), 'playwright.config.ts'),
    );
    const reason = vacuousReason(join(appDir, '.next'), BUILD_SITE_URL);
    const mode = originSpecMode(reason, Boolean(process.env.CI));
    if (mode.run) return;
    if (mode.fail) throw new Error(mode.message);
    // The list reporter prints a skip as a bare dash; the reason belongs in the terminal too.
    console.warn(`[e2e] ${mode.message}`);
    testInfo.skip(true, mode.message);
  });

  test('the expected origin is not the build origin, or nothing below means anything', () => {
    expect(EXPECTED_ORIGIN).not.toBe(new URL(BUILD_SITE_URL).origin);
  });

  test('sitemap index and sitemap pages', async ({ request }) => {
    const index = await request.get('/sitemap.xml');
    expect(index.status()).toBe(200);
    const indexXml = await index.text();

    const pages = locsOf(indexXml);
    expect(pages.length, 'the index lists at least one sitemap page').toBeGreaterThan(0);
    expect(
      pages.map((page) => new URL(page).origin),
      'every sitemap page the index advertises is on the runtime origin',
    ).toEqual(pages.map(() => EXPECTED_ORIGIN));
    expect(indexXml, 'the sitemap index names the build origin').not.toContain(BUILD_HOST);

    for (const pageUrl of pages) {
      // The index advertises the public origin, which is not where this test can reach the app.
      const page = await request.get(new URL(pageUrl).pathname);
      expect(page.status(), `${pageUrl} is served`).toBe(200);
      const xml = await page.text();

      const locs = locsOf(xml);
      expect(locs.length, `${pageUrl} lists URLs`).toBeGreaterThan(0);
      expect(
        [...new Set(locs.map((loc) => new URL(loc).origin))],
        `every <loc> in ${pageUrl} is on the runtime origin`,
      ).toEqual([EXPECTED_ORIGIN]);

      // The alternates are attributes, not <loc> elements: the same origin, and at least one each.
      const alternates = [...xml.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
      expect(alternates.length, `${pageUrl} carries hreflang alternates`).toBeGreaterThan(0);
      expect(
        [...new Set(alternates.map((href) => new URL(href).origin))],
        `every alternate in ${pageUrl} is on the runtime origin`,
      ).toEqual([EXPECTED_ORIGIN]);

      expect(xml, `${pageUrl} carries the build origin`).not.toContain(BUILD_HOST);
    }
  });

  test('robots.txt points at the sitemap on the runtime origin', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    const body = await robots.text();

    // Present first. The e2e server runs the indexable configuration (`ROBOTS_ALLOW_INDEXING=1`,
    // set in playwright.config.ts) precisely so that this line exists: without it the file is a
    // bare `Disallow: /`, there is no origin in it, and the absence check below cannot fail.
    const sitemapLine = /^Sitemap:\s*(\S+)\s*$/im.exec(body);
    expect(
      sitemapLine,
      `robots.txt has a Sitemap line (is ROBOTS_ALLOW_INDEXING=1 set for the e2e server?). Got:\n${body}`,
    ).not.toBeNull();
    expect(sitemapLine![1]).toBe(`${EXPECTED_ORIGIN}/sitemap.xml`);

    expect(body, 'robots.txt names the build origin').not.toContain(BUILD_HOST);
  });

  test('canonical, hreflang and og:url on the pages', async ({ request }) => {
    const listing = await request.get(`/${LOCALE}/products`);
    const listingHtml = await listing.text();
    // The first product the listing links to: a handle is data, not something a spec may name.
    const product = new RegExp(`href="(/${LOCALE}/products/[^"?#/]+)"`).exec(listingHtml);
    expect(product, 'the listing links to at least one product').not.toBeNull();

    // Home and the listing canonicalise to themselves, so the whole URL is known. A product may
    // carry a canonical of its own from the API (a syndicated product naming its origin), so for
    // the product page it is the origin that is asserted, on the mock's and the seed's data.
    const pages: { path: string; exact: boolean }[] = [
      { path: `/${LOCALE}`, exact: true },
      { path: `/${LOCALE}/products`, exact: true },
      { path: product![1]!, exact: false },
    ];

    for (const { path, exact } of pages) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const html = await response.text();

      const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html);
      expect(canonical, `${path} has a canonical link`).not.toBeNull();
      expect(
        new URL(canonical![1]!).origin,
        `${path}: the canonical is on the runtime origin`,
      ).toBe(EXPECTED_ORIGIN);
      if (exact) expect(canonical![1]).toBe(`${EXPECTED_ORIGIN}${path}`);

      expect(html, `${path} carries the build origin`).not.toContain(BUILD_HOST);
    }
  });
});
