import { expect, test } from '@playwright/test';
import { AGAINST_CORE } from '../api-mode';
import { signInAsOwner } from '../owner';
import { signIn } from '../staff';

/**
 * HQ · BI (#480, window 12). Read-only: the page only calls the report operations (#479).
 *
 * - A store admin on `/bi` gets the 403 state — never an empty chart. Prism and core alike (the store-admin
 *   journey signs in for real in both modes).
 * - Against the core, the seeded owner (password + TOTP; ONE owner sign-in for the file) sees brands A, B and C,
 *   the finance card, and charts that each hold one currency. Whether the shared dev database has sales in the
 *   default 30-day window is not this spec's to decide: it prints which path it checked.
 *
 * Every test prints one `[bi e2e]` line on pass and on skip, with the reason.
 */
const say = (line: string) => console.info(`[bi e2e] ${line}`);

test.describe('bi', () => {
  test('a store admin on /bi gets the 403 state, not an empty chart', async ({ page }) => {
    await signIn(page, '/bi');
    await page.waitForURL(/\/bi$/);
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
    // A store-only principal is refused by the HQ layout before the BI section guard: its hint names that.
    await expect(page.getByText(/This is an HQ section/)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Currency' })).toHaveCount(0);
    await expect(page.getByRole('figure')).toHaveCount(0);
    say('PASS store-admin: 403 panel (HQ section, store relations only), no chart');
  });

  test('the owner sees every brand, the finance card, and one currency per chart', async ({
    page,
  }) => {
    if (!AGAINST_CORE) {
      say(
        "SKIP owner journey: core mode only — Prism's /admin/me is always the store-admin example",
      );
    }
    test.skip(!AGAINST_CORE, "core mode only: Prism's /admin/me is always the store-admin example");

    await signInAsOwner(page, '/bi');
    await page.waitForURL(/\/bi/);
    await expect(page.getByRole('heading', { name: 'BI', exact: true })).toBeVisible();

    // Brands A, B and C: the stock tabs list every store the owner reaches.
    const stores = page.getByRole('navigation', { name: 'Store' });
    await expect(stores.getByRole('link')).toHaveText(['brand-a', 'brand-b', 'brand-c']);
    await expect(page.getByRole('heading', { name: 'Stock', exact: true })).toBeVisible();

    // The owner holds finance: the card renders, fees labelled unreconciled when there is data.
    await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();

    const tabs = page.getByRole('navigation', { name: 'Currency' });
    if ((await tabs.count()) === 0) {
      await expect(page.getByText('No sales in this window.')).toBeVisible();
      say(
        'PASS owner: brands A, B, C in the stock tabs; finance card; sales path = no sales in the default window',
      );
      return;
    }
    const currencies = await tabs.getByRole('link').allTextContents();
    // the charts only: the shell has its own img
    const charts = page.getByRole('figure').getByRole('img');
    await expect(charts).toHaveCount(2);
    for (const label of await charts.evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label') ?? ''),
    )) {
      const shown = currencies.filter((c) => label.includes(`(${c})`));
      expect(shown, label).toHaveLength(1);
    }
    say(
      `PASS owner: brands A, B, C in the stock tabs; finance card; sales path = tabs ${currencies.join(', ')}, each chart one currency`,
    );
  });
});
