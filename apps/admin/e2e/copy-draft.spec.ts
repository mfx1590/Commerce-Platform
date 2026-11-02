import { expect, test } from '@playwright/test';
import { AGAINST_CORE } from './api-mode';
import { BRAND_A, signIn } from './staff';

/** The Admin API spec's product example (`ProductClassicTee`): the product Prism answers. */
const PRODUCT = '30000000-0000-4000-8000-000000000201';
const EDITED = 'A pure linen tea towel, edited by a person before saving.';

/**
 * Product editor · "Draft with AI" (#608): draft, edit, save — on the Prism mock only (the
 * contract's example draft; no network AI anywhere). The store admin opens the spec's example
 * product directly (deterministic), drafts in the store's default locale, edits the draft
 * description, ticks it, and saves with the normal `updateProduct`.
 *
 * "Nothing is saved before Save" is asserted on what leaves the browser: the editor talks to the
 * Admin API only through server actions, so the page's server-action POSTs are recorded — exactly
 * one (the draft) until Save, and the save is the second, carrying the edited text. The
 * `updateProduct` PATCH itself runs on the server, out of the browser's sight, and Prism keeps no
 * state, so a reload cannot show the saved description here; that check needs the core (the
 * core-mode job has no AI provider, so this spec skips there).
 */
test.describe('copy drafts', () => {
  test('the store admin drafts a product description with AI, edits it and saves it', async ({
    page,
  }) => {
    test.skip(AGAINST_CORE, 'mock only: no AI provider in the core-mode job (AI_ENABLED off)');
    const actionPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.headers()['next-action'] !== undefined) {
        actionPosts.push(request.postData() ?? '');
      }
    });

    await signIn(page, `/${BRAND_A}/catalog/${PRODUCT}`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog/${PRODUCT}$`));
    await expect(page.getByRole('heading', { name: 'Draft copy with AI' })).toBeVisible();
    await page.getByRole('button', { name: 'Draft with AI' }).click();

    const region = page.getByRole('region', { name: 'AI draft' });
    await expect(region).toBeVisible();
    await expect(region.getByLabel('Draft provenance')).toContainText(
      /Model \S+ · template \S+ v\d+/,
    );
    await expect(region.getByLabel('Current Description', { exact: true })).toBeVisible();

    await region.getByLabel('Draft Description', { exact: true }).fill(EDITED);
    await expect(region.getByRole('list', { name: 'Changes to Description' })).toContainText(
      'edited by a person before saving',
    );
    // Nothing is ticked on arrival; the person keeps the description.
    await region.getByLabel('Use the drafted description').check();

    // Before Save: the draft was the only call, and nothing carried the edit.
    expect(actionPosts).toHaveLength(1);
    expect(actionPosts[0]).not.toContain('edited by a person');

    await region.getByRole('button', { name: 'Save to product' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved description to the product.' }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'AI draft' })).toHaveCount(0);
    // The save is the second call, and it carries exactly the edited description.
    expect(actionPosts).toHaveLength(2);
    expect(actionPosts[1]).toContain(EDITED);
  });
});
