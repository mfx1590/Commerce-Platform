import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The journey the storefront exists to support, end to end — against **either** backend.
 *
 * Phase 1 wrote this against Prism, and it quietly encoded the mock: the fixture's product name
 * (`Classic Tee`), its handle, its price, its SKU, Jane's street, and the fact that the mock returns
 * a cart that already carries an address and a delivery option, so checkout always opened at the
 * payment step. Every one of those is false against the core with seeded data, which is why the
 * suite could not run there at all (task 2.1).
 *
 * The rule this file follows: assert on **our own UI** — copy we ship in the message catalogue,
 * roles, and structure — and on values **captured at runtime** from the page. Never on a name, a
 * handle, a price or an id that belongs to whatever dataset happens to be behind the API.
 *
 * Capturing is not optional decoration (#304). The first version of that rule stopped at "the
 * confirmation page has the right heading", which a storefront that placed the wrong lines, the
 * wrong total or somebody else's order would also pass. The journey now reads the lines and the
 * total off the review page — in minor units, from the `data-*` hooks in `src/lib/test-hooks.ts` —
 * and requires the confirmation to show the same ones under an order number.
 *
 * What each backend can prove:
 *
 * - **Prism** is stateless and answers with the contract's examples. The cart, the review and the
 *   order are three examples that happen to agree, so the journey proves the pages *render* what
 *   the API returned, consistently — not that an order was really placed. Sorting and filtering
 *   cannot be observed at all (see that test).
 * - **The core** proves the rest: a real cart, a real order, a real order of results.
 *   `E2E_STORE_API_URL=http://localhost:9000 pnpm --filter @platform/storefront-starter e2e`
 *   (see the README, "Running against the core"). **A run against the core places one real order
 *   and nothing cancels it**: it consumes one unit of seed stock. That budget is finite — see
 *   `openPurchasableProduct` for what happens when it runs out.
 */

const AGAINST_CORE = process.env.E2E_STORE_API_URL !== undefined;
const BACKEND = AGAINST_CORE ? 'the core' : 'the Prism mock';

const CHECKOUT_STEP = /\/checkout\/(address|shipping|payment|review)$/;

/** A guard against a redirect cycle, not a real iteration count: there are four steps. */
const CHECKOUT_STEPS_MAX = 5;

/**
 * The `<h1>` of each step, from our own message catalogue.
 *
 * Waiting for it before acting is not decoration: the step forms use `useActionState`, so React
 * replaces the server-rendered form at hydration and a button clicked in that window detaches
 * mid-click ("element was detached from the DOM"). Waiting for the heading and for the page to go
 * quiet lets hydration finish first.
 */
const STEP_HEADING: Record<string, string> = {
  address: 'Where should it go?',
  shipping: 'How should it get there?',
  payment: 'How would you like to pay?',
};

async function settleOn(page: Page, step: string): Promise<void> {
  const heading = STEP_HEADING[step];
  if (heading === undefined) throw new Error(`No heading known for checkout step "${step}"`);

  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Fill the address step. The values are ours, not the dataset's, so they are safe to assert on. */
async function completeAddressStep(page: Page): Promise<void> {
  await page.locator('input[name="email"]').fill('e2e-shopper@example.com');
  await page.locator('input[name="first_name"]').fill('Ada');
  await page.locator('input[name="last_name"]').fill('Lovelace');
  await page.locator('input[name="line1"]').fill('Keizersgracht 1');
  await page.locator('input[name="postal_code"]').fill('1015 CJ');
  await page.locator('input[name="city"]').fill('Amsterdam');
  await page.locator('input[name="country"]').fill('NL');
  await page.getByRole('button', { name: 'Continue to delivery' }).click();
}

/**
 * Walk the funnel to the review step, whatever step the cart actually opens at.
 *
 * Prism returns a cart that already has an address and a delivery option, so it starts at payment;
 * a real cart from the core starts at address. Driving whatever step is on screen is what makes one
 * spec cover both — and it exercises more of the funnel against the core, not less.
 */
async function advanceToReview(page: Page): Promise<string[]> {
  const visited: string[] = [];

  for (let guard = 0; guard < CHECKOUT_STEPS_MAX; guard += 1) {
    const step = new URL(page.url()).pathname.split('/').pop() ?? '';
    if (step === 'review') return visited;
    visited.push(step);
    await settleOn(page, step);

    switch (step) {
      case 'address':
        await completeAddressStep(page);
        break;
      case 'shipping':
        // The first option is preselected, so submitting is a real choice, not a no-op.
        await page.getByRole('button', { name: 'Continue to payment' }).click();
        break;
      case 'payment':
        await page.getByRole('button', { name: 'Continue to review' }).click();
        break;
      default:
        throw new Error(`Unexpected checkout step: ${page.url()}`);
    }

    // Wait for the step to actually *change*. Waiting on `CHECKOUT_STEP` alone matches the URL we
    // are already on, so the loop would come round and click the same button again — by which time
    // the form has disabled it for the submit that is already in flight, and the click hangs.
    await page.waitForURL((url) => !url.pathname.endsWith(`/${step}`));
  }

  throw new Error(`Checkout did not reach the review step; visited ${visited.join(' → ')}`);
}

// ── Clicking, and how long to wait for what it starts ────────────────────────────────────────────

/**
 * Two deadlines, because a click here starts one of two different things (#304).
 *
 * Playwright's default for `expect(page).toHaveURL()` is 5 s. That is ample for a client-side route
 * change and too tight for a **server action that writes through to the core**: "Add to cart" and
 * "Place order" answer when the core has. Measured by window 10 on a quiet machine, the cart step
 * missed the 5 s deadline about one run in three — the page was not broken, the deadline was wrong.
 */
const SERVER_ACTION_TIMEOUT = 30_000;
const NAVIGATION_TIMEOUT = 15_000;

/**
 * Click a control once the page can act on it.
 *
 * The other half of the same flake: a click dispatched before hydration has attached the handler is
 * swallowed — the sort link was clicked, the URL never changed, and the test waited out its deadline
 * on a page that was fine (one run in four on a quiet machine). Visible, enabled and the network
 * quiet is the same settling `settleOn` does for the checkout steps.
 */
async function clickWhenReady(page: Page, control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  await page.waitForLoadState('networkidle');
  await control.click();
}

// ── Reading the page ─────────────────────────────────────────────────────────────────────────────

interface ListedProduct {
  handle: string;
  priceMinor: number;
  /** `''` when the product has no category. */
  category: string;
}

/** The cards of the listing on screen, in the order they are shown. */
async function readCards(page: Page): Promise<ListedProduct[]> {
  const cards = await page.getByTestId('product-card').evaluateAll((elements) =>
    elements.map((element) => ({
      handle: element.getAttribute('data-handle') ?? '',
      priceMinor: Number(element.getAttribute('data-price-minor')),
      category: element.getAttribute('data-category') ?? '',
    })),
  );
  for (const card of cards) {
    expect(card.handle, 'every card names its product').not.toBe('');
    expect(Number.isInteger(card.priceMinor), `${card.handle} carries a price in minor units`).toBe(
      true,
    );
  }
  return cards;
}

interface CapturedLine {
  sku: string;
  quantity: number;
  totalMinor: number;
}

interface CapturedOrder {
  lines: CapturedLine[];
  totalMinor: number;
  currency: string;
}

/** The lines and the total of the cart or order on screen — as numbers, not as formatted text. */
async function captureOrder(page: Page, where: string): Promise<CapturedOrder> {
  const lines = await page.getByTestId('order-line').evaluateAll((elements) =>
    elements.map((element) => ({
      sku: element.getAttribute('data-sku') ?? '',
      quantity: Number(element.getAttribute('data-quantity')),
      totalMinor: Number(element.getAttribute('data-total-minor')),
    })),
  );
  expect(lines.length, `${where} shows at least one line`).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line.sku, `${where}: every line names a SKU`).not.toBe('');
    expect(
      Number.isInteger(line.quantity) && line.quantity > 0,
      `${where}: ${line.sku} has a whole, positive quantity (got ${line.quantity})`,
    ).toBe(true);
    expect(Number.isInteger(line.totalMinor), `${where}: ${line.sku} has a line total`).toBe(true);
  }

  const totals = page.getByTestId('order-totals');
  await expect(totals, `${where} shows one totals table`).toHaveCount(1);
  const totalMinor = Number(await totals.getAttribute('data-total-minor'));
  expect(Number.isInteger(totalMinor), `${where} carries a total in minor units`).toBe(true);

  return {
    // Sorted so that two pages listing the same lines in a different order still compare equal.
    lines: [...lines].sort((a, b) => a.sku.localeCompare(b.sku)),
    totalMinor,
    currency: (await totals.getAttribute('data-currency')) ?? '',
  };
}

