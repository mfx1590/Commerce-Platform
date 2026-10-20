import { expect, test } from '@playwright/test';
import { AGAINST_CORE, stamped } from './api-mode';
import { signInAsOwner } from './owner';
import { BRAND_B, STORE_STAFF, signIn, staffToken } from './staff';

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:9000';

/**
 * HQ · Onboarding (#428 B). Against Prism, `/admin/me` is always the store-admin example, so only
 * the refusal can be shown there. Against the core, the seeded owner onboards a brand stamped with
 * the run (code, legal entity, hostname — reruns never collide, as with every core-mode journey),
 * sees the key once, activates the store on the readiness panel and finds it active in the list.
 *
 * Integration 3 G1 (#518), in the same journey so the spec signs the owner in ONCE (a TOTP code is
 * refused twice): (a) the publishable key the wizard showed answers `GET /store` on the core as the
 * new store; (b) the HQ roles UI gives the seeded `store-staff` user `store_staff` on the new store
 * and shows it; (c) that user's own token lists the new store's products (200, empty — the token
 * reads the new store, not brand-a) and is refused on brand-b, where it holds nothing (403). Each
 * proven step prints one line; mock mode skips with its reason. Only the run's own stamped store
 * gains anything — the seeded stores are untouched.
 */
test.describe('HQ onboarding', () => {
  test('a store admin is refused the onboarding wizard', async ({ page }) => {
    await signIn(page, '/onboarding');
    await page.waitForURL(/\/onboarding$/);
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Onboard the brand' })).toHaveCount(0);
  });

  test('the owner onboards a brand, sees the key once, activates it, and grants a relation on it', async ({
    page,
    request,
  }) => {
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
    const storeId = /\/onboarding\/([0-9a-f-]{36})$/.exec(page.url())![1]!;

    // The readiness panel: a fresh onboarding has every prerequisite, so Activate goes through.
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByRole('status')).toHaveText(/Active/);

    await page.goto('/stores?sort=created_at');
    await expect(page.getByRole('row').filter({ hasText: code }).getByText('active')).toBeVisible();

    // (a) The key the wizard showed works on the Store API: GET /store answers the new store.
    const store = await request.get(`${CORE_URL}/store`, {
      headers: { 'X-Publishable-Key': value },
    });
    expect(store.status(), 'GET /store with the wizard key').toBe(200);
    expect(((await store.json()) as { code: string }).code).toBe(code);
    console.info(`G1 key: GET /store with the wizard's key answers ${code}`);

    // (b) A relation on the NEW store through the HQ roles UI, read back in the UI.
    await page.goto('/roles');
    await page.getByRole('link', { name: 'Manage Stef StoreStaff' }).click();
    await page.waitForURL(/\/roles\?user=[0-9a-f-]{36}$/);
    const assign = page.getByRole('form', { name: 'Assign a relation' });
    await assign.getByLabel('On', { exact: true }).selectOption('store');
    await assign.getByLabel('Store', { exact: true }).selectOption(storeId);
    await assign.getByLabel('Relation', { exact: true }).selectOption('store_staff');
    await assign.getByRole('button', { name: 'Assign' }).click();
    const granted = page
      .getByRole('list', { name: 'Relations' })
      .getByRole('listitem')
      .filter({ hasText: `(${code})` });
    // Either the relation shows up, or the core refused it and the form says why (e.g. 503 "identity
    // provider unavailable" when the core has no core-admin service account, #525): fail on THAT text
    // rather than time out on a missing row.
    const refusal = assign.getByRole('alert').filter({ hasText: /\S/ });
    await expect(granted.getByText('store_staff').or(refusal)).toBeVisible();
    expect(
      await refusal.count(),
      `the core refused the assignment: ${await refusal.allInnerTexts()}`,
    ).toBe(0);
    await expect(granted.getByText('store_staff')).toBeVisible();
    console.info(`G1 role: store_staff for store-staff on ${code}, shown in the roles UI`);

    // (c) The relation works server-side, with that user's own token.
    const token = await staffToken(request, STORE_STAFF);
    const auth = { Authorization: `Bearer ${token}` };
    const own = await request.get(`${CORE_URL}/admin/stores/${storeId}/products`, {
      headers: auth,
    });
    expect(own.status(), 'store-staff lists the new store').toBe(200);
    // Empty: a fresh store has no products, so the token reads the new store, not brand-a's.
    expect(((await own.json()) as { items: unknown[] }).items).toEqual([]);
    const other = await request.get(`${CORE_URL}/admin/stores/${BRAND_B}/products`, {
      headers: auth,
    });
    expect(other.status(), 'store-staff on brand-b, where it holds nothing').toBe(403);
    console.info(`G1 relation: store-staff gets 200 (empty) on ${code} and 403 on brand-b`);
  });
});
