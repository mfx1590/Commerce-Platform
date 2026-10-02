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
  request,
}) => {
  /**
   * Measured on the **served bytes**, not the hydrated DOM — and that distinction is the point.
   *
   * The first version of this test asked the DOM (`closest('head')`) and was itself flaky: it failed
   * one run in five claiming the tags had "moved to <head>". They had not. The server is completely
   * deterministic — 60 of 60 requests across three routes put the description after `</head>` — but
   * React sometimes hoists the tags into `<head>` during hydration, so what the DOM reports depends
   * on when it is sampled.
   *
   * That is almost certainly the same race behind the Lighthouse `meta-description` flake on #274:
   * not request-to-request variance, but whether the audit samples before or after hydration. A
   * crawler reading the raw HTML never sees the hoist at all, which is why the server-side position
   * is the one that matters and the one asserted here.
   */
  const placement = async (path: string) => {
    const body = await (await request.get(path)).text();
    const headEnd = body.indexOf('</head>');
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      return i === -1 ? 'absent' : i < headEnd ? 'head' : 'body';
    };
    return { description: at('name="description"'), canonical: at('rel="canonical"') };
  };

  for (const path of [
    '/en-GB',
    '/en-GB/products',
    '/en-GB/products/classic-tee',
    '/de-DE/products',
  ]) {
    expect(await placement(path), `${path} moved to <head> — #274 may be fixed`).toEqual({
      description: 'body',
      canonical: 'body',
    });
  }
});
