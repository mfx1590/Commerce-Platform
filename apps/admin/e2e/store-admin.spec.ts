import { expect, test } from '@playwright/test';

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

import { BRAND_A, BRAND_C, sessionCookies, signIn } from './staff';

test.describe('store-admin', () => {
  test('signs in with a password alone and lands on their own store', async ({ page }) => {
    await signIn(page);

    // Conditional OTP (#65): store-admin has no enrolled authenticator, so no challenge.
    await expect(page).not.toHaveURL(/required-action/);
    // `/` sends a principal with no HQ relations to their first store section.
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog`));
    await expect(page.getByRole('heading', { name: 'Catalog' })).toBeVisible();
    // The shell shows `display_name` from GET /admin/me — the Prism mock's "Store Admin" — not the
    // ID token's `name` claim ("Sam StoreAdmin" in the DB seed). The two differ on purpose: the
    // principal is what the API says, not what the token asserts.
    await expect(page.getByText('Store Admin')).toBeVisible();
  });

  test('sees the store view and no HQ view at all', async ({ page }) => {
    await signIn(page);
    await page.waitForURL(/\/catalog/);

    // The Medusa rail (#192): each permitted section is a serpent, a real button with aria-pressed.
    const storeNav = page.getByRole('navigation', { name: 'Brand A' });
    await expect(storeNav.getByRole('button', { name: 'Catalog' })).toBeVisible();
    await expect(storeNav.getByRole('button', { name: 'Settings' })).toBeVisible();
    // store_admin holds nothing on organization:hq, so there is no HQ nav and no scope switch.
    await expect(page.getByRole('navigation', { name: 'HQ' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Scope' })).toHaveCount(0);
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

  test('signing out drops the app session', async ({ page }) => {
    await signIn(page);
    await page.waitForURL(/\/catalog/);
    expect(await sessionCookies(page)).not.toHaveLength(0);

    await page.getByRole('button', { name: 'Sign out' }).click();
    // Sign-out is a chain: the app clears its cookies, then hands off to the realm's end-session
    // endpoint, which returns to the app root. Wait for it to settle before asserting.
    await page.waitForLoadState('load');

    // What this pins is the part this app owns: its own session is gone. Whether the *realm* then
    // re-authenticates silently is Keycloak's SSO policy, not this app's behaviour, so asserting on
    // the landing URL would be testing someone else's decision — and flakily.
    expect(await sessionCookies(page)).toHaveLength(0);
  });

  test('creates a product and lands on its editor', async ({ page }) => {
    await signIn(page, `/${BRAND_A}/catalog`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog`));

    await page.getByRole('link', { name: 'New product' }).click();
    await page.waitForURL(/\/catalog\/new/);

    // Anchored: a substring match on "Title" would also hit "Subtitle" and trip strict mode.
    await page.getByLabel(/^Title/).fill('E2E Tee');
    await page.getByLabel(/^Handle/).fill('e2e-tee');
    await page.getByRole('button', { name: 'Create product' }).click();

    // The mock answers with its own example product, so the id in the URL is the API's, not ours —
    // which is the point: the app navigates to what was created, it does not guess.
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();

    // The status control renders what the API returned rather than an assumed "draft".
    const status = page.getByRole('heading', { name: 'Status' });
    await expect(status).toBeVisible();
  });

  test('publishing asks first', async ({ page }) => {
    await signIn(page, `/${BRAND_A}/catalog`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog`));

    // Open the first product in the list.
    await page.getByRole('table', { name: 'Products' }).getByRole('link').first().click();
    await page.waitForURL(new RegExp(`/${BRAND_A}/catalog/[0-9a-f-]{36}$`));

    const publish = page.getByRole('button', { name: 'Publish' });
    // Prism's only product example is already `published`, so the button is disabled and the click
    // path cannot be exercised here. What this pins is that publishing is never a one-click action:
    // either it is unavailable, or it asks. The confirm-then-call chain is covered in
    // test/catalog-refusals.test.tsx and against a real core (see README).
    if (await publish.isEnabled()) {
      await publish.click();
      await expect(page.getByText(/becomes visible to shoppers/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Yes, publish' })).toBeVisible();
    } else {
      await expect(publish).toBeDisabled();
    }
  });

  test('orders: the list renders money and pills from the Admin API, the detail opens', async ({
    page,
  }) => {
    await signIn(page, `/${BRAND_A}/orders`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/orders`));

    const table = page.getByRole('table', { name: 'Orders' });
    await expect(table).toBeVisible();
    // The mock's example: #1000, confirmed, captured, unfulfilled, €29.18.
    await expect(table.getByRole('link', { name: '#1000' })).toBeVisible();
    await expect(table.getByText('confirmed')).toBeVisible();
    await expect(table.getByText(/29[.,]18/)).toBeVisible();

    await table.getByRole('link', { name: '#1000' }).click();
    await page.waitForURL(new RegExp(`/${BRAND_A}/orders/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { name: 'Order #1000' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Order lines' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Order timeline' })).toBeVisible();
  });

  test('orders: a refund asks first and states the ceiling', async ({ page }) => {
    await signIn(page, `/${BRAND_A}/orders`);
    await page.getByRole('table', { name: 'Orders' }).getByRole('link', { name: '#1000' }).click();
    await page.waitForURL(new RegExp(`/${BRAND_A}/orders/[0-9a-f-]{36}$`));

    // store_admin implies support, so the refund is offered; the mock's payment is captured.
    await page.getByRole('button', { name: 'Refund', exact: true }).click();
    await expect(page.getByText(/can still be refunded/)).toBeVisible();
    const confirm = page.getByRole('button', { name: /Yes, refund/ });
    await expect(confirm).toBeVisible();
    await confirm.click();
    // Prism answers 201 with its Refund example; the screen reports the request and refreshes.
    await expect(page.getByRole('status')).toHaveText(/Refund of .* requested/);
  });

  test('customers: support-gated list and a server-rendered detail with consent', async ({
    page,
  }) => {
    // store_admin implies support, so the section is offered and the direct URL renders data.
    await signIn(page, `/${BRAND_A}/customers`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/customers`));

    const table = page.getByRole('table', { name: 'Customers' });
    await expect(table).toBeVisible();
    await table.getByRole('link', { name: 'jane@example.com' }).click();
    await page.waitForURL(new RegExp(`/${BRAND_A}/customers/[0-9a-f-]{36}$`));

    await expect(page.getByRole('heading', { name: 'Jane Doe' })).toBeVisible();
    const consent = page.getByRole('table', { name: 'Consent by channel' });
    // Cells, not text: the "Granted" column header would otherwise match too.
    await expect(consent.getByRole('cell', { name: 'marketing email' })).toBeVisible();
    await expect(consent.getByRole('cell', { name: 'granted' })).toBeVisible();
    await expect(consent.getByRole('cell', { name: 'checkout' })).toBeVisible();
    // The order-history link carries the email into the orders filter.
    await expect(page.getByRole('link', { name: 'Orders by this customer' })).toHaveAttribute(
      'href',
      new RegExp(`/${BRAND_A}/orders\\?q=jane%40example\\.com$`),
    );
    // Erasure is never one click: the typed confirmation gates it.
    await page.getByRole('button', { name: 'Erase this customer' }).click();
    await expect(page.getByRole('button', { name: 'Yes, erase' })).toBeDisabled();
  });

  test('promotions: the list describes values, the form validates per type before anything is sent', async ({
    page,
  }) => {
    await signIn(page, `/${BRAND_A}/promotions`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/promotions$`));

    const table = page.getByRole('table', { name: 'Promotions' });
    await expect(table).toBeVisible();
    // The mock's example: WELCOME10, 10 %, active.
    await expect(table.getByText('WELCOME10')).toBeVisible();
    await expect(table.getByText(/10 %/)).toBeVisible();
    // The usage card from the marketing report.
    await expect(page.getByRole('table', { name: 'Promotion usage' })).toBeVisible();

    await page.getByRole('link', { name: 'New promotion' }).click();
    await page.waitForURL(/\/promotions\/new/);
    await page.getByLabel(/^Name/).fill('E2E percent');
    await page.getByLabel(/^Code/).fill('e2e10');
    // Percentage without a value: refused client-side, with the message under the field.
    await page.getByRole('button', { name: 'Create promotion' }).click();
    await expect(page.getByText('Enter a percentage')).toBeVisible();
    await page.getByLabel(/^Percentage/).fill('12.5');
    await page.getByRole('button', { name: 'Create promotion' }).click();
    // The mock answers 201 with its example; the app navigates to what was created.
    await page.waitForURL(new RegExp(`/${BRAND_A}/promotions/[0-9a-f-]{36}$`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('price lists: the CSV preview rejects a bad row and never offers to import it', async ({
    page,
  }) => {
    await signIn(page, `/${BRAND_A}/promotions/price-lists`);
    await page.waitForURL(/\/promotions\/price-lists$/);
    const lists = page.getByRole('table', { name: 'Price lists' });
    await lists.getByRole('link').first().click();
    await page.waitForURL(new RegExp(`/${BRAND_A}/promotions/price-lists/[0-9a-f-]{36}`));

    const csv = page.getByLabel('CSV');
    await expect(csv).toBeVisible();
    // `listProducts` has no example in the spec, so Prism generates the products and their SKUs:
    // the known SKU is read from the editor's first row rather than assumed. The second CSV row
    // is unknown, the third has three decimals in a two-decimal currency.
    const firstSku = page
      .locator('table[aria-label^="Prices in"] tbody tr')
      .first()
      .locator('.font-mono')
      .first();
    await expect(firstSku).toBeVisible();
    const sku = (await firstSku.innerText()).trim();
    await csv.fill(`sku,amount\n${sku},19.99\nNOPE,1\n${sku},1.999`);
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('1 accepted · 2 rejected')).toBeVisible();
    const preview = page.getByRole('table', { name: 'CSV preview' });
    await expect(preview.getByText('Unknown SKU or variant: NOPE')).toBeVisible();
    await expect(preview.getByText(/not a whole number of minor units/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import 1 accepted row' })).toBeVisible();
  });

  test('the media rows can be reordered in the editor', async ({ page }) => {
    await signIn(page, `/${BRAND_A}/catalog/new`);
    await page.waitForURL(/\/catalog\/new/);

    await page.getByRole('button', { name: 'Add image' }).click();
    await page.getByRole('button', { name: 'Add image' }).click();

    await page.getByLabel(/Image URL \(thumbnail\)/).fill('https://cdn.example.com/a.jpg');
    await page.getByLabel('Image URL', { exact: true }).fill('https://cdn.example.com/b.jpg');

    await page.getByRole('button', { name: 'Move image 2 up' }).click();
    // The row that was second is now the thumbnail — which is the whole reason the control exists.
    await expect(page.getByLabel(/Image URL \(thumbnail\)/)).toHaveValue(
      'https://cdn.example.com/b.jpg',
    );
  });
});
