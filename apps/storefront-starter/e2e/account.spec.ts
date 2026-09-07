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
 * When it is missing these tests skip — unless `E2E_REQUIRE_KEYCLOAK=1`, which CI sets so a missing
 * dependency there is a failure rather than a quiet pass.
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

  if (!keycloakReachable && process.env.E2E_REQUIRE_KEYCLOAK === '1') {
    throw new Error(
      `Keycloak is not reachable at ${KEYCLOAK_URL}. Start it with: docker compose -f infra/docker/docker-compose.yml up -d keycloak`,
    );
  }
});

test.beforeEach(() => {
  test.skip(
    !keycloakReachable,
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
  await page.goto('/account/orders');

  // Off to Keycloak, carrying no session of ours.
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/${REALM}/`));
  await signIn(page);

  // ...and back to the order history, not to a generic account home.
  await expect(page).toHaveURL(/\/account\/orders$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Order history' })).toBeVisible();
});

test('order history lists the seeded order with its price', async ({ page }) => {
  await page.goto('/account');
  await signIn(page);

  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await expect(page.getByText('jane@example.com')).toBeVisible();

  await page.getByRole('link', { name: 'Order history' }).click();
  await expect(page).toHaveURL(/\/account\/orders$/);

  await expect(page.getByRole('link', { name: /Order #1000/ })).toBeVisible();
  await expect(page.getByTestId('price-value').first()).toBeVisible();
});

test('signing out drops the session', async ({ page }) => {
  await page.goto('/account');
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();

  // Back on the storefront, and the account area asks for sign-in again.
  await page.goto('/account');
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/${REALM}/`));
});
