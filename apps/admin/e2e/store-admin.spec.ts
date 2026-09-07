import { expect, test, type Page } from '@playwright/test';

/**
 * The store-admin journey from issue #30: sign in → switch store → products.
 *
 * This is the one test that exercises the whole chain rather than a layer of it — the real Keycloak
 * realm, the app's own OIDC routes, the encrypted session cookie, the permission-driven navigation
 * and the catalog screen against the Prism mock. Everything else in the suite stubs at least one of
 * those.
 *
 * Requires `pnpm compose:up` (Keycloak on :8180). The Prism mock and a production build of the app
 * are started by `playwright.config.ts`.
 */

const STORE_ADMIN = { username: 'store-admin', password: 'store-admin' };
/** From `packages/db` SEED_IDS — store-admin holds `store_admin` on brand-a and brand-b only. */
const BRAND_A = '00000000-0000-4000-8000-000000000031';
const BRAND_C = '00000000-0000-4000-8000-000000000033';

async function signIn(page: Page, to = '/'): Promise<void> {
  await page.goto(to);
  // The middleware bounces an unauthenticated request to the realm's own sign-in form.
  await page.waitForURL(/\/realms\/staff\/protocol\/openid-connect\/auth/);
  await page.getByLabel(/username|email/i).fill(STORE_ADMIN.username);
  await page.getByLabel(/password/i).fill(STORE_ADMIN.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}

test.describe('store-admin', () => {
  test('signs in with a password alone and lands on their own store', async ({ page }) => {
    await signIn(page);

    // Conditional OTP (#65): store-admin has no enrolled authenticator, so no challenge.
    await expect(page).not.toHaveURL(/required-action/);
    // `/` sends a principal with no HQ relations to their first store section.
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog`));
    await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
    await expect(page.getByText('Sam StoreAdmin')).toBeVisible();
  });

  test('sees the store view and no HQ view at all', async ({ page }) => {
    await signIn(page);
    await page.waitForURL(/\/catalog/);

    const storeNav = page.getByRole('navigation', { name: 'Brand A' });
    await expect(storeNav.getByRole('link', { name: 'Catalog' })).toBeVisible();
    await expect(storeNav.getByRole('link', { name: 'Settings' })).toBeVisible();
    // store_admin holds nothing on organization:hq, so the HQ nav is not rendered.
    await expect(page.getByRole('navigation', { name: 'HQ' })).toHaveCount(0);
  });

  test('the switcher offers exactly brand-a and brand-b', async ({ page }) => {
    await signIn(page);
    await page.waitForURL(/\/catalog/);

    const switcher = page.getByLabel('Store');
    await expect(switcher.locator('option')).toHaveText([/Brand A/, /Brand B/]);
  });

  test('switching store keeps the section and reaches the other catalog', async ({ page }) => {
    await signIn(page);
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog`));

    await page.getByLabel('Store').selectOption({ label: 'Brand B (brand-b)' });
    await page.getByRole('button', { name: 'Switch' }).click();

    await page.waitForURL(/\/catalog/);
    await expect(page).not.toHaveURL(new RegExp(BRAND_A));
    await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
  });

  test('the products table renders from the Admin API', async ({ page }) => {
    await signIn(page, `/${BRAND_A}/catalog`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog`));

    const table = page.getByRole('table', { name: 'Products' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /Title/ })).toBeVisible();
    await expect(table.getByRole('row')).not.toHaveCount(1); // header plus at least one product
  });

  test('a store outside stores[] gets the 403 panel, with the switcher intact', async ({
    page,
  }) => {
    await signIn(page, `/${BRAND_C}/catalog`);
    await page.waitForURL(new RegExp(BRAND_C));

    await expect(
      page.getByRole('heading', { name: /do not have access to this store/i }),
    ).toBeVisible();
    // Not a dead end: the switcher is still there to get back to their own stores.
    await expect(page.getByLabel('Store')).toBeVisible();
  });

  test('an HQ section is refused rather than rendered empty', async ({ page }) => {
    await signIn(page, '/finance');
    await page.waitForURL(/\/finance/);

    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
  });

  test('signing out ends the session and the next visit asks again', async ({ page }) => {
    await signIn(page);
    await page.waitForURL(/\/catalog/);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto('/');
    await page.waitForURL(/\/realms\/staff\/protocol\/openid-connect\/auth/);
  });
});
