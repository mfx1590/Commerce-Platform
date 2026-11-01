import { expect, test } from '@playwright/test';
import { AGAINST_CORE } from './api-mode';
import { BRAND_A, signIn } from './staff';

/**
 * Product editor · "Draft with AI" (#608): draft, edit, save — on the Prism mock only (the
 * contract's example draft; no network AI anywhere). The store admin opens a product, drafts in the
 * store's default locale, edits the draft description, keeps it, and saves with the normal
 * `updateProduct`; nothing was saved before that click. Against the core it skips: the core's AI
 * runs only on its fake in its own suite, and CI's core has AI switched off.
 */
test.describe('copy drafts', () => {
  test('the store admin drafts a product description with AI, edits it and saves it', async ({
    page,
  }) => {
    test.skip(AGAINST_CORE, 'mock only: no AI provider in the core-mode job (AI_ENABLED off)');
    await signIn(page, `/${BRAND_A}/catalog`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog`));
    await page.getByRole('table', { name: 'Products' }).getByRole('link').first().click();
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog/[0-9a-f-]{36}$`));

    await expect(page.getByRole('heading', { name: 'Draft copy with AI' })).toBeVisible();
    await page.getByRole('button', { name: 'Draft with AI' }).click();

    const region = page.getByRole('region', { name: 'AI draft' });
    await expect(region).toBeVisible();
    await expect(region.getByLabel('Draft provenance')).toContainText(
      /Model \S+ · template \S+ v\d+/,
    );
    // Nothing is saved yet: the current copy is still beside the draft, Save not pressed.
    await expect(region.getByLabel('Current Description', { exact: true })).toBeVisible();

    const description = region.getByLabel('Draft Description', { exact: true });
    await description.fill('A pure linen tea towel, edited by a person before saving.');
    await expect(region.getByRole('list', { name: 'Changes to Description' })).toContainText(
      'edited by a person before saving',
    );

    await region.getByRole('button', { name: 'Save to product' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: /Saved .* to the product\./ }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'AI draft' })).toHaveCount(0);
  });
});
