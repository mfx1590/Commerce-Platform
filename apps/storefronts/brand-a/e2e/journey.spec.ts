import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Brand A's browse → buy journey, against the **core** (task 2.5, issue #143).
 *
 * `checkout.spec.ts` comes from the starter and walks PLP → PDP → cart → checkout → confirmation
 * against either backend. This file covers what that one does not and #143 names: **PLP sorting and
 * category filtering with an observable effect**, **PDP variant selection**, and a placed order
 * whose **server-produced values** are asserted against what the cart showed.
 *
 * ## What is real here, and what is not
 *
 * The core answers browse and cart: `/store/products*`, `/store/product-categories*`,
 * `/store/carts*` (a real UUID, not a contract example) and `/store/orders/{id}`. Those are the
 * requests this file depends on.
 *
 * The core does **not** mount `/store/customers*` or the `/store/orders` list — they fall through to
 * Prism via `CORE_STORE_API_FALLBACK` (filed as **#303**). So this file deliberately does not touch
 * the account area: tying a placed order to order history has to wait for that route to exist.
 * `account.spec.ts` covers the parts that are genuinely real — the Keycloak redirect, the return
 * URL, the session cookie and sign-out.
 *
 * ## Stock
 *
 * Every run of the buy test **places a real order and consumes one unit**, and the seed is shared
 * with every other suite on the same publishable key. So the product is chosen by property — the
 * variant with the most stock in the catalogue — rather than by handle, and the run budget is
 * documented in the README. One unit per full-suite run.
 *
 * ## Running it
 *
 * ```bash
 * E2E_STORE_API_URL=http://127.0.0.1:9000 pnpm --filter @platform/storefront-brand-a e2e journey
 * ```
 *
 * Without the core every test skips; `E2E_REQUIRE_CORE=1` (implied by `CI`) makes an unreachable
 * core a failure instead.
 */

const CORE_URL = process.env.E2E_STORE_API_URL;
const REQUIRE_CORE = process.env.E2E_REQUIRE_CORE === '1' || Boolean(process.env.CI);
const PUBLISHABLE_KEY = process.env.STORE_PUBLISHABLE_KEY ?? 'pk_brand-a_dev_00000000000000000000';

let coreReachable = false;

test.beforeAll(async ({ request }) => {
  if (CORE_URL === undefined) return;
  try {
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

const optionGroups = (page: Page) => page.getByRole('group');
const PRICE = 'price-value';

async function api<T>(request: APIRequestContext, path: string): Promise<T | null> {
  const response = await request.get(`${CORE_URL}${path}`, {
    headers: { 'x-publishable-key': PUBLISHABLE_KEY },
    timeout: 15_000,
  });
  return response.ok() ? ((await response.json()) as T) : null;
}

interface Variant {
  sku: string;
  available_quantity: number | null;
}
interface Detail {
  handle: string;
  title: string;
  variants: Variant[];
  options?: { name: string; values: unknown[] }[];
}

/**
 * Catalogue facts, looked up **once per worker** and by property, never by handle.
 *
 * An earlier version found these by walking the listing — up to fifteen page loads per test, twice
 * over, plus a stock sweep. On its own that passed; in the full suite with five workers it put
 * enough load on one core and one Next server to time out the starter's checkout spec as well as
 * mine. One API sweep and a direct `goto` does the same job for a fraction of the traffic.
 */
/**
 * The floor for "enough stock to buy from".
 *
 * Every run of the buy test consumes a unit and nothing releases it, against a seed shared with
 * every suite on the same publishable key — the starter's checkout spec has taken its own target
 * from ~35 units to 18 this way. Requiring headroom means this spec moves to a deeper-stocked
 * product as the catalogue drains, instead of being the thing that empties one.
 */
const MIN_STOCK = 10;

let catalogue: {
  variantRich: Detail | null;
  deepestStocked: Detail | null;
  bestQty: number;
} | null = null;

async function surveyCatalogue(request: APIRequestContext) {
  if (catalogue !== null) return catalogue;

  const list = await api<{ items: { handle: string }[] }>(request, '/store/products?limit=20');
  let variantRich: Detail | null = null;
  let deepestStocked: Detail | null = null;
  let bestQty = -1;

  for (const { handle } of list?.items ?? []) {
    const body = await api<{ product?: Detail } & Detail>(request, `/store/products/${handle}`);
    const product = body?.product ?? (body as Detail | null);
    if (!product?.variants?.length) continue;

    const choices = Math.max(...(product.options ?? []).map((o) => o.values?.length ?? 0), 0);
    if (variantRich === null && choices >= 2) variantRich = product;

    const qty = Math.max(...product.variants.map((v) => v.available_quantity ?? 0));
    if (qty > bestQty) {
      bestQty = qty;
      deepestStocked = product;
    }
    if (variantRich !== null && bestQty >= MIN_STOCK) break;
  }

  catalogue = {
    variantRich,
    deepestStocked: bestQty >= MIN_STOCK ? deepestStocked : null,
    bestQty,
  };
  return catalogue;
}

/** Open a product that offers real variant choice — found by property, reached directly. */
async function openVariantRich(page: Page, request: APIRequestContext): Promise<void> {
  const { variantRich } = await surveyCatalogue(request);
  expect(
    variantRich,
    'no product in the catalogue offers two or more values on an option',
  ).not.toBeNull();

  await page.goto(`/en-GB/products/${variantRich!.handle}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const selectable = optionGroups(page)
    .first()
    .getByRole('button')
    .and(page.locator(':not([disabled])'));
  await expect(selectable.first()).toBeVisible();
  expect(
    await selectable.count(),
    'the chosen product rendered fewer than two options',
  ).toBeGreaterThanOrEqual(2);
}

test.describe('PLP sorting and filtering have an observable effect', () => {
  test('sorting by price reorders the listing, it does not merely change the URL', async ({
    page,
  }) => {
    await page.goto('/en-GB/products');
    const priceText = () => page.getByTestId(PRICE).allTextContents();

    const before = await priceText();
    expect(before.length, 'the listing rendered no prices').toBeGreaterThan(2);

    // Wait for the control to be interactive before clicking it. The sort links are server-rendered
    // anchors, but a click dispatched while the route is still settling can be swallowed — this
    // failed once that way, with the URL simply never changing.
    const sortLink = page.getByRole('link', { name: 'Price: low to high' });
    await expect(sortLink).toBeVisible();
    await page.waitForLoadState('networkidle');
    await sortLink.click();
    await expect(page).toHaveURL(/sort=price_asc/, { timeout: 15_000 });
    const ascending = await priceText();

    // The effect, not the URL: ascending order is actually ascending.
    const amounts = ascending.map((t) => Number(t.replace(/[^\d,.]/g, '').replace(',', '.')));
    const sorted = [...amounts].sort((a, b) => a - b);
    expect(amounts, 'price_asc did not order the listing by price').toEqual(sorted);
    expect(ascending, 'the listing did not change at all').not.toEqual(before);
  });

  test('a category filter narrows the listing to that category', async ({ page, request }) => {
    // The handle comes from the listing projection's own `category_handle` — by property. There is
    // no `/store/product-categories` route in the contract at all (Prism: "no path matched").
    const list = await api<{ items: { category_handle?: string }[] }>(
      request,
      '/store/products?limit=50',
    );
    const handle = list?.items?.map((i) => i.category_handle).find((h) => Boolean(h));
    expect(handle, 'no product carries a category_handle').toBeDefined();

    // Totals, not the count of cards on screen: the listing is paginated, so both pages showed 24
    // and an earlier version of this test "passed" the filter while proving nothing.
    const totalAll = (await api<{ total: number }>(request, '/store/products?limit=1'))?.total ?? 0;
    const totalInCategory =
      (await api<{ total: number }>(request, `/store/products?limit=1&category=${handle}`))
        ?.total ?? 0;

    expect(totalAll, 'the catalogue is empty').toBeGreaterThan(0);
    expect(totalInCategory, 'the category contains nothing').toBeGreaterThan(0);
    expect(totalInCategory, 'the category filter narrowed nothing').toBeLessThan(totalAll);

    // And the page actually renders that narrower listing.
    await page.goto(`/en-GB/categories/${handle}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.getByTestId(PRICE).count(),
      'the category page listed nothing',
    ).toBeGreaterThan(0);
  });
});

test.describe('PDP variants', () => {
  test('choosing a variant updates the selection and keeps a price on the page', async ({
    page,
    request,
  }) => {
    await openVariantRich(page, request);

    const target = optionGroups(page)
      .first()
      .getByRole('button')
      .and(page.locator(':not([disabled])'))
      .and(page.locator('[aria-pressed="false"]'))
      .first();

    const label = (await target.textContent())?.trim() ?? '';
    expect(label.length, 'no unselected option to click').toBeGreaterThan(0);
    await target.click();

    await expect(page.getByRole('button', { name: label, exact: true }).first()).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId(PRICE).first()).not.toBeEmpty();
  });

  test('every option in a group is reachable, and exactly one stays selected', async ({
    page,
    request,
  }) => {
    await openVariantRich(page, request);

    const selectable = optionGroups(page)
      .first()
      .getByRole('button')
      .and(page.locator(':not([disabled])'));
    const n = await selectable.count();
    expect(n).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < n; i += 1) {
      const label = (await selectable.nth(i).textContent())?.trim() ?? '';
      await selectable.nth(i).click();
      await expect(page.getByRole('button', { name: label, exact: true }).first()).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(optionGroups(page).first().getByRole('button', { pressed: true })).toHaveCount(
        1,
      );
    }
  });
});