/** How many listed products the journey will open looking for one it can buy. */
const PURCHASABLE_SEARCH_LIMIT = 12;

/**
 * Open the PDP of the first listed product that can actually be bought, chosen by the stock the
 * storefront itself reports — never "whatever is first".
 *
 * This matters against the core only, and there it matters a great deal: every run places a real
 * order, the core reserves stock for it, and nothing in this suite cancels it. Buying "the first
 * product" drains one product's seed stock run by run until the add-to-cart button is disabled
 * and the journey dies in a timeout that says nothing about why. Moving on to the next product
 * spreads the cost; and when *nothing* is left, the failure says so.
 */
async function openPurchasableProduct(page: Page): Promise<{ handle: string; sku: string }> {
  await page.goto('/en-GB/products');
  await expect(page.getByRole('heading', { level: 1, name: 'All products' })).toBeVisible();

  const handles = [...new Set((await readCards(page)).map((card) => card.handle))].slice(
    0,
    PURCHASABLE_SEARCH_LIMIT,
  );
  expect(handles.length, `the listing on ${BACKEND} shows at least one product`).toBeGreaterThan(0);

  const rejected: string[] = [];
  for (const handle of handles) {
    await page.goto(`/en-GB/products/${handle}`);
    const form = page.getByTestId('add-to-cart');
    await expect(form, `${handle} renders an add-to-cart form`).toHaveCount(1);

    if ((await form.getAttribute('data-purchasable')) === 'true') {
      const sku = (await form.getAttribute('data-sku')) ?? '';
      expect(sku, `${handle}: the variant on offer names its SKU`).not.toBe('');
      return { handle, sku };
    }
    rejected.push(`${handle} (${(await form.getAttribute('data-availability')) ?? 'unknown'})`);
  }

  throw new Error(
    `Seed stock exhausted — reseed. None of the first ${handles.length} listed product(s) on ` +
      `${BACKEND} can be bought: ${rejected.join(', ')}. A run against the core places one real ` +
      'order and nothing cancels it, so the seed stock is a finite budget ' +
      '(README, "Running against the core").',
  );
}

