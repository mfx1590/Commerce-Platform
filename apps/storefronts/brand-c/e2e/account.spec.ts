import { expect, test, type Page } from '@playwright/test';
import {
  BACKEND,
  CHECKOUT_STEP,
  JOURNEY_TIMEOUT,
  NAVIGATION_TIMEOUT,
  SERVER_ACTION_TIMEOUT,
  advanceToReview,
  captureOrder,
  clickWhenReady,
  openPurchasableProduct,
} from './support/journey';
import { localePath, localeUrl } from './support/locale';

/**
 * Account area against the Keycloak **customers** realm.
 *
 * Credentials are the realm's seeded fixture (`infra/keycloak/customers-realm.json`), not anyone's
 * real account. Note the username is `jane@example.com`, not `jane` as issue #21 says — the realm
 * seeds the email as the username.
 *
 * Keycloak is not started by this config: it is a container, not a `pnpm` script. Start it with
 * `docker compose -f infra/docker/docker-compose.yml up -d keycloak` (or `pnpm compose:up`).
 *
 * Missing locally, these tests skip — a laptop without the stack should not fail the suite. **On CI
 * they are required**: the workflow boots Keycloak, so an unreachable one is a real failure, and a
 * silent skip there would quietly stop covering sign-in altogether. `E2E_REQUIRE_KEYCLOAK=1` forces
 * the same strictness anywhere.
 *
 * **Which backend answers what (#306).** Sign-in, the return URL, the session cookie and
 * sign-out are real against either backend: they are Keycloak and this app. The customer's
 * profile and the order list are not — the core mounts no `/store/customers*` and no order list
 * (#303), so even in a run against the core those two requests are answered by Prism through
 * `CORE_STORE_API_FALLBACK`, with the contract's examples. The test that reads them is therefore
 * labelled mock-only and does not run against the core, where it would pass identically whether
 * or not the core works. Its core-backed replacement waits for #303, and will read an order
 * placed during the run rather than naming one.
 */

/**
 * Serial, not parallel: these tests share one Keycloak user and therefore one SSO session, and
 * `signing out drops the session` ends it server-side. Run in parallel, that logout bounces a
 * sibling test back to the login form mid-flow — which is exactly how this suite first failed.
 */
test.describe.configure({ mode: 'serial' });

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const REALM = process.env.KEYCLOAK_REALM_CUSTOMERS ?? 'customers';
const CUSTOMER = { username: 'jane@example.com', password: 'jane' };
/** The app's session cookie (`src/lib/auth/session.ts`); its value is URL-encoded JSON. */
const SESSION_COOKIE = 'customer_session';

const REQUIRE_KEYCLOAK = process.env.E2E_REQUIRE_KEYCLOAK === '1' || Boolean(process.env.CI);
const AGAINST_CORE = process.env.E2E_STORE_API_URL !== undefined;

let keycloakReachable = false;

test.beforeAll(async ({ request }) => {
  try {
    const response = await request.get(
      `${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration`,
      { timeout: 5_000 },
    );
    keycloakReachable = response.ok();
  } catch {
    keycloakReachable = false;
  }

  if (!keycloakReachable && REQUIRE_KEYCLOAK) {
    throw new Error(
      `Keycloak is not reachable at ${KEYCLOAK_URL}. Start it with: docker compose -f infra/docker/docker-compose.yml up -d keycloak`,
    );
  }
});

test.beforeEach(() => {
  test.skip(
    !keycloakReachable && !REQUIRE_KEYCLOAK,
    `Keycloak not reachable at ${KEYCLOAK_URL} — start it with \`docker compose -f infra/docker/docker-compose.yml up -d keycloak\``,
  );
});

async function signIn(page: Page): Promise<void> {
  // Keycloak's own login page: target its stable field ids. A label-based locator matches two
  // elements, because the password field ships with a "Show password" toggle labelled the same way.
  await page.locator('#username').fill(CUSTOMER.username);
  await page.locator('#password').fill(CUSTOMER.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Back on the storefront, page loaded. The round trip is Keycloak's POST, our callback (a token
  // exchange with Keycloak) and the page itself — under the first wave of a parallel run that is far
  // more than the default 5 s expect, which is how a full core pass failed here (#327).
  await page.waitForURL((url) => !url.href.startsWith(KEYCLOAK_URL), {
    timeout: NAVIGATION_TIMEOUT,
  });
}

test('an unauthenticated visitor is sent to sign-in and back to the page they asked for', async ({
  page,
}) => {
  await page.goto(localePath('/account/orders'));

  // Off to Keycloak, carrying no session of ours.
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/${REALM}/`));
  await signIn(page);

  // ...and back to the order history, not to a generic account home.
  await expect(page).toHaveURL(localeUrl('/account/orders$'));
  await expect(page.getByRole('heading', { level: 1, name: 'Order history' })).toBeVisible();
});

test('a signed-in customer reaches the account home and the order history', async ({ page }) => {
  // Ours and Keycloak's, so real against either backend: the session, the two routes, the copy.
  await page.goto(localePath('/account'));
  await signIn(page);

  await expect(page).toHaveURL(localeUrl('/account$'));
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();

  await page.getByRole('link', { name: 'Order history' }).click();
  await expect(page).toHaveURL(localeUrl('/account/orders$'), { timeout: NAVIGATION_TIMEOUT });
  await expect(page.getByRole('heading', { level: 1, name: 'Order history' })).toBeVisible();
});

test('mock-only: the profile and the order history render the contract examples', async ({
  page,
}) => {
  test.skip(
    AGAINST_CORE,
    'mock-only: the core serves neither /store/customers* nor an order list (#303); through ' +
      'CORE_STORE_API_FALLBACK both are answered by Prism, so this would pass whether or not the ' +
      'core works. The core-backed version waits for #303.',
  );

  await page.goto(localePath('/account'));
  await signIn(page);
  await expect(page).toHaveURL(localeUrl('/account$'));

  // The two values below are **Prism's examples**, not ours and not the seed's: the example
  // customer of `GET /store/customers/me` and the example order of the order list. Naming a
  // dataset value is exactly what this suite otherwise refuses to do; it is allowed here only
  // because the test says what it is — proof that the two pages render what the API returned.
  await expect(page.getByText('jane@example.com')).toBeVisible();

  await page.getByRole('link', { name: 'Order history' }).click();
  await expect(page).toHaveURL(localeUrl('/account/orders$'), { timeout: NAVIGATION_TIMEOUT });
  await expect(page.getByRole('link', { name: /Order #1000/ })).toBeVisible();
  await expect(page.getByTestId('price-value').first()).toBeVisible();
});

test('signing out drops the session', async ({ page }) => {
  await page.goto(localePath('/account'));
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();

  // Back on the storefront, and the account area asks for sign-in again.
  await page.goto(localePath('/account'));
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/${REALM}/`));
});

