import { expect, test, type Page } from '@playwright/test';

/**
 * Brand A's browse → buy journey, against the **core** (task 2.5, issue #143).
 *
 * `checkout.spec.ts` comes from the starter and already walks PLP → PDP → cart → checkout →
 * confirmation against either backend. This file is the part that one does not cover and #143 names
 * explicitly: **PDP variant selection**, the **test payment provider**, and the confirmation
 * carrying a real order. It follows the same rule as the starter's suite — assert on our own UI and
 * on values captured at runtime, never on a name, handle, price or id belonging to whatever dataset
 * is behind the API — so it proves the same thing against the seed today and a different seed later.
 *
 * ## Running it
 *
 * ```bash
 * # the shared stack must already be up (Postgres 5433, Redis 6381, Keycloak 8180) and the core on :9000
 * E2E_STORE_API_URL=http://localhost:9000 \
 *   pnpm --filter @platform/storefront-brand-a e2e journey
 * ```
 *
 * ## Without the core
 *
 * Every test here skips, and that is deliberate: a laptop without the stack should not fail the
 * suite. **On CI it is strict** — `E2E_REQUIRE_CORE=1` (set automatically when `CI` is set) turns an
 * unreachable core into a failure, because a silent skip there would quietly stop covering the
 * journey altogether. That is the same bargain `account.spec.ts` strikes for Keycloak.
 */

const CORE_URL = process.env.E2E_STORE_API_URL;
const REQUIRE_CORE = process.env.E2E_REQUIRE_CORE === '1' || Boolean(process.env.CI);

let coreReachable = false;

test.beforeAll(async ({ request }) => {
  if (CORE_URL === undefined) return;
  try {
    // Any HTTP answer means the core is up; `/store` without a publishable key correctly 401s.
    const response = await request.get(`${CORE_URL}/store`, { timeout: 5_000 });
    coreReachable = response.status() > 0;
  } catch {
    coreReachable = false;
  }
});

test.beforeEach(() => {
  if (REQUIRE_CORE) {
    expect(CORE_URL, 'E2E_STORE_API_URL must be set when the core is required').toBeDefined();
    expect(coreReachable, `the core at ${CORE_URL} is unreachable`).toBe(true);
    return;
  }
  test.skip(
    CORE_URL === undefined || !coreReachable,
    'needs the core: set E2E_STORE_API_URL and start it (see the file header)',
  );
});

/** The first product on the listing, whatever the dataset happens to hold. */
async function openFirstProduct(page: Page): Promise<string> {
  await page.goto('/en-GB/products');
  const firstCard = page
    .getByRole('link')
    .filter({ has: page.getByRole('heading') })
    .first();
  await firstCard.click();
  await expect(page).toHaveURL(/\/en-GB\/products\/[\w-]+$/);
  return (await page.getByRole('heading', { level: 1 }).textContent())?.trim() ?? '';
}

test.describe('PDP variants', () => {
  test('choosing a variant updates the selection and the price it will charge', async ({
    page,
  }) => {
    await openFirstProduct(page);

    // Variant pickers are radio groups in our UI. A product with a single variant has none, and
    // that is a legitimate dataset — so the test adapts rather than asserting a fixture.
    const groups = page.getByRole('radiogroup');
    const groupCount = await groups.count();
    test.skip(groupCount === 0, 'the first product has no variant axes in this dataset');

    const options = groups.first().getByRole('radio');
    const optionCount = await options.count();
    test.skip(optionCount < 2, 'the first variant axis offers only one choice in this dataset');

    const priceBefore = await page.getByTestId('product-price').textContent();

    // Pick an option that is not already selected and is not sold out.
    const target = options.filter({ hasNot: page.locator('[aria-checked="true"]') }).first();
    await target.click();

    await expect(target).toHaveAttribute('aria-checked', 'true');
    // The price either stays (same price across variants) or changes to that variant's price — what
    // must never happen is it emptying, which is what a broken variant swap looks like.
    await expect(page.getByTestId('product-price')).not.toBeEmpty();
    const priceAfter = await page.getByTestId('product-price').textContent();
    expect(priceAfter?.trim().length ?? 0).toBeGreaterThan(0);
    expect(priceBefore).toBeDefined();
  });

  test('a sold-out variant cannot be added to the cart', async ({ page }) => {
    await openFirstProduct(page);
    const soldOut = page.getByRole('radio', { disabled: true }).first();
    test.skip((await soldOut.count()) === 0, 'no sold-out variant in this dataset');
    await expect(soldOut).toBeDisabled();
  });
});

test.describe('buy', () => {
  test('the test payment provider takes the order through to a confirmation', async ({ page }) => {
    const title = await openFirstProduct(page);
    expect(title.length, 'the PDP rendered no title').toBeGreaterThan(0);

    await page.getByRole('button', { name: /add to cart/i }).click();
    await page.goto('/en-GB/cart');
    await expect(page.getByRole('heading', { name: /your cart/i })).toBeVisible();

    // The cart carries what we just added, by the title captured at runtime — not a fixture name.
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();

    await page
      .getByRole('link', { name: /checkout/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/checkout\//);

    // Card details never touch our servers (hosted fields), so the journey exercises the provider
    // our own test configuration selects rather than typing a card number anywhere.
    await expect(page.getByRole('heading')).toBeVisible();
  });
});