// ── The journey ──────────────────────────────────────────────────────────────────────────────────

test('PLP → PDP → cart → checkout → confirmation', async ({ page }) => {
  let chosen = { handle: '', sku: '' };
  let reviewed: CapturedOrder = { lines: [], totalMinor: 0, currency: '' };

  await test.step('listing: choose a product that is in stock', async () => {
    chosen = await openPurchasableProduct(page);

    // Back to the listing and in through its own link: the card and the page it leads to agree.
    await page.goto('/en-GB/products');
    const card = page
      .locator(`[data-testid="product-card"][data-handle="${chosen.handle}"]`)
      .first();
    const cardTitle = (await card.getByRole('heading').innerText()).trim();
    await clickWhenReady(page, card.getByRole('heading').getByRole('link'));

    await expect(page).toHaveURL(new RegExp(`/en-GB/products/${chosen.handle}$`), {
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(cardTitle);
  });

  await test.step('detail: add it to the cart', async () => {
    // A price is rendered on the server, before any hydration — the amount itself is data.
    await expect(page.getByTestId('price-value').first()).toBeVisible();
    await expect(page.getByTestId('price-value').first()).not.toBeEmpty();

    await clickWhenReady(page, page.getByRole('button', { name: 'Add to cart' }));
  });

  await test.step('cart: the variant that was added is the line in the cart', async () => {
    // The add-to-cart action answers when the core has: its own deadline, not the 5 s default.
    await expect(page).toHaveURL(/\/en-GB\/cart$/, { timeout: SERVER_ACTION_TIMEOUT });
    await expect(page.getByRole('heading', { level: 1, name: 'Cart' })).toBeVisible();

    const cart = await captureOrder(page, 'the cart');
    expect(
      cart.lines.map((line) => line.sku),
      'the cart holds the SKU the product page offered',
    ).toContain(chosen.sku);

    await clickWhenReady(page, page.getByRole('link', { name: 'Checkout' }));
  });

  await test.step('checkout: what the customer agrees to', async () => {
    await expect(page).toHaveURL(CHECKOUT_STEP, { timeout: NAVIGATION_TIMEOUT });
    const visited = await advanceToReview(page);

    await expect(page).toHaveURL(/\/en-GB\/checkout\/review$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Review your order' })).toBeVisible();
    // Whichever steps this backend required, the address on the review page is the one entered —
    // either by this spec, or by the fixture the mock returns.
    await expect(page.getByText(/Keizersgracht 1/)).toBeVisible();
    expect(visited.length).toBeGreaterThan(0);

    // Captured here rather than in the cart: delivery and tax are only known once the address and
    // the delivery option are, so this is the last — and binding — statement of what is ordered.
    reviewed = await captureOrder(page, 'the review step');
    expect(reviewed.lines.map((line) => line.sku)).toContain(chosen.sku);

    await clickWhenReady(page, page.getByRole('button', { name: 'Place order' }));
  });

  await test.step('confirmation: the order is the one that was reviewed', async () => {
    await expect(page).toHaveURL(/\/en-GB\/orders\/[^/]+$/, { timeout: SERVER_ACTION_TIMEOUT });
    await expect(page.getByRole('heading', { level: 1, name: 'Thank you' })).toBeVisible();
    await expect(page.getByText('Order placed')).toBeVisible();

    // An order number, produced by the server, shown to the customer, and for the order in the URL.
    const confirmation = page.getByTestId('order-confirmation');
    const orderNumber = (await confirmation.getAttribute('data-order-number')) ?? '';
    const orderId = (await confirmation.getAttribute('data-order-id')) ?? '';
    expect(orderNumber, 'the confirmation carries an order number').not.toBe('');
    await expect(confirmation, 'the order number is told to the customer').toContainText(
      orderNumber,
    );
    expect(orderId, 'the confirmation carries the order id').not.toBe('');
    expect(new URL(page.url()).pathname.endsWith(`/orders/${orderId}`)).toBe(true);

    // The same lines, the same quantities, the same money as on the review page.
    const placed = await captureOrder(page, 'the confirmation');
    expect(placed.lines, 'the order has the lines that were reviewed').toEqual(reviewed.lines);
    expect(placed.totalMinor, 'the order total is the total that was reviewed').toBe(
      reviewed.totalMinor,
    );
    expect(placed.currency).toBe(reviewed.currency);
  });
});

test('checkout steps cannot be skipped', async ({ page }) => {
  // No cart at all: every checkout URL sends the customer back to the cart.
  await page.goto('/en-GB/checkout/review');
  await expect(page).toHaveURL(/\/en-GB\/cart$/);
  await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();
});

// A missing product cannot be exercised against Prism: it answers `GET /store/products/{handle}`
// with the contract's example whatever the handle is, so every handle "exists". Against the core a
// genuinely unknown handle is a 404, so this asserts the 404 page only when the core is the backend.
test('an unknown product handle is a 404 against the core', async ({ page }) => {
  test.skip(
    !AGAINST_CORE,
    'Prism answers every handle with the contract example; only the core can 404.',
  );

  const response = await page.goto('/en-GB/products/no-such-product-handle-exists');
  expect(response?.status()).toBe(404);
});

// ── Sorting and filtering ────────────────────────────────────────────────────────────────────────

test('the sort control puts its choice in the URL and marks it current', async ({ page }) => {
  // What can be checked against either backend: the control itself. Whether the *results* follow
  // is the next test's business.
  await page.goto('/en-GB/products');
  await clickWhenReady(page, page.getByRole('link', { name: 'Price: low to high' }));

  await expect(page).toHaveURL(/sort=price_asc/, { timeout: NAVIGATION_TIMEOUT });
  await expect(page.getByRole('heading', { level: 1, name: 'All products' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Price: low to high' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByRole('link', { name: 'Price: high to low' })).not.toHaveAttribute(
    'aria-current',
    'true',
  );
});

test('sorting reorders the listing and a category narrows it', async ({ page }) => {
  // **Real only against the core.** Prism answers `GET /store/products` with the same example
  // whatever `sort` or `category` it is sent, so against it no assertion below could fail — and
  // adding examples to the contract would not change that, because Prism does not read the query.
  // Skipped there with the reason, rather than left as a test that passes by construction.
  test.skip(
    !AGAINST_CORE,
    'mock-only run: Prism returns the same example for every sort and category, so an order or a ' +
      'filtered set cannot be observed. Run against the core: E2E_STORE_API_URL=http://localhost:9000',
  );

  await page.goto('/en-GB/products');
  const all = await readCards(page);
  // Against the core this is a failure, not a skip: with fewer than two products nothing here can
  // be observed, and a store seeded that thin should not report a green listing test.
  expect(
    all.length,
    'observing an order needs at least two listed products — seed the store',
  ).toBeGreaterThanOrEqual(2);

  await test.step('price ascending, then descending', async () => {
    await clickWhenReady(page, page.getByRole('link', { name: 'Price: low to high' }));
    await expect(page).toHaveURL(/sort=price_asc/, { timeout: NAVIGATION_TIMEOUT });
    const ascending = (await readCards(page)).map((card) => card.priceMinor);
    expect(ascending, 'low to high').toEqual([...ascending].sort((a, b) => a - b));

    await clickWhenReady(page, page.getByRole('link', { name: 'Price: high to low' }));
    await expect(page).toHaveURL(/sort=price_desc/, { timeout: NAVIGATION_TIMEOUT });
    const descending = (await readCards(page)).map((card) => card.priceMinor);
    expect(descending, 'high to low').toEqual([...descending].sort((a, b) => b - a));

    // Two sorted lists prove nothing if every price is the same: the two orders must also differ
    // from each other, which they do as soon as the catalogue has two prices.
    const distinctPrices = new Set([...ascending, ...descending]).size;
    expect(
      distinctPrices,
      'observing a price order needs at least two different prices — seed the store',
    ).toBeGreaterThanOrEqual(2);
    expect(ascending[0]).toBeLessThan(descending[0]!);
  });

  await test.step('a category shows that category and nothing else', async () => {
    await page.goto('/en-GB/products');
    const target = all.find((card) => card.category !== '');
    expect(target, 'at least one listed product has a category').toBeDefined();

    const filter = page.getByRole('navigation', { name: 'Categories' });
    const link = filter.locator(`a[data-category="${target!.category}"]`);
    await expect(link, `the filter offers "${target!.category}"`).toHaveCount(1);

    // The category and whatever is nested under it in the filter: a parent category lists its
    // children's products too, and those are not strangers.
    const family = await link
      .locator('xpath=..')
      .locator('a[data-category]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-category')));

    await clickWhenReady(page, link);
    await expect(page).toHaveURL(new RegExp(`/en-GB/categories/${target!.category}$`), {
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(
      page
        .getByRole('navigation', { name: 'Categories' })
        .locator(`a[data-category="${target!.category}"]`),
    ).toHaveAttribute('aria-current', 'page');

    const filtered = await readCards(page);
    expect(
      filtered.map((card) => card.handle),
      'the product the category was taken from is in it',
    ).toContain(target!.handle);
    expect(
      filtered.filter((card) => !family.includes(card.category)).map((card) => card.handle),
      `everything listed under "${target!.category}" belongs to it`,
    ).toEqual([]);

    // And the filter removed what does not belong, where the full listing had any such product.
    const strangers = all.filter((card) => !family.includes(card.category));
    for (const stranger of strangers) {
      expect(filtered.map((card) => card.handle)).not.toContain(stranger.handle);
    }
  });
});

test('the same page in German is translated and prices are formatted for de-DE', async ({
  page,
}) => {
  await page.goto('/de-DE/products');
  await expect(page.getByRole('heading', { level: 1, name: 'Alle Produkte' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Preis: aufsteigend' })).toBeVisible();
  // The amount is data; the *formatting* is ours. de-DE puts the symbol last and uses a comma,
  // so a German price ends with the symbol rather than starting with it.
  await expect(page.getByTestId('price-value').first()).toHaveText(/\d+,\d{2}\s*\S+$/);
});

test('the root redirects to the default locale and offers hreflang alternates', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/en-GB$/);

  for (const locale of ['en-GB', 'de-DE']) {
    await expect(page.locator(`link[hreflang="${locale}"]`)).toHaveCount(1);
  }
});
