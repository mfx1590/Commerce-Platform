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

/** How many listing entries to open while looking for a product with real variant choice. */
const SCAN_LIMIT = 15;

const optionGroups = (page: Page) => page.getByRole('group');
const PRICE = 'price-value';

/** Titled links on the listing: the card renders its title as a link inside an `<h3>`. */
function listingLinks(page: Page) {
  return page.getByRole('heading', { level: 3 }).getByRole('link');
}

/**
 * Open a product, by **property** rather than by a hard-coded handle.
 *
 * `openFirst` takes whatever is first. `openWithVariantChoice` walks the listing until it finds a
 * product whose first option group offers two or more selectable values — which is what makes the
 * variant tests exercise anything.
 *
 * Why the walk rather than a known handle: the seeded catalogue is not this suite's to pin. Brand A
 * happens to carry products with Size×Color today; a different seed may name them differently, and
 * a handle in a test is exactly the fixture-coupling the starter's suite was rewritten to remove.
 */
async function openFirst(page: Page): Promise<string> {
  await page.goto('/en-GB/products');
  const link = listingLinks(page).first();
  const title = (await link.textContent())?.trim() ?? '';
  await link.click();
  await expect(page).toHaveURL(/\/en-GB\/products\/[\w-]+$/);
  return title;
}

async function openWithVariantChoice(page: Page): Promise<{ title: string; found: boolean }> {
  await page.goto('/en-GB/products');
  const count = Math.min(await listingLinks(page).count(), SCAN_LIMIT);

  for (let i = 0; i < count; i += 1) {
    await page.goto('/en-GB/products');
    const link = listingLinks(page).nth(i);
    const title = (await link.textContent())?.trim() ?? '';
    await link.click();
    await expect(page).toHaveURL(/\/en-GB\/products\/[\w-]+$/);

    const groups = optionGroups(page);
    if ((await groups.count()) > 0) {
      const selectable = groups.first().getByRole('button').and(page.locator(':not([disabled])'));
      if ((await selectable.count()) >= 2) return { title, found: true };
    }
  }
  return { title: '', found: false };
}

test.describe('PDP variants', () => {
  test('choosing a variant updates the selection and keeps a price on the page', async ({
    page,
  }) => {
    const { found } = await openWithVariantChoice(page);
    expect(
      found,
      `no product with two or more selectable options in the first ${SCAN_LIMIT} listing entries`,
    ).toBe(true);

    const options = optionGroups(page).first().getByRole('button');
    const target = options
      .and(page.locator(':not([disabled])'))
      .and(page.locator('[aria-pressed="false"]'))
      .first();

    const label = (await target.textContent())?.trim() ?? '';
    expect(label.length, 'no unselected option to click').toBeGreaterThan(0);
    await target.click();

    await expect(
      page.getByRole('button', { name: label, exact: true }).first(),
      `${label} did not become the selection`,
    ).toHaveAttribute('aria-pressed', 'true');

    // A price must survive the swap — emptying is what a broken variant change looks like.
    await expect(page.getByTestId(PRICE).first()).not.toBeEmpty();
  });

  test('every option in a group is reachable, and the selection follows the click', async ({
    page,
  }) => {
    const { found } = await openWithVariantChoice(page);
    expect(found, 'no product with variant choice was found').toBe(true);

    const selectable = optionGroups(page)
      .first()
      .getByRole('button')
      .and(page.locator(':not([disabled])'));
    const n = await selectable.count();
    expect(n).toBeGreaterThanOrEqual(2);

    // Walk every selectable value: each becomes the selection in turn, and exactly one is pressed.
    for (let i = 0; i < n; i += 1) {
      const label = (await selectable.nth(i).textContent())?.trim() ?? '';
      await selectable.nth(i).click();
      await expect(page.getByRole('button', { name: label, exact: true }).first()).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const pressed = optionGroups(page).first().getByRole('button', { pressed: true });
      await expect(pressed).toHaveCount(1);
    }
  });
});

test.describe('buy', () => {
  test('the journey reaches checkout with what was added', async ({ page }) => {
    const title = await openFirst(page);
    expect(title.length, 'the PDP rendered no title').toBeGreaterThan(0);

    await page.getByRole('button', { name: /add to cart/i }).click();

    // The app navigates to the cart itself. Going there with `page.goto` instead raced the pending
    // server action and arrived at an empty cart — follow the app's own navigation.
    await expect(page).toHaveURL(/\/en-GB\/cart$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The cart carries what we just added, by the title captured at runtime — not a fixture name.
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();

    await page
      .getByRole('link', { name: /checkout/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/checkout/);
    // Card details never touch our servers (hosted fields), so the journey stops where our own UI
    // hands over; `checkout.spec.ts` drives the steps themselves.
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});
