import { expect, test, type Page } from '@playwright/test';
import {
  CHECKOUT_STEP,
  clickWhenReady,
  hydrated,
  NAVIGATION_TIMEOUT,
  openPurchasableProduct,
  SERVER_ACTION_TIMEOUT,
} from './support/journey';
import { localePath, localeUrl } from './support/locale';

/**
 * #762: the CSS is inlined (`experimental.inlineCss`), so every page's styles arrive as `<style>`
 * elements instead of a stylesheet `<link>`. This runs on the production build (`next start`, the
 * policy the middleware sends in production) and holds three things on the PLP, the PDP and a
 * checkout step:
 *
 * - the browser reports **no** CSP violation. Collected two ways, as apps/admin/e2e/csp.spec.ts
 *   does, because either alone can miss one: `securitypolicyviolation` events (an init script,
 *   which Playwright injects outside the page's CSP) and the console's "Refused to …" errors;
 * - the CSS really is inline: a `<style>` with the app's rules, and no stylesheet `<link>`;
 * - it is applied, not merely present: the h1's `font-bold` computes to 700.
 */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} blocked ${event.blockedURI || '(inline)'}`);
    });
  });
  return async () => [
    ...consoleErrors,
    ...(await page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    )),
  ];
}

/** The page's styles are inline and applied. */
async function expectInlineStyles(page: Page, where: string): Promise<void> {
  const css = await page.evaluate(() => ({
    links: document.querySelectorAll('link[rel="stylesheet"]').length,
    inlineRules: [...document.querySelectorAll('style')].reduce(
      (sum, style) => sum + (style.sheet?.cssRules.length ?? 0),
      0,
    ),
  }));
  expect(css.links, `${where}: no stylesheet <link>; the CSS is inlined`).toBe(0);
  expect(css.inlineRules, `${where}: the inline <style> carries the app's rules`).toBeGreaterThan(
    50,
  );
  const weight = await page
    .getByRole('heading', { level: 1 })
    .first()
    .evaluate((h1) => getComputedStyle(h1).fontWeight);
  expect(weight, `${where}: the h1's font-bold is applied`).toBe('700');
}

test('PLP, PDP and checkout: inline CSS, applied, with no CSP violation', async ({ page }) => {
  const violations = await watchCsp(page);

  await test.step('PLP', async () => {
    const response = await page.goto(localePath('/products'));
    expect(response?.headers()['content-security-policy']).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    await hydrated(page);
    await expectInlineStyles(page, 'PLP');
  });

  await test.step('PDP', async () => {
    await openPurchasableProduct(page);
    await hydrated(page);
    await expectInlineStyles(page, 'PDP');
  });

  await test.step('checkout', async () => {
    await clickWhenReady(page, page.getByRole('button', { name: 'Add to cart' }));
    await expect(page).toHaveURL(localeUrl('/cart$'), { timeout: SERVER_ACTION_TIMEOUT });
    await clickWhenReady(page, page.getByRole('link', { name: 'Checkout' }));
    await expect(page).toHaveURL(CHECKOUT_STEP, { timeout: NAVIGATION_TIMEOUT });
    await hydrated(page);
    await expectInlineStyles(page, 'checkout');
  });

  expect(await violations()).toEqual([]);
});