/**
 * #312. Signed in, the storefront sends the customer token on cart create and complete (Store API
 * 0.5.1). Two outcomes are correct and this test accepts both; the server log says which happened:
 *
 * - a core that implements 0.5.1 links the cart and the order to the customer;
 * - a core that refuses the token (a stale or invalid session; only a core with #303 PR C checks it —
 *   one before PR C ignored it and answered 201) answers 401, and the storefront drops the stale
 *   session and completes the purchase **as a guest**, once
 *   (`[storefront] the Store API refused the customer token on a cart call; …`).
 *
 * What must never happen is the third thing: a signed-in customer who cannot buy. Against the mock
 * the token is accepted and ignored, so only the first shape is exercised there.
 */
test('a signed-in customer can buy — linked when the core takes the token, as a guest when it refuses it', async ({
  page,
}) => {
  test.setTimeout(JOURNEY_TIMEOUT);

  await page.goto(localePath('/account'));
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();

  await buy(page, 'signed-in journey');
});

/**
 * #312, the other shape, produced on purpose: the session cookie still says "signed in" but its
 * access token is one the core will not accept — what a customer has after Keycloak revoked or
 * rotated their session. The core answers 401 on cart create, the storefront drops the session
 * and makes that call once more as a guest, and the purchase completes. Proven here by the result
 * (an order, and no session cookie afterwards); the server log carries the fallback line.
 *
 * Core-only: Prism accepts any bearer token, so on the mock the stale token is used as if it were
 * good, nothing is dropped, and this would fail for a reason that says nothing about the app.
 */
test('a stale session still buys — the token is refused, the session dropped, the order placed as a guest', async ({
  page,
  context,
}) => {
  test.skip(
    !AGAINST_CORE,
    'core-only: the mock accepts any customer token, so it never refuses one',
  );
  test.setTimeout(JOURNEY_TIMEOUT);

  await page.goto(localePath('/account'));
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();

  // Keep the cookie's shape and lifetime; replace only the token the core is asked to verify.
  const session = (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE);
  expect(session, 'signing in sets the session cookie').toBeDefined();
  const value = JSON.parse(decodeURIComponent(session!.value)) as Record<string, unknown>;
  expect(typeof value.accessToken).toBe('string');
  await context.addCookies([
    { ...session!, value: encodeURIComponent(JSON.stringify({ ...value, accessToken: 'stale' })) },
  ]);

  await buy(page, 'stale-session journey');

  const after = (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE);
  expect(after, 'the refused session is dropped, not kept and refused again').toBeUndefined();
});

/** The journey's own steps, with whatever session cookie the context carries along for the ride. */
async function buy(page: Page, label: string): Promise<void> {
  const chosen = await openPurchasableProduct(page);
  await clickWhenReady(page, page.getByRole('button', { name: 'Add to cart' }));
  await expect(page).toHaveURL(localeUrl('/cart$'), { timeout: SERVER_ACTION_TIMEOUT });
  const cart = await captureOrder(page, 'the cart');
  expect(cart.lines.map((line) => line.sku)).toContain(chosen.sku);

  await clickWhenReady(page, page.getByRole('link', { name: 'Checkout' }));
  await expect(page).toHaveURL(CHECKOUT_STEP, { timeout: NAVIGATION_TIMEOUT });
  const shopperEmail = `e2e-customer+${Date.now().toString(36)}@example.com`;
  await advanceToReview(page, shopperEmail);
  const reviewed = await captureOrder(page, 'the review step');

  await clickWhenReady(page, page.getByRole('button', { name: 'Place order' }));
  await expect(page).toHaveURL(localeUrl('/orders/[^/]+$'), { timeout: SERVER_ACTION_TIMEOUT });
  await expect(page.getByRole('heading', { level: 1, name: 'Thank you' })).toBeVisible();

  const placed = await captureOrder(page, 'the confirmation');
  expect(placed.lines, 'the order has the lines that were reviewed').toEqual(reviewed.lines);
  expect(placed.totalMinor).toBe(reviewed.totalMinor);

  const orderNumber = await page
    .getByTestId('order-confirmation')
    .getAttribute('data-order-number');
  console.info(
    `[e2e] ${label} bought ${chosen.sku} (${chosen.handle}), order ${orderNumber}, on ${BACKEND}`,
  );
}
