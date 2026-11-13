import { expect, test } from '@playwright/test';
import { AGAINST_CORE } from './api-mode';
import { FINANCE, signIn, signInAs } from './staff';

/**
 * HQ › Finance (#851) against the Accounting API.
 *
 * - Default run (Prism): the mock answers `/admin/me` with the store-admin example, so the journey
 *   proves the refusal — a store admin never sees books, whatever the accounting mock would say.
 * - `E2E_API=core` + `E2E_ACCOUNTING_URL` (the real core for a real finance principal, and an
 *   accounting service — Prism's accounting mock on :4013 is enough): the finance journey through
 *   every operation, on the contract's examples. The real accounting service in the advisory job is
 *   REQUEST #852; until then this half runs locally only.
 */
const ACCOUNTING = process.env.E2E_ACCOUNTING_URL;

test.describe('HQ › Finance', () => {
  test('a store admin is refused, and no books are shown', async ({ page }) => {
    test.skip(AGAINST_CORE, 'the refusal is pinned on the mock principal (store admin)');
    await signIn(page, '/finance');
    await page.waitForURL(/\/finance/);
    await expect(page.getByText('You do not have access to this')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Legal entities' })).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Journal lines' })).toHaveCount(0);
  });

  test('a finance principal reads books, trial balance, journal, payouts and the ops view', async ({
    page,
  }) => {
    test.skip(
      !AGAINST_CORE || ACCOUNTING === undefined,
      'needs E2E_API=core and E2E_ACCOUNTING_URL (an accounting service or its Prism mock)',
    );
    await signInAs(page, FINANCE, '/finance');
    await page.waitForURL(/\/finance/);

    // Books (listLegalEntityBooks) — the first entity is chosen.
    const entities = page.getByRole('table', { name: 'Legal entities' });
    await expect(entities.getByRole('row', { name: /Brand A B\.V\./ })).toHaveAttribute(
      'aria-current',
      'true',
    );

    // Trial balance (getTrialBalance): one table per currency, stated balanced.
    const eur = page.getByRole('region', { name: 'Trial balance EUR' });
    await expect(eur.getByText('Balanced')).toBeVisible();

    // Journal (listJournalLines): an order reference opens the store's order.
    await page.getByRole('link', { name: 'Journal', exact: true }).click();
    const lines = page.getByRole('table', { name: 'Journal lines' });
    await expect(lines.getByRole('link', { name: /^order / }).first()).toHaveAttribute(
      'href',
      /^\/[0-9a-f-]{36}\/orders\/[0-9a-f-]{36}$/,
    );

    // Payouts (listPayouts) and one payout (getPayout) with its line verdicts.
    await page.getByRole('link', { name: 'Payouts', exact: true }).click();
    const payouts = page.getByRole('table', { name: 'Payouts' });
    await payouts.getByRole('link').first().click();
    await page.waitForURL(/\/finance\/payouts\/[0-9a-f-]{36}\?entity=/);
    await expect(page.getByRole('table', { name: 'Payout lines' })).toBeVisible();

    // Ops (getErpSyncStatus, listParkedEvents).
    await page.goBack();
    await page.goBack();
    await page.getByRole('link', { name: 'Parked events & ERP' }).click();
    await expect(page.getByRole('region', { name: 'ERP sync' })).toContainText('accounts mapped');
    await expect(page.getByRole('region', { name: 'Parked events' })).toBeVisible();
  });
});
