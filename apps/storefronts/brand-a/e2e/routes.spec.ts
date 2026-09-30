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
 * The tags are present, but on most routes they are in `<body>` rather than `<head>` — diagnosed on
 * **#274** (metadata that suspends on data is flushed after the shell). It is the starter's to fix.
 *
 * This test pins the current, wrong state per route so the fix announces itself instead of landing
 * silently: when #274 is fixed these routes move to `<head>` and this goes red, which is the signal
 * to delete it and assert the correct placement everywhere.
 *
 * It matters beyond a Lighthouse point: Google ignores hreflang outside `<head>`, and the content
 * routes are also absent from the sitemap (#293), so on those routes the locale annotation is
 * currently in neither accepted mechanism.
 */
test('metadata placement is still the #274 state — delete this when that lands', async ({
  page,
}) => {
  const placement = async (path: string) => {
    await page.goto(path);
    return page.evaluate(() => ({
      description: document.querySelector('meta[name="description"]')?.closest('head') !== null,
      canonical: document.querySelector('link[rel="canonical"]')?.closest('head') !== null,
    }));
  };

  // Every route measured is in <body>, including the PLP. An earlier measurement of mine reported
  // the PLP as correct and it was wrong — re-measured on a clean build, in both locales, on repeat
  // fetches, it is BODY like the rest. Corrected on #274, because "find what the PLP does
  // differently" would have been a false lead.
  for (const path of [
    '/en-GB',
    '/en-GB/products',
    '/en-GB/products/classic-tee',
    '/de-DE/products',
  ]) {
    expect(await placement(path), `${path} moved to <head> — #274 may be fixed`).toEqual({
      description: false,
      canonical: false,
    });
  }
});
