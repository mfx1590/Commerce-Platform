import { expect, test } from '@playwright/test';

/**
 * "Both locales render every route" — #142's first criterion, asserted where it is actually true:
 * against a running server, over the real stack, with nothing mocked.
 *
 * This was attempted at unit level first and the attempt is recorded in `test/brand-i18n-seo.test.ts`.
 * Calling each route's `generateMetadata` in vitest means standing in for Next's request scope —
 * `cookies`, `headers`, the catalogue, the CMS — and a test that renders that many stubs is not
 * evidence that the route renders. The unit suite keeps what a unit can answer (the inventory is
 * complete, the layout emits the right `lang`, the sitemap module emits both locales); the rendering
 * lives here.
 *
 * Routes needing a session (account, checkout, cart, orders) are driven end to end by 2.5 (#143).
 */

const LOCALES = ['en-GB', 'de-DE'] as const;

/**
 * Public routes, with dynamic segments filled from content brand A actually publishes.
 * `test/brand-i18n-seo.test.ts` derives the inventory from the filesystem and fails if a route
 * appears that nothing knows how to address, so this list cannot silently fall behind.
 */
const ROUTES = [
  '',
  '/products',
  '/products/classic-tee',
  '/categories/t-shirts',
  '/pages/about',
  '/pages/cloth',
  '/legal/imprint',
  '/legal/privacy',
  '/legal/terms',
  '/legal/returns',
  '/campaign/autumn-cloth',
];

/** The content routes need documents in the dataset; without one they are 404s, not failures. */
const NEEDS_CMS = /^\/(pages|legal|campaign)\//;

for (const route of ROUTES) {
  for (const locale of LOCALES) {
    test(`${locale}${route || '/'} renders`, async ({ page }) => {
      test.skip(
        NEEDS_CMS.test(route) && !process.env.CMS_DATASET,
        'content routes need a seeded CMS dataset (CMS_DATASET)',
      );

      const response = await page.goto(`/${locale}${route}`);
      expect(response?.status(), `/${locale}${route} did not render`).toBe(200);

      // The locale actually reached <html>, rather than the route merely existing.
      await expect(page.locator('html')).toHaveAttribute('lang', locale);

      // Self-referencing canonical: this page points at its own locale, not the default one.
      const canonical = page.locator('link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      await expect(canonical).toHaveAttribute('href', new RegExp(`/${locale}${route}$`));

      // Every sibling locale is offered, plus x-default.
      for (const other of LOCALES) {
        await expect(
          page.locator(`link[rel="alternate"][hreflang="${other}"]`),
          `${route} omits ${other}`,
        ).toHaveCount(1);
      }
      await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);

      // A description exists. Position is a separate matter — see below.
      await expect(page.locator('meta[name="description"]')).toHaveCount(1);
    });
  }
}

/**
 * Metadata is in `<head>` on brand A's routes, in the bytes the server sends (#274, fixed by #299).
 *
 * This replaces the pin that held the old, wrong state (tags flushed after `</head>`) — it went red
 * on the re-sync that brought `htmlLimitedBots` in, as designed. The starter's synced
 * `e2e/seo-head.spec.ts` holds the general rule across user agents on the starter's routes; this
 * adds brand A's own content routes, which only exist with brand A's dataset and are where hreflang
 * had neither accepted mechanism before #322.
 *
 * Served bytes, not the DOM: React hoists streamed tags into `<head>` during hydration, so a DOM
 * check passes whether or not a crawler would see them.
 */
test('metadata is in <head> on every brand A route, content routes included', async ({
  request,
}) => {
  const placement = async (path: string) => {
    const body = await (await request.get(path)).text();
    const headEnd = body.indexOf('</head>');
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      return i === -1 ? 'absent' : i < headEnd ? 'head' : 'body';
    };
    return {
      description: at('name="description"'),
      canonical: at('rel="canonical"'),
      hreflang: at('hreflang="de-DE"'),
    };
  };

  for (const path of [
    '/en-GB',
    '/en-GB/products',
    '/en-GB/products/classic-tee',
    '/de-DE/products',
    '/en-GB/pages/about',
    '/de-DE/legal/imprint',
  ]) {
    expect(await placement(path), path).toEqual({
      description: 'head',
      canonical: 'head',
      hreflang: 'head',
    });
  }
});
