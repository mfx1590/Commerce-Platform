import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { AGAINST_CORE } from './api-mode';
import { signInAsOwner } from './owner';
import { BRAND_A, signIn } from './staff';

/** The Admin API spec's product example (`ProductClassicTee`), as in copy-draft.spec.ts. */
const PRODUCT = '30000000-0000-4000-8000-000000000201';

/**
 * Security headers (Phase 6 D4, #731) on a production build: the pages that do the most in the
 * browser — BI (client fetches and polling), the AI product-copy editor (server actions) and the
 * onboarding wizard — work under the nonce CSP, and the browser reports **no** CSP violation.
 *
 * Violations are collected two ways, because either alone can miss one: the document's
 * `securitypolicyviolation` events (an init script, which Playwright injects outside the page's
 * CSP) and the console's "Refused to …" errors. A blocked bootstrap script would also leave the
 * page dead, which the clicks below would notice.
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

test.describe('security headers', () => {
  test('a page carries the pinned headers and a fresh nonce CSP', async ({ page }) => {
    await signIn(page, `/${BRAND_A}/catalog`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog$`));

    const first = await page.request.get(`/${BRAND_A}/catalog`);
    const second = await page.request.get(`/${BRAND_A}/catalog`);
    const headers = first.headers();

    expect(headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).not.toBe(
      second.headers()['content-security-policy'],
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    // The e2e serves `next start`, a production build.
    expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('the AI copy editor, BI and onboarding run with no CSP violation (store admin)', async ({
    page,
  }) => {
    const violations = await watchCsp(page);

    if (!AGAINST_CORE) {
      // The copy editor drafts only on the mock (no AI provider in the core-mode job).
      await signIn(page, `/${BRAND_A}/catalog/${PRODUCT}`);
      await page.waitForURL(new RegExp(`/${BRAND_A}/catalog/${PRODUCT}$`));
      await page.getByRole('button', { name: 'Draft with AI' }).click();
      await expect(page.getByRole('region', { name: 'AI draft' })).toBeVisible();
    } else {
      await signIn(page, `/${BRAND_A}/catalog`);
      await page.waitForURL(new RegExp(`/${BRAND_A}/catalog$`));
    }

    // A store admin gets both HQ pages' 403 state: the same layouts, scripts and client islands.
    await page.goto('/bi');
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
    await page.goto('/onboarding');
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();

    expect(await violations()).toEqual([]);
  });

  test('BI and the onboarding wizard run with no CSP violation (owner)', async ({ page }) => {
    test.skip(!AGAINST_CORE, "core mode only: Prism's /admin/me is always the store-admin example");
    const violations = await watchCsp(page);

    await signInAsOwner(page, '/bi');
    await page.waitForURL(/\/bi/);
    await expect(page.getByRole('heading', { name: 'BI', exact: true })).toBeVisible();
    // Let the live tiles poll at least once from the browser (connect-src 'self').
    await page.waitForResponse((response) => /\/bi\/live/.test(response.url()), {
      timeout: 30_000,
    });

    await page.goto('/onboarding');
    await expect(page.getByRole('button', { name: 'Onboard the brand' })).toBeVisible();

    expect(await violations()).toEqual([]);
  });
});
