import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import {
  AGAINST_CORE,
  BACKEND,
  CHECKOUT_STEP,
  JOURNEY_TIMEOUT,
  NAVIGATION_TIMEOUT,
  SERVER_ACTION_TIMEOUT,
  captureOrder,
  clickWhenReady,
  hydrated,
  openPurchasableProduct,
  readCards,
  settleOn,
} from './support/journey';

/**
 * Brand B's own journey (#437, task 3.1).
 *
 * The specs the clone inherited from the starter — `checkout.spec.ts`, `account.spec.ts`,
 * `order-lifecycle.spec.ts` and the rest — already walk the funnel and are **not** repeated here.
 * What they cannot assert is what makes this app brand **B** rather than the starter, and that is
 * what this file is for:
 *
 * - **One locale.** B sells in `en-GB` only (`cms/src/datasets.ts`, and `store.locales` in the
 *   seed), where the starter routes `en-GB` and `de-DE`. The list is set by `SUPPORTED_LOCALES`,
 *   which `next.config.mjs` defaults to `en-GB` for this brand — `src/i18n/routing.ts` is synced and
 *   must not be edited per brand. A brand that silently kept the starter's two locales would serve a
 *   German URL space with no German content, so this is worth a test rather than a comment.
 * - **Pounds — against the core only.** B's store is GBP (`packages/db` seed). A brand app takes its
 *   currency from the Store API, so a wrong publishable key — the easiest brand-clone mistake —
 *   shows up as the *other* brand's currency on the page.
 *
 *   This cannot be asserted against the **Prism mock**, which serves the contract's *example* store
 *   (EUR, brand A's shape) whatever key is sent: a mock run renders `€19.99` on brand B and is
 *   right to. Measured, not assumed — the first mock run of this spec failed on exactly that. So the
 *   currency test is gated on the core, like every other fact only the core knows.
 *
 * The locale tests run against either backend: routing is this app's own configuration and owes the
 * API nothing. Nothing here asserts a dataset value (a product name, a price) — only this app's
 * configuration and what the page itself declares.
 */

const LISTING = '/en-GB/products';

