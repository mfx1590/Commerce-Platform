import { expect, test } from '@playwright/test';
import { AGAINST_CORE } from './api-mode';
import { FINANCE, signIn, signInAs } from './staff';

/**
 * HQ › Finance (#851) against the Accounting API — Prism's accounting mock (the contract's examples)
 * in both runs: `pnpm mock` serves it in the default run, and playwright.config.ts starts it alone in
 * core mode (the advisory CI job). The real accounting service is waived until REQUEST #852 (the
 * waiver is on #851); `E2E_ACCOUNTING_URL` points core mode at one when it is up.
 *
 * - A store admin is refused, in both runs (Prism's `/admin/me` is the store-admin example; the
 *   core's is the real store admin).
 * - The finance journey needs a real finance principal, so it runs in core mode.
 *
 * Every outcome prints one `FINANCE-E2E` line, so a CI log proves whether it ran.
 */
const SEED_ENTITY = '00000000-0000-4000-8000-000000000011';
const SEED_STORE = '00000000-0000-4000-8000-000000000031';

test.describe('HQ › Finance', () => {
  test('a store admin is refused, and no books are shown', async ({ page }) => {
    await signIn(page, '/finance');
    await page.waitForURL(/\/finance/);
    await expect(page.getByText('You do not have access to this')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Legal entities' })).toHaveCount(0);
    console.info(
      `FINANCE-E2E passed: store admin refused on /finance (${AGAINST_CORE ? 'core' : 'prism'} run)`,
    );
  });

  test('a finance principal reads books, trial balance, journal, payouts and the ops view', async ({
    page,
  }) => {
    if (!AGAINST_CORE) {
      console.info(
        'FINANCE-E2E skipped: the finance journey needs a real finance principal (E2E_API=core)',
      );
      test.skip(true, 'Prism answers /admin/me with the store-admin example');
    }
    await signInAs(page, FINANCE, '/finance');
    await page.waitForURL(/\/finance/);

    // listLegalEntityBooks (example: Brand A B.V.), chosen by default.
    const entities = page.getByRole('table', { name: 'Legal entities' });
    await expect(entities.getByRole('row', { name: /Brand A B\.V\./ })).toHaveAttribute(
      'aria-current',
      'true',
    );

    // getTrialBalance (example: EUR, debits 45,123.00 = credits): one table, balanced.
    const eur = page.getByRole('region', { name: 'Trial balance EUR' });
    await expect(eur.getByText('Balanced', { exact: true })).toBeVisible();
    await expect(eur.getByText('€45,123.00').first()).toBeVisible();

    // listJournalLines (example: an order reference on brand-a) links to the store order.
    await page.goto(`/finance?entity=${SEED_ENTITY}&tab=journal`);
    const lines = page.getByRole('table', { name: 'Journal lines' });
    await expect(lines.getByRole('link', { name: /^order / }).first()).toHaveAttribute(
      'href',
      `/${SEED_STORE}/orders/00000000-0000-4000-8000-00000000c001`,
    );

    // listPayouts (example: reconciled) → getPayout (example: discrepant, one unmatched charge).
    await page.goto(`/finance?entity=${SEED_ENTITY}&tab=payouts`);
    const payouts = page.getByRole('table', { name: 'Payouts' });
    await expect(payouts.getByText('reconciled')).toBeVisible();
    await payouts.getByRole('link', { name: 'po_fixture_le_brand_a_01' }).click();
    await page.waitForURL(/\/finance\/payouts\/[0-9a-f-]{36}\?entity=/);
    const payoutLines = page.getByRole('table', { name: 'Payout lines' });
    await expect(
      payoutLines
        .getByRole('row', { name: /txn_fixture_unknown_charge/ })
        .getByText('No ledger entry'),
    ).toBeVisible();
    await expect(page.getByRole('note', { name: 'Payout-level reasons' })).toBeVisible();

    // getErpSyncStatus (example: 12 of 12 mapped) and listParkedEvents (example: one shipment.shipped).
    await page.goto(`/finance?entity=${SEED_ENTITY}&tab=ops`);
    await expect(page.getByRole('region', { name: 'ERP sync' })).toContainText(
      '12 of 12 accounts mapped',
    );
    await expect(page.getByRole('region', { name: 'Parked events' })).toContainText(
      'shipment.shipped v1',
    );
    console.info(
      'FINANCE-E2E passed: finance journey over all seven accounting operations (core run, accounting = ' +
        (process.env.E2E_ACCOUNTING_URL ?? 'Prism :4013') +
        ')',
    );
  });
});
