import { expect, test } from '@playwright/test';
import {
  AGAINST_CORE,
  BACKEND,
  CHECKOUT_STEP,
  JOURNEY_TIMEOUT,
  LISTING_TIMEOUT,
  NAVIGATION_TIMEOUT,
  SERVER_ACTION_TIMEOUT,
  advanceToReview,
  captureOrder,
  clickWhenReady,
  openPurchasableProduct,
  readCards,
  type CapturedOrder,
} from './support/journey';
import { LOCALES, localePath, localeUrl } from './support/locale';
import { reviewAddressLine1 } from './support/ship-address';

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

// ── The journey ──────────────────────────────────────────────────────────────────────────────────

test('PLP → PDP → cart → checkout → confirmation', async ({ page }) => {
  test.setTimeout(JOURNEY_TIMEOUT);

  // An address only this run types. Every run buys the same SKU, one of it, to the same street:
  // without something of its own, a confirmation page showing a *previous* run's order would
  // pass every comparison below. The email is that something — it is ours, not the dataset's.
  const shopperEmail = `e2e-shopper+${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}@example.com`;
  let enteredAddress = false;

  let chosen = { handle: '', sku: '' };
  let reviewed: CapturedOrder = { lines: [], totalMinor: 0, currency: '' };

  await test.step('listing: choose a product that is in stock', async () => {
    chosen = await openPurchasableProduct(page);

    // Back to the listing and in through its own link: the card and the page it leads to agree.
    await page.goto(localePath('/products'));
    const card = page
      .locator(`[data-testid="product-card"][data-handle="${chosen.handle}"]`)
      .first();
    const cardTitle = (await card.getByRole('heading').innerText()).trim();
    await clickWhenReady(page, card.getByRole('heading').getByRole('link'));

    await expect(page).toHaveURL(localeUrl(`/products/${chosen.handle}$`), {
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
    await expect(page).toHaveURL(localeUrl('/cart$'), { timeout: SERVER_ACTION_TIMEOUT });
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
    const visited = await advanceToReview(page, shopperEmail);
    enteredAddress = visited.includes('address');
    // A real cart starts without an address, so against the core this run typed its own. (The
    // mock's example cart already carries one and opens at the payment step.)
    if (AGAINST_CORE) {
      expect(enteredAddress, 'against the core the journey fills in the address step').toBe(true);
    }

    await expect(page).toHaveURL(localeUrl('/checkout/review$'));
    await expect(page.getByRole('heading', { level: 1, name: 'Review your order' })).toBeVisible();
    // Whichever steps this backend required, the address on the review page is the one entered —
    // the brand's configured address when this spec typed it, the mock's example cart otherwise
    // (#449: the NL street was a literal here, and brands B and C failed this one test).
    await expect(
      page.getByText(reviewAddressLine1(enteredAddress), { exact: false }),
    ).toBeVisible();
    expect(visited.length).toBeGreaterThan(0);

    // Captured here rather than in the cart: delivery and tax are only known once the address and
    // the delivery option are, so this is the last — and binding — statement of what is ordered.
    reviewed = await captureOrder(page, 'the review step');
    expect(reviewed.lines.map((line) => line.sku)).toContain(chosen.sku);

    await clickWhenReady(page, page.getByRole('button', { name: 'Place order' }));
  });

  await test.step('confirmation: the order is the one that was reviewed', async () => {
    await expect(page).toHaveURL(localeUrl('/orders/[^/]+$'), { timeout: SERVER_ACTION_TIMEOUT });
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

    // **This run's order, not an earlier one's.** The confirmation shows the email the order was
    // placed with (as a detail — it claims no email was sent, #351), and only this run has ever
    // typed this one.
    if (enteredAddress) {
      await expect(
        page.getByTestId('order-contact'),
        'the confirmation is for the order placed with the email this run entered',
      ).toContainText(shopperEmail);
    }
    expect(new URL(page.url()).pathname.endsWith(`/orders/${orderId}`)).toBe(true);

    // The same lines, the same quantities, the same money as on the review page.
    const placed = await captureOrder(page, 'the confirmation');
    expect(placed.lines, 'the order has the lines that were reviewed').toEqual(reviewed.lines);
    expect(placed.totalMinor, 'the order total is the total that was reviewed').toBe(
      reviewed.totalMinor,
    );
    expect(placed.currency).toBe(reviewed.currency);

    // Against the core this was a real order and one unit of seed stock. Say which, so a run's
    // cost can be read off its output instead of being reconstructed from the database.
    const bought = `${chosen.sku} (${chosen.handle}), order ${orderNumber}, on ${BACKEND}`;
    test.info().annotations.push({ type: 'order placed', description: bought });
    console.info(`[e2e] journey bought ${bought}`);
  });

  await test.step('afterwards: the cart that was ordered is gone', async () => {
    // The second tie to this run, and the only one the mock can show: placing the order consumed
    // the cart. A journey that landed on some other order's page would still have its cart.
    await page.goto(localePath('/cart'));
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();
    await expect(page.getByTestId('order-line')).toHaveCount(0);
  });
});

test('checkout steps cannot be skipped', async ({ page }) => {
  // No cart at all: every checkout URL sends the customer back to the cart.
  await page.goto(localePath('/checkout/review'));
  await expect(page).toHaveURL(localeUrl('/cart$'));
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

  const response = await page.goto(localePath('/products/no-such-product-handle-exists'));
  expect(response?.status()).toBe(404);
});

// ── Sorting and filtering ────────────────────────────────────────────────────────────────────────

test('the sort control puts its choice in the URL and marks it current', async ({ page }) => {
  // Two navigations against the server, like its sibling below: the default 30 s cannot hold both
  // in the first wave of a full parallel run (17.7 s for the listing, ~10 s for the sorted render on
  // 2026-10-04, against 0.1 s alone) — #327.
  test.setTimeout(LISTING_TIMEOUT);
  // What can be checked against either backend: the control itself. Whether the *results* follow
  // is the next test's business.
  await page.goto(localePath('/products'));
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

  test.setTimeout(LISTING_TIMEOUT);

  await page.goto(localePath('/products'));
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
    await page.goto(localePath('/products'));
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
    await expect(page).toHaveURL(localeUrl(`/categories/${target!.category}$`), {
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

    // And the filter removed what does not belong. There has to *be* something that does not
    // belong: if every listed product sits inside the chosen category, "everything shown is a
    // member" holds for a filter that does nothing at all.
    const strangers = all.filter((card) => !family.includes(card.category));
    expect(
      strangers.length,
      `observing a filter needs a listed product outside "${target!.category}" — seed the store`,
    ).toBeGreaterThan(0);
    for (const stranger of strangers) {
      expect(filtered.map((card) => card.handle)).not.toContain(stranger.handle);
    }
  });
});

test('the same page in German is translated and prices are formatted for de-DE', async ({
  page,
}) => {
  test.skip(
    !LOCALES.includes('de-DE'),
    "de-DE is not one of this app's locales (SUPPORTED_LOCALES) — nothing German to check",
  );
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
  await expect(page).toHaveURL(localeUrl('$'));

  // One alternate per locale the app routes (#441 part 1).
  for (const locale of LOCALES) {
    await expect(page.locator(`link[hreflang="${locale}"]`)).toHaveCount(1);
  }
});
