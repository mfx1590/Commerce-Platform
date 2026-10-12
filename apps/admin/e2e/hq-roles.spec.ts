import { expect, test } from '@playwright/test';
import { AGAINST_CORE } from './api-mode';
import { signInAsOwner } from './owner';
import { signIn } from './staff';

/**
 * HQ · Roles (#428 A). Read-only on purpose: inviting creates a real Keycloak user and assigning or
 * revoking ends a real person's sessions, so the mutations are covered by the unit and Prism
 * contract suites, not by a journey against a shared realm.
 *
 * Against Prism, `/admin/me` is always the store-admin example, so only the refusal can be shown
 * there; against the core, the seeded owner signs in (password + TOTP) and reads the real users.
 */
test.describe('HQ roles', () => {
  test('a store admin is refused the roles screen', async ({ page }) => {
    await signIn(page, '/roles');
    await page.waitForURL(/\/roles$/);
    // A principal with store relations only is refused by the HQ layout itself, before the
    // section's own owner check (the per-relation wording is pinned in test/roles-screens.test.tsx).
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
    await expect(page.getByText(/This is an HQ section/)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Staff users' })).toHaveCount(0);
  });

  test("the owner reads the staff users and a user's relations", async ({ page }) => {
    test.skip(!AGAINST_CORE, "core mode only: Prism's /admin/me is always the store-admin example");
    await signInAsOwner(page, '/roles');
    await page.waitForURL(/\/roles$/);

    const users = page.getByRole('table', { name: 'Staff users' });
    await expect(users.getByText('store-admin@example.com')).toBeVisible();
    await expect(page.getByRole('form', { name: 'Invite a staff user' })).toBeVisible();

    await page.getByRole('link', { name: 'Manage Sam StoreAdmin' }).click();
    await page.waitForURL(/\/roles\?user=[0-9a-f-]{36}$/);
    const relations = page.getByRole('list', { name: 'Relations' });
    await expect(relations.getByText('store_admin').first()).toBeVisible();
    await expect(page.getByRole('form', { name: 'Assign a relation' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Audit entries' })).toBeVisible();
  });
});
