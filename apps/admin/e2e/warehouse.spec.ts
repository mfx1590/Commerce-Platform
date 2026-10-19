import { expect, test } from '@playwright/test';
import { AGAINST_CORE } from './api-mode';
import { signInAsOwner } from './owner';
import { BRAND_A, signIn } from './staff';

/**
 * HQ · Warehouse and Store · Inventory (#468). No journey writes stock: the shared dev database is
 * pooled (brand A's and brand B's first variants share one stock item) and used read-only, so the
 * pool action is opened up to its confirmation and cancelled; record / reconcile / approve and
 * every error are covered by the unit, component and Prism contract suites.
 *
 * Against Prism, `/admin/me` is always the store-admin example: the HQ screen can only be refused
 * there, and the store inventory is read from the spec's examples. Against the core, the seeded
 * owner signs in (password + TOTP).
 */
test.describe('warehouse', () => {
  test('a store admin is refused the HQ warehouse screen', async ({ page }) => {
    await signIn(page, '/warehouse');
    await page.waitForURL(/\/warehouse$/);
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Stock items' })).toHaveCount(0);
  });

  test('a store admin reads the inventory rows, keyed per variant and warehouse, without the HQ badge', async ({
    page,
  }) => {
    await signIn(page, `/${BRAND_A}/inventory`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/inventory$`));
    const table = page.getByRole('table', { name: 'Inventory levels' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await expect(page.getByText(/Shared with \d+ brands/)).toHaveCount(0);
  });

  // ONE owner sign-in for the file (as hq-roles / hq-onboarding do): each sign-in spends a TOTP code
  // and Keycloak refuses a code twice, so both tabs are read in this one journey.
  test('the owner reads a shared item, opens the pool action up to its confirmation, and reads the cycle counts', async ({
    page,
  }) => {
    test.skip(!AGAINST_CORE, "core mode only: Prism's /admin/me is always the store-admin example");
    await signInAsOwner(page, '/warehouse?shared=true');
    await page.waitForURL(/\/warehouse\?shared=true$/);

    // shared=true: every listed item is mapped by more than one store — the seeded pool item
    // (brand A's and brand B's first variants) among them.
    const item = page
      .getByRole('list', { name: 'Stock items' })
      .getByRole('listitem')
      .filter({ hasText: /Shared with \d+ brands/ })
      .first();
    await expect(item).toBeVisible();
    await expect(item.getByRole('table', { name: /^Pool levels of / })).toBeVisible();

    await item.getByRole('button', { name: /^Pool a variant onto / }).click();
    if ((await item.getByLabel('Variant', { exact: true }).count()) === 0) {
      // No other item on the page to pick from: name a well-formed id (never confirmed).
      await item
        .getByLabel('Variant id', { exact: true })
        .fill('00000000-0000-4000-8000-000000000000');
    }
    await item.getByRole('button', { name: 'Pool…' }).click();
    const dialog = page.getByRole('alertdialog', { name: /^Confirm pooling onto / });
    await expect(dialog).toContainText(/mapped by .+ and .+/);
    // Read-only on the pooled dev database: cancel, never confirm.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // The item's ledger and its reservations (#469 reads; viewer on hq, read-only).
    const sku = (await item
      .getByRole('table', { name: /^Pool levels of / })
      .getAttribute('aria-label'))!.replace(/^Pool levels of /, '');
    await item.getByRole('link', { name: `Movements of ${sku}` }).click();
    await page.waitForURL(/[?&]view=movements/);
    await expect(
      page.getByRole('table', { name: `Movements of ${sku}` }).or(page.getByText('No movements.')),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: `Details of ${sku}` })
      .getByRole('link', { name: 'Reservations' })
      .click();
    await page.waitForURL(/[?&]view=reservations/);
    await expect(
      page
        .getByRole('table', { name: `Reservations of ${sku}` })
        .or(page.getByText('No open reservations.')),
    ).toBeVisible();

    await page.getByRole('link', { name: 'Cycle counts' }).click();
    await page.waitForURL(/\/warehouse\?tab=counts$/);
    await expect(page.getByRole('note')).toContainText(/reconcile the newest/);
    await expect(page.getByRole('form', { name: 'Record a count' })).toBeVisible();
    await expect(
      page.getByRole('table', { name: 'Cycle counts' }).or(page.getByText('No counts match.')),
    ).toBeVisible();

    // The approve dialog previews the recomputed delta (a GET; nothing is written). Conditional on
    // the shared data having a flagged count, so the log says which path ran.
    const approve = page.getByRole('button', { name: /^Approve the count of / }).first();
    if ((await approve.count()) === 0) {
      console.info('warehouse e2e: approve preview SKIPPED — no flagged count on this database');
      return;
    }
    console.info('warehouse e2e: approve preview OPENED on the first flagged count');
    await approve.click();
    const confirm = page.getByRole('alertdialog', { name: /^Confirm approving the count of / });
    await expect(confirm).toContainText(/Delta now:|Delta when flagged:|can never be applied/);
    // Never approve on the shared database: Cancel (or Close, when the count is superseded).
    await confirm.getByRole('button', { name: /^(Cancel|Close)$/ }).click();
    await expect(confirm).toHaveCount(0);
  });
});
