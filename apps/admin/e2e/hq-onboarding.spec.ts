import { expect, test } from '@playwright/test';
import { AGAINST_CORE, stamped } from './api-mode';
import { signInAsOwner } from './owner';
import { signIn } from './staff';

/**
 * HQ · Onboarding (#428 B). Against Prism, `/admin/me` is always the store-admin example, so only
 * the refusal can be shown there. Against the core, the seeded owner onboards a brand stamped with
 * the run (code, legal entity, hostname — reruns never collide, as with every core-mode journey),
 * sees the key once, activates the store on the readiness panel and finds it active in the list.
 */
test.describe('HQ onboarding', () => {
  test('a store admin is refused the onboarding wizard', async ({ page }) => {
    await signIn(page, '/onboarding');
    await page.waitForURL(/\/onboarding$/);
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Onboard the brand' })).toHaveCount(0);
  });

  test('the owner onboards a brand, sees the key once, and activates it', async ({ page }) => {
    test.skip(!AGAINST_CORE, "core mode only: Prism's /admin/me is always the store-admin example");
    const code = stamped('e2e-brand');
    await signInAsOwner(page, '/onboarding');
    await page.waitForURL(/\/onboarding$/);

    // 1. A new legal entity for this brand.
    await page.getByRole('combobox', { name: 'Legal entity' }).selectOption('inline');
    await page.getByLabel('Entity code').fill(`${code}-bv`);
    await page.getByLabel('Registered name').fill(`E2E ${code} B.V.`);
    await page.getByRole('button', { name: 'Next' }).click();
    // 2. Store basics (the defaults stay EUR / en-GB / NL / Europe/Amsterdam).
    await page.getByLabel('Store code').fill(code);
    await page.getByLabel('Store name').fill(`E2E ${code}`);
    await page.getByRole('button', { name: 'Next' }).click();
    // 3. The primary domain.
    await page.getByRole('textbox', { name: 'Primary domain' }).fill(`${code}.localhost`);
    await page.getByRole('button', { name: 'Next' }).click();
    // 4. Review → onboard.
    await page.getByRole('button', { name: 'Onboard the brand' }).click();

    const key = page.getByTestId('onboarding-key');
    await expect(key).toHaveText(/\S{8,}/);
    const value = (await key.innerText()).trim();
    expect(page.url()).not.toContain(value);
    await page.getByRole('button', { name: /Done/ }).click();
    await page.waitForURL(/\/onboarding\/[0-9a-f-]{36}$/);
    expect(await page.content()).not.toContain(value);

    // The readiness panel: a fresh onboarding has every prerequisite, so Activate goes through.
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByRole('status')).toHaveText(/Active/);

    await page.goto('/stores?sort=created_at');
    await expect(page.getByRole('row').filter({ hasText: code }).getByText('active')).toBeVisible();
  });
});