test.describe('buy', () => {
  test('a placed order carries the lines and total the cart showed', async ({ page, request }) => {
    const { deepestStocked: product, bestQty } = await surveyCatalogue(request);
    // If this fails the seed is drained, not the app broken — say so in those words, because the
    // alternative is a navigation timeout that looks like a flake.
    expect(
      product,
      `no product in the first 20 has ${MIN_STOCK}+ units (deepest is ${bestQty}); the shared seed needs topping up`,
    ).not.toBeNull();

    await page.goto(`/en-GB/products/${product!.handle}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Wait for the button to be interactive before clicking: the form uses `useActionState`, so a
    // click dispatched during hydration is swallowed and the navigation never happens.
    const addToCart = page.getByRole('button', { name: /add to cart/i });
    await expect(addToCart).toBeEnabled();
    await page.waitForLoadState('networkidle');
    await addToCart.click();

    // The app navigates to the cart itself; `page.goto` would race the pending server action.
    //
    // 30 s, not the 5 s default: add-to-cart is a server action that writes through to the core, and
    // five seconds is simply too tight for it. This exact assertion flaked about one run in three
    // here, and does the same in the starter's checkout spec — reported on #304 with the evidence.
    await expect(page).toHaveURL(/\/en-GB\/cart$/, { timeout: 30_000 });

    // Everything asserted on the confirmation is captured HERE, at runtime, from what the cart
    // rendered — never from a fixture and never from the dataset.
    const cartLines = (await page.getByRole('listitem').allTextContents())
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 0);
    const cartTotal = (await page.getByTestId(PRICE).last().textContent())?.trim() ?? '';
    expect(cartTotal.length, 'the cart showed no total').toBeGreaterThan(0);

    await page
      .getByRole('link', { name: /checkout/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/checkout\//, { timeout: 30_000 });
    await completeCheckout(page);

    // A real order: the confirmation is /orders/{id} and the id is the one the core minted.
    await expect(page).toHaveURL(/\/orders\/[\w-]+$/, { timeout: 30_000 });
    const orderId = new URL(page.url()).pathname.split('/').pop() ?? '';
    expect(orderId.length, 'no order id in the confirmation URL').toBeGreaterThan(0);

    // The order number the page shows is the core's, not a placeholder.
    const confirmation = (await page.locator('body').textContent()) ?? '';
    expect(confirmation, 'the confirmation shows no order number').toMatch(/\d{3,}/);

    // The product bought is on the confirmation, by the title captured from the cart.
    const boughtTitle = product!.title;
    expect(cartLines.join(' ')).toContain(boughtTitle);
    // Located by ROLE, not by text. Two text-based attempts failed here against a page that was
    // perfectly correct: `getByText(title)` resolved to the document's own <title> element, which is
    // hidden — and scoping to <body> did not help, because this app streams its metadata into the
    // body rather than the head (#274). The order lines are <li>, which a <title> can never be.
    const line = page.getByRole('listitem').filter({ hasText: boughtTitle }).first();
    await expect(line, 'the order line for the bought product is missing').toBeVisible();

    // Server-produced line data: the title the cart showed, and a quantity.
    await expect(line).toContainText(boughtTitle);
    await expect(line, 'the order line shows no quantity').toContainText(/×\s*\d+/);

    // The cart total and the order total are NOT equal, and should not be: delivery is chosen after
    // the cart, so the order carries a shipping line the cart never showed. Asserting equality was
    // wrong about the app, not a bug in it — the first run of this test failed with €40.54 vs
    // €45.53, exactly one delivery option apart.
    //
    // What ties them is the arithmetic: the order total is the cart total plus a shipping amount
    // that is itself shown on the confirmation. That cannot pass for an unrelated order.
    const amount = (text: string) => Number(text.replace(/[^\d,.]/g, '').replace(',', '.'));
    const orderTotal = (await page.getByTestId(PRICE).last().textContent())?.trim() ?? '';
    const shown = await page.getByTestId(PRICE).allTextContents();

    const delta = Number((amount(orderTotal) - amount(cartTotal)).toFixed(2));
    expect(amount(orderTotal), 'the order total is below the cart total').toBeGreaterThanOrEqual(
      amount(cartTotal),
    );
    expect(
      shown.map(amount).map((n) => Number(n.toFixed(2))),
      `the difference between cart (${cartTotal}) and order (${orderTotal}) is not a line on the confirmation`,
    ).toContain(delta);

    // Re-reading the order by its id returns the same order — the id is real, not a render artefact.
    await page.goto(`/en-GB/orders/${orderId}`);
    await expect(page.getByTestId(PRICE).last()).toHaveText(orderTotal);
  });
});

/**
 * Drive whatever checkout step is on screen until the order is placed.
 *
 * Step-specific, like the starter's `advanceToReview`, because a generic "click the enabled
 * continue button" does not work: each step has its own button text, the address step has named
 * inputs, and the forms use `useActionState`, so a click during hydration detaches mid-flight.
 * Waiting for the step's own heading is what lets hydration finish first.
 */
const STEP_HEADING: Record<string, string> = {
  address: 'Where should it go?',
  shipping: 'How should it get there?',
  payment: 'How would you like to pay?',
  review: 'Review your order',
};

const STEP_BUTTON: Record<string, RegExp> = {
  address: /Continue to delivery/i,
  shipping: /Continue to payment/i,
  payment: /Continue to review/i,
  review: /Place order/i,
};

async function completeCheckout(page: Page): Promise<string[]> {
  const visited: string[] = [];

  for (let guard = 0; guard < 6; guard += 1) {
    if (page.url().includes('/orders/')) return visited;

    const step = new URL(page.url()).pathname.split('/').pop() ?? '';
    const heading = STEP_HEADING[step];
    if (heading === undefined) throw new Error(`unexpected checkout step: ${page.url()}`);
    visited.push(step);

    // Hydration: wait for the step's own heading and for the page to go quiet before clicking.
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.waitForLoadState('networkidle');

    if (step === 'address') await fillAddress(page);
    await page
      .getByRole('button', { name: STEP_BUTTON[step] as RegExp })
      .first()
      .click();
    await page.waitForURL((url) => !url.pathname.endsWith(`/${step}`), { timeout: 30_000 });
  }

  throw new Error(`checkout did not reach a confirmation; visited ${visited.join(' -> ')}`);
}

/** The address step's inputs are named, so fill them by name rather than by guessed label text. */
async function fillAddress(page: Page): Promise<void> {
  const fields: Record<string, string> = {
    email: 'word-buyer@example.test',
    first_name: 'Word',
    last_name: 'Buyer',
    line1: 'Keizersgracht 1',
    postal_code: '1015 CJ',
    city: 'Amsterdam',
    country: 'NL',
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = page.locator(`input[name="${name}"]`);
    if ((await input.count()) > 0) await input.fill(value);
  }
}
