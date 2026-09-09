import { expect, test } from '@playwright/test';
import { BRAND_A, signIn } from './staff';

/**
 * The catalog editor against the **real core**, not the mock (issue #113, acceptance criterion 3).
 *
 * Opt-in with `E2E_API=core`, and deliberately not part of the default run: the default journey is
 * hermetic against Prism, while this one writes real rows into the shared local database. Run it
 * against an app you started yourself against the core — `playwright.config.ts` reuses a server
 * that already answers `/health` rather than starting one pinned to the mock:
 *
 *   PORT=3200 ADMIN_API_URL=http://localhost:9000 ADMIN_APP_URL=http://localhost:3200 \
 *     ADMIN_SESSION_SECRET=… pnpm --filter @platform/admin start
 *   E2E_API=core PORT=3200 pnpm --filter @platform/admin e2e catalog-core
 *
 * Every run creates a product with a fresh handle, so it never trips the core's uniqueness check
 * and never depends on what an earlier run left behind. Screenshots land in `test-results/`.
 */
const AGAINST_CORE = process.env.E2E_API === 'core';

test.describe('catalog against the core', () => {
  test.skip(!AGAINST_CORE, 'set E2E_API=core and point the app at the core to run this');

  test('store-admin creates a product, adds its variants and publishes it', async ({
    page,
  }, testInfo) => {
    const stamp = Date.now().toString(36);
    const title = `Core run tee ${stamp}`;
    const handle = `core-run-tee-${stamp}`;
    const shot = (name: string) =>
      page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

    await signIn(page, `/${BRAND_A}/catalog/new`);
    await page.waitForURL(/\/catalog\/new/);

    await page.getByLabel(/^Title/).fill(title);
    await page.getByLabel(/^Handle/).fill(handle);
    await page.getByRole('button', { name: 'Add option' }).click();
    await page.getByLabel(/^Name/).fill('Size');
    await page.getByLabel(/^Values/).fill('S, M');
    // The matrix preview says what the options imply before anything is created.
    await expect(
      page.getByRole('table', { name: /Variants this product will have/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Create product' }).click();

    // 201 from the core: the editor for the id the core assigned, and the status it assigned.
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText('draft', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create all 2' })).toBeVisible();
    await shot('01-created-draft');

    // Variants are created deliberately, from the gap between the matrix and what exists.
    await page.getByRole('button', { name: 'Create all 2' }).click();
    const variants = page.getByRole('table', { name: 'Variants' });
    await expect(variants).toBeVisible();
    await expect(variants.getByRole('row')).toHaveCount(3); // header + S + M
    await expect(page.getByRole('button', { name: /Create all/ })).toHaveCount(0);
    await shot('02-variants-created');

    // Publish asks first, then renders what the core returned.
    await page.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('button', { name: 'Yes, publish' }).click();
    await expect(page.getByText('published', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Published' })).toBeDisabled();
    await shot('03-published');

    // And the list agrees with the editor: the new product is there, published.
    await page.goto(`/${BRAND_A}/catalog?q=${handle}`);
    const row = page
      .getByRole('table', { name: 'Products' })
      .getByRole('row', { name: new RegExp(title) });
    await expect(row).toBeVisible();
    await expect(row.getByText('published')).toBeVisible();
    await shot('04-listed');
  });
});
