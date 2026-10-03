import { expect, test, type Page } from '@playwright/test';

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
}

test('an unauthenticated visitor is sent to sign-in and back to the page they asked for', async ({
  page,
}) => {
  await page.goto('/en-GB/account/orders');

  // Off to Keycloak, carrying no session of ours.
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/${REALM}/`));
  await signIn(page);

  // ...and back to the order history, not to a generic account home.
  await expect(page).toHaveURL(/\/en-GB\/account\/orders$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Order history' })).toBeVisible();
});

test('a signed-in customer reaches the account home and the order history', async ({ page }) => {
  // Ours and Keycloak's, so real against either backend: the session, the two routes, the copy.
  await page.goto('/en-GB/account');
  await signIn(page);

  await expect(page).toHaveURL(/\/en-GB\/account$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();

  await page.getByRole('link', { name: 'Order history' }).click();
  await expect(page).toHaveURL(/\/en-GB\/account\/orders$/);
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

  await page.goto('/en-GB/account');
  await signIn(page);
  await expect(page).toHaveURL(/\/en-GB\/account$/);

  // The two values below are **Prism's examples**, not ours and not the seed's: the example
  // customer of `GET /store/customers/me` and the example order of the order list. Naming a
  // dataset value is exactly what this suite otherwise refuses to do; it is allowed here only
  // because the test says what it is — proof that the two pages render what the API returned.
  await expect(page.getByText('jane@example.com')).toBeVisible();

  await page.getByRole('link', { name: 'Order history' }).click();
  await expect(page).toHaveURL(/\/en-GB\/account\/orders$/);
  await expect(page.getByRole('link', { name: /Order #1000/ })).toBeVisible();
  await expect(page.getByTestId('price-value').first()).toBeVisible();
});

test('signing out drops the session', async ({ page }) => {
  await page.goto('/en-GB/account');
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();

  // Back on the storefront, and the account area asks for sign-in again.
  await page.goto('/en-GB/account');
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/${REALM}/`));
});