test.describe('brand B is brand B', () => {
  test('serves its own locale, and does not route the one it does not sell', async ({ page }) => {
    const ok = await page.goto(LISTING);
    expect(ok?.status(), 'en-GB is the locale this brand sells in').toBeLessThan(400);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');

    // de-DE is the starter's second locale and brand A's: brand B must not route it. 404 and a
    // redirect to the default locale are both acceptable answers — what matters is that the page is
    // not served AS de-DE, because there is no de-DE content for this brand.
    const response = await page.goto('/de-DE/products');
    const status = response?.status() ?? 0;
    if (status < 400) {
      await expect(
        page.locator('html'),
        'a locale brand B does not sell must not be served as that locale',
      ).not.toHaveAttribute('lang', 'de-DE');
    } else {
      expect(status, 'an unsold locale is refused').toBeGreaterThanOrEqual(400);
    }
  });

  test('prices the listing in pounds', async ({ page }) => {
    test.skip(
      !AGAINST_CORE,
      `needs the core: ${BACKEND} serves the contract's example store (EUR) for any key, so a ` +
        'currency assertion here would test the mock, not brand B',
    );
    await page.goto(LISTING);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await hydrated(page);

    // Captured from the page, never from a fixture: the cards carry the amount in minor units and
    // the rendered text carries the currency the Store API resolved from this app's publishable key.
    const cards = await readCards(page);
    expect(cards.length, 'the listing shows at least one product').toBeGreaterThan(0);

    const prices = await page.getByTestId('price-value').allTextContents();
    expect(prices.length, 'the listing renders prices').toBeGreaterThan(0);
    const rendered = prices.join(' ');
    expect(rendered, `expected pounds on brand B's listing, got: ${rendered}`).toContain('£');
    // Named, not guessed: a euro price means this app resolved brand A's store, which is what a
    // copied publishable key looks like from the outside.
    expect(rendered, 'a euro price here means the wrong publishable key').not.toContain('€');

    // And the page agrees with itself: the symbol it rendered matches the currency it declares.
    const declared = await page.getByTestId('price-value').first().getAttribute('data-currency');
    expect(declared, 'brand B is a GBP store').toBe('GBP');
  });

  test('its own pages render: home, listing, product', async ({ page }) => {
    await page.goto('/en-GB');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });

    await page.goto(LISTING);
    await hydrated(page);
    const cards = await readCards(page);
    expect(cards.length).toBeGreaterThan(0);

    await page.goto(`/en-GB/products/${cards[0]!.handle}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
      timeout: NAVIGATION_TIMEOUT,
    });
    await expect(page.getByTestId('price-value').first()).not.toBeEmpty();
  });
});

/**
 * Brand B's own funnel: place an order, ship it, deliver it (#437).
 *
 * **Why this is here and not inherited.** `e2e/support/journey.ts`'s `completeAddressStep` fills a
 * **Netherlands** address — `Keizersgracht 1, 1015 CJ, Amsterdam, NL` — with no override, and brand
 * B ships to **GB only** (`shippingCountries: ['GB']` in the seed). So the inherited funnel specs
 * reach B's delivery step and are told, correctly, "No delivery options are available for this
 * address". Measured, not assumed: that is exactly how brand B's first core run failed three tests.
 *
 * Those three are excluded in `playwright.config.ts` and this replaces them, with a GB address and
 * the same place-order → ship → deliver assertions `order-lifecycle.spec.ts` makes for the starter.
 * **The duplication is deliberate and temporary:** #441 part 3 asks window 3 to take the address
 * from the brand or the environment, and when it lands this spec should shrink to brand B's own
 * concerns again and the inherited specs come back.
 *
 * Core only. Against the Prism mock the cart is a contract example and no order is really placed.
 */

const CORE_URL = (process.env.E2E_STORE_API_URL ?? '').replace(/\/$/, '');
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const PUBLISHABLE_KEY = process.env.STORE_PUBLISHABLE_KEY ?? '';
const STAFF = {
  username: process.env.E2E_STAFF_USERNAME ?? 'operations',
  password: process.env.E2E_STAFF_PASSWORD ?? 'operations',
};

/** Brand B's market. The whole reason this spec exists. */
const DESTINATION_COUNTRY = 'GB';
const GB_ADDRESS = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  line1: '12 Mill Lane',
  postal_code: 'LS1 4AB',
  city: 'Leeds',
  country: DESTINATION_COUNTRY,
} as const;

const FUNNEL_SKIP_REASON = !AGAINST_CORE
  ? `no core (this run is against ${BACKEND}; set E2E_STORE_API_URL)`
  : PUBLISHABLE_KEY === ''
    ? 'no STORE_PUBLISHABLE_KEY for the run (needed to read GET /store, which names the store)'
    : null;

interface Warehouse {
  id: string;
  country: string;
  is_active: boolean;
  priority: number;
}

async function staffApi(): Promise<APIRequestContext> {
  const keycloak = await playwrightRequest.newContext();
  const response = await keycloak.post(
    `${KEYCLOAK_URL}/realms/staff/protocol/openid-connect/token`,
    { form: { grant_type: 'password', client_id: 'test-cli', ...STAFF } },
  );
  expect(response.ok(), `a staff token for ${STAFF.username} (staff realm, test-cli)`).toBe(true);
  const { access_token: token } = (await response.json()) as { access_token: string };
  await keycloak.dispose();
  return playwrightRequest.newContext({
    baseURL: CORE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** As the inherited spec does: never the raw body, which could carry an order's personal data. */
async function json<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  if (!response.ok()) {
    let reason = '';
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown };
      reason = [body.code, body.message].filter((part) => typeof part === 'string').join(': ');
    } catch {
      reason = '(no JSON error body)';
    }
    expect(response.ok(), `${what}: HTTP ${response.status()} ${reason}`).toBe(true);
  }
  return (await response.json()) as T;
}

function routedWarehouse(warehouses: Warehouse[]): Warehouse {
  const byPriority = warehouses.filter((w) => w.is_active).sort((a, b) => a.priority - b.priority);
  const local = byPriority.find((w) => w.country === DESTINATION_COUNTRY);
  const chosen = local ?? byPriority[0];
  expect(chosen, 'an active warehouse to ship from').toBeDefined();
  return chosen!;
}

/** The address step, with brand B's market instead of the shared helper's. */
async function completeGbAddressStep(page: Page, email: string): Promise<void> {
  await page.locator('input[name="email"]').fill(email);
  for (const [name, value] of Object.entries(GB_ADDRESS)) {
    await page.locator(`input[name="${name}"]`).fill(value);
  }
  await page.getByRole('button', { name: 'Continue to delivery' }).click();
}

/** Walk whatever step is on screen to the review page, filling GB where an address is wanted. */
async function advanceToReviewGb(page: Page, email: string): Promise<string[]> {
  const visited: string[] = [];
  for (let guard = 0; guard < 5; guard += 1) {
    if (page.url().endsWith('/checkout/review')) return visited;
    const step = new URL(page.url()).pathname.split('/').pop() ?? '';
    visited.push(step);
    await settleOn(page, step);
    if (step === 'address') {
      await completeGbAddressStep(page, email);
    } else if (step === 'shipping') {
      // A GB address must actually offer something: if it does not, say so here rather than time
      // out on the next button — that is the failure this whole spec exists because of.
      await expect(
        page.getByRole('radio').first(),
        'brand B ships to GB, so a GB address must have a delivery option',
      ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      await clickWhenReady(page, page.getByRole('button', { name: 'Continue to payment' }));
    } else if (step === 'payment') {
      // The precondition is checked before the walk starts, so a method must be offered by here.
      const invoice = page.getByRole('radio', { name: /Pay on invoice/ });
      await expect(
        invoice,
        'the payment step offers invoice (checked against GET /store before the walk)',
      ).toBeVisible({ timeout: NAVIGATION_TIMEOUT });
      await invoice.check();
      await clickWhenReady(page, page.getByRole('button', { name: 'Continue to review' }));
    } else {
      throw new Error(`unexpected checkout step for brand B: ${page.url()}`);
    }
    await page.waitForURL((url) => !url.pathname.endsWith(`/${step}`), {
      timeout: SERVER_ACTION_TIMEOUT,
    });
  }
  throw new Error(`brand B's checkout did not reach review; visited ${visited.join(' -> ')}`);
}

test.describe('brand B takes an order, ships it and delivers it', () => {
  test.beforeAll(() => {
    if (FUNNEL_SKIP_REASON !== null) {
      console.info(`[e2e] brand B funnel skipped: ${FUNNEL_SKIP_REASON}`);
    }
  });

  test.beforeEach(() => {
    test.skip(FUNNEL_SKIP_REASON !== null, FUNNEL_SKIP_REASON ?? '');
    test.setTimeout(JOURNEY_TIMEOUT);
  });

  test('a GB order is placed, then reads processing once shipped and completed once delivered', async ({
    page,
  }) => {
    // ── Precondition: the store must be able to take a payment at all.
    //
    // `Store.payment.methods` is derived by the core from the store's settings. A store with none
    // renders "No payment method is available for this shop right now", and a checkout walk would
    // time out on a radio that never appears — three minutes to say nothing useful.
    //
    // This is an ENVIRONMENT precondition, not a defect, which is why it skips rather than fails:
    // `packages/db`'s seed sets `payment.invoice_allowed` for every store (0.3.2), but `seed` is
    // `ON CONFLICT DO NOTHING`, so a database created before that keeps its old `store.settings`.
    // CI seeds fresh and runs this test; a long-lived local database may need the UPDATE recorded in
    // `packages/db/CHANGELOG.md` 0.3.2.
    const store = await json<{ id: string; payment?: { methods?: string[] } }>(
      await page.request.get(`${CORE_URL}/store`, {
        headers: { 'X-Publishable-Key': PUBLISHABLE_KEY },
      }),
      'GET /store',
    );
    expect(store.id, 'GET /store names the store the order belongs to').toMatch(/^[0-9a-f-]{36}$/i);
    const methods = store.payment?.methods ?? [];
    test.skip(
      !methods.includes('invoice'),
      "brand B's store offers no invoice payment (GET /store payment.methods = " +
        `[${methods.join(', ')}]), so no order can be placed. See packages/db CHANGELOG 0.3.2: ` +
        'the seed sets payment.invoice_allowed, but ON CONFLICT DO NOTHING leaves an existing ' +
        'database alone.',
    );

    // ── The customer places an order, to a GB address.
    await openPurchasableProduct(page);
    await clickWhenReady(page, page.getByRole('button', { name: 'Add to cart' }));
    await expect(page).toHaveURL(/\/en-GB\/cart$/, { timeout: SERVER_ACTION_TIMEOUT });
    await clickWhenReady(page, page.getByRole('link', { name: 'Checkout' }));
    await expect(page).toHaveURL(CHECKOUT_STEP, { timeout: NAVIGATION_TIMEOUT });

    const shopper = `e2e-brand-b+${Date.now().toString(36)}@example.test`;
    await advanceToReviewGb(page, shopper);

    await expect(page.getByRole('heading', { level: 1, name: 'Review your order' })).toBeVisible();
    const reviewed = await captureOrder(page, "brand B's review step");
    expect(reviewed.currency, 'brand B prices in pounds').toBe('GBP');

    await clickWhenReady(page, page.getByRole('button', { name: 'Place order' }));
    await expect(page).toHaveURL(/\/en-GB\/orders\/[^/]+$/, {
      timeout: SERVER_ACTION_TIMEOUT,
    });

    const confirmation = page.getByTestId('order-confirmation');
    const orderId = (await confirmation.getAttribute('data-order-id')) ?? '';
    expect(orderId, 'the confirmation carries the order id').not.toBe('');

    // The order charges what the review step showed — no arithmetic here (#374).
    const placed = await captureOrder(page, "brand B's confirmation");
    expect(placed.totalMinor, 'the order total is the total that was reviewed').toBe(
      reviewed.totalMinor,
    );
    expect(placed.currency).toBe('GBP');
    await expect(confirmation, 'a new order is not yet being fulfilled').not.toHaveAttribute(
      'data-order-status',
      /processing|completed/,
    );

    // ── The shop ships it, through the Admin API as the operations user. `store` is the one read at
    // the top, so the order and the admin calls concern the same store by construction.
    const admin = await staffApi();
    const order = await json<{ items: { id: string; quantity: number }[] }>(
      await admin.get(`/admin/stores/${store.id}/orders/${orderId}`),
      'getOrder',
    );
    const { items: warehouses } = await json<{ items: Warehouse[] }>(
      await admin.get('/admin/warehouses'),
      'listWarehouses',
    );
    const shipment = await json<{ id: string }>(
      await admin.post(`/admin/stores/${store.id}/orders/${orderId}/shipments`, {
        data: {
          warehouse_id: routedWarehouse(warehouses).id,
          carrier: 'manual',
          items: order.items.map((item) => ({
            order_line_item_id: item.id,
            quantity: item.quantity,
          })),
        },
      }),
      'createShipment',
    );
    await json(await admin.post(`/admin/shipments/${shipment.id}/pick`), 'pickShipment');
    await json(
      await admin.post(`/admin/shipments/${shipment.id}/pack`, { data: {} }),
      'packShipment',
    );
    await json(
      await admin.patch(`/admin/shipments/${shipment.id}`, { data: { status: 'shipped' } }),
      'updateShipment shipped',
    );

    // ── Shipped: the customer's page says so.
    await page.reload();
    await expect(confirmation).toHaveAttribute('data-order-status', 'processing');
    await expect(page.getByTestId('order-status')).toHaveText('Status: Processing');

    // ── Delivered.
    await json(
      await admin.patch(`/admin/shipments/${shipment.id}`, { data: { status: 'delivered' } }),
      'updateShipment delivered',
    );
    await page.reload();
    await expect(confirmation).toHaveAttribute('data-order-status', 'completed');
    await expect(page.getByTestId('order-status')).toHaveText('Status: Completed');

    await admin.dispose();
  });
});
