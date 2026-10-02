import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { BUILD_SITE_URL, originSpecMode, vacuousReason } from './support/build-origin';

/**
 * Nothing the app serves may carry the origin it was **built** with (#302).
 *
 * `scripts/e2e-server.mjs` builds the app with `SITE_URL=https://build-time.invalid` and starts it
 * without that value, the way one image is built once and promoted through every environment. A
 * route that reads `SITE_URL` while it is being prerendered keeps the build machine's origin: the
 * sitemap did, and for an hour after every deploy it advertised `http://localhost:3100` URLs and
 * `hreflang` alternates to crawlers.
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

const LOCALE = 'en-GB';

test.describe('the build-time origin is served nowhere', () => {
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

  test('sitemap index and sitemap pages', async ({ request }) => {
    const index = await request.get('/sitemap.xml');
    expect(index.status()).toBe(200);
    const indexXml = await index.text();
    expect(indexXml, 'the sitemap index names the build origin').not.toContain(BUILD_HOST);

    const pages = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
    expect(pages.length, 'the index lists at least one sitemap page').toBeGreaterThan(0);

    for (const pageUrl of pages) {
      // The index advertises the public origin, which is not where this test can reach the app.
      const page = await request.get(new URL(pageUrl).pathname);
      expect(page.status(), `${pageUrl} is served`).toBe(200);
      const xml = await page.text();

      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
      expect(locs.length, `${pageUrl} lists URLs`).toBeGreaterThan(0);
      expect(xml, `${pageUrl} carries the build origin in a <loc> or an alternate`).not.toContain(
        BUILD_HOST,
      );
      // One site, one origin: the index and every URL in every page agree.
      expect(new Set(locs.map((loc) => new URL(loc).origin)).size).toBe(1);
      expect(new URL(locs[0]!).origin).toBe(new URL(pageUrl).origin);
    }
  });

  test('robots.txt', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(await robots.text()).not.toContain(BUILD_HOST);
  });

  test('canonical, hreflang and og:url on the pages', async ({ request }) => {
    const listing = await request.get(`/${LOCALE}/products`);
    const listingHtml = await listing.text();
    // The first product the listing links to: a handle is data, not something a spec may name.
    const product = new RegExp(`href="(/${LOCALE}/products/[^"?#/]+)"`).exec(listingHtml);
    expect(product, 'the listing links to at least one product').not.toBeNull();

    for (const path of [`/${LOCALE}`, `/${LOCALE}/products`, product![1]!]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const html = await response.text();
      expect(html, `${path} has a canonical`).toContain('rel="canonical"');
      expect(html, `${path} carries the build origin`).not.toContain(BUILD_HOST);
    }
  });
});
