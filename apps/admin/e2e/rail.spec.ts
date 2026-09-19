import { expect, test } from '@playwright/test';
import { BRAND_A, FINANCE, STORE_ADMIN, settledRail, signInAs } from './staff';

/**
 * The Medusa rail in a real browser: serpents that are buttons, the list fallback, and the
 * screenshots the PR carries (`docs/medusa-rail/*.png` in this package).
 *
 * On the Prism mock `GET /admin/me` always answers with the store-admin example, so only the Store
 * scope exists here; the HQ scope needs a real principal and runs with `E2E_API=core` against the
 * core, signed in as `finance` (HQ: Stores + Finance, store access by inheritance).
 */

const SHOTS = 'docs/medusa-rail';
const CORE = process.env.E2E_API === 'core';

test.describe('medusa rail', () => {
  test('grows one serpent per permitted store section, all keyboard-operable', async ({ page }) => {
    await signInAs(page, STORE_ADMIN, `/${BRAND_A}/catalog`);
    const rail = await settledRail(page);

    const nav = rail.getByRole('navigation', { name: 'Brand A' });
    const serpents = nav.getByRole('button');
    await expect(serpents).toHaveText([
      'Catalog',
      'Orders',
      'Customers',
      'Promotions',
      'Content',
      'Marketing',
      'Settings',
    ]);
    await expect(nav.getByRole('button', { name: 'Catalog' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(nav.getByRole('button', { name: 'Orders' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // Tab reaches a serpent, Enter follows it.
    await nav.getByRole('button', { name: 'Orders' }).focus();
    await expect(nav.getByRole('button', { name: 'Orders' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/${BRAND_A}/orders`));
    await expect(nav.getByRole('button', { name: 'Orders' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await rail.screenshot({ path: `${SHOTS}/store-scope.png` });
  });

  test('the head artwork is a small static asset and the page has no third-party scripts', async ({
    page,
  }) => {
    // Scripts requested by pages of *this app*. The realm's own sign-in page loads Keycloak's
    // scripts on the way in; those are its, not ours, so the frame's origin is what filters.
    const scripts: { url: string; from: string }[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') {
        scripts.push({ url: request.url(), from: request.frame().url() });
      }
    });
    await signInAs(page, STORE_ADMIN, `/${BRAND_A}/catalog`);
    await settledRail(page);

    const head = await page.request.get('/medusa-face.jpg');
    expect(head.ok()).toBe(true);
    expect((await head.body()).byteLength).toBeLessThanOrEqual(120 * 1024);

    const origin = new URL(page.url()).origin;
    const ours = scripts.filter((script) => script.from.startsWith(origin));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.filter((script) => !script.url.startsWith(origin)).map((s) => s.url)).toEqual([]);
  });

  test('reduced motion means the list, with aria-current, and no serpent buttons', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInAs(page, STORE_ADMIN, `/${BRAND_A}/catalog`);
    const rail = await settledRail(page);

    const nav = rail.getByRole('navigation', { name: 'Brand A' });
    await expect(nav.getByRole('link', { name: 'Catalog' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('button')).toHaveCount(0);
    await expect(rail.getByRole('checkbox', { name: 'List view' })).toBeDisabled();

    await rail.screenshot({ path: `${SHOTS}/list-view.png` });
  });

  test('the list view toggle persists across a reload', async ({ page }) => {
    await signInAs(page, STORE_ADMIN, `/${BRAND_A}/catalog`);
    const rail = await settledRail(page);
    await rail.getByRole('checkbox', { name: 'List view' }).check();
    await expect(rail.getByRole('link', { name: 'Catalog' })).toBeVisible();

    await page.reload();
    const again = await settledRail(page);
    await expect(again.getByRole('link', { name: 'Catalog' })).toBeVisible();
    await again.getByRole('checkbox', { name: 'List view' }).uncheck();
    await expect(again.getByRole('button', { name: 'Catalog' })).toBeVisible();
  });

  test('HQ scope: a finance principal switches between the HQ and store serpents', async ({
    page,
  }) => {
    test.skip(!CORE, 'the mock answers /admin/me with the store-admin example; HQ needs the core');
    await signInAs(page, FINANCE, '/finance');
    const rail = await settledRail(page);

    const hq = rail.getByRole('navigation', { name: 'HQ' });
    await expect(hq.getByRole('button', { name: 'Finance' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(hq.getByRole('button', { name: 'Roles' })).toHaveCount(0);
    await rail.screenshot({ path: `${SHOTS}/hq-scope.png` });

    // Exact: 'Store' would otherwise also match the 'Stores' serpent.
    await rail.getByRole('button', { name: 'Store', exact: true }).click();
    await expect(rail.getByRole('navigation', { name: /Brand/ })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'Settings' })).toHaveCount(0);
  });
});
