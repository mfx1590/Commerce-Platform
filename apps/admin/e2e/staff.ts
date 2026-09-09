import type { Page } from '@playwright/test';

/**
 * Shared by every journey: the seeded staff fixture and the sign-in against the real realm.
 *
 * Credentials are the dev realm's seed (`infra/keycloak/staff-realm.json`, mirrored from
 * `packages/db` SEED_IDS). They exist only in the local stack and the CI compose stack.
 */
export const STORE_ADMIN = { username: 'store-admin', password: 'store-admin' };
/** HQ `finance` (Stores + Finance in the HQ scope, store access by inheritance); no OTP enrolled. */
export const FINANCE = { username: 'finance', password: 'finance' };
/** From `packages/db` SEED_IDS — store-admin holds `store_admin` on brand-a and brand-b only. */
export const BRAND_A = '00000000-0000-4000-8000-000000000031';
export const BRAND_C = '00000000-0000-4000-8000-000000000033';

/** The app's session cookie, chunked across `admin_session.N`. */
export async function sessionCookies(page: Page) {
  const cookies = await page.context().cookies();
  return cookies.filter((cookie) => cookie.name.startsWith('admin_session'));
}

export async function signInAs(
  page: Page,
  user: { username: string; password: string },
  to = '/',
): Promise<void> {
  await page.goto(to);
  // The middleware bounces an unauthenticated request to the realm's own sign-in form.
  await page.waitForURL(/\/realms\/staff\/protocol\/openid-connect\/auth/);
  // Role-based, not getByLabel: Keycloak renders a "Show password" toggle whose aria-label also
  // contains "password", so a label regex matches two elements and trips strict mode.
  await page.getByRole('textbox', { name: /username/i }).fill(user.username);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(user.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}

export function signIn(page: Page, to = '/'): Promise<void> {
  return signInAs(page, STORE_ADMIN, to);
}

/** The Medusa rail once its load sequence has finished (or was skipped under reduced motion). */
export async function settledRail(page: Page) {
  const rail = page.getByRole('complementary', { name: 'Medusa navigation rail' });
  await rail.waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('aside[aria-label="Medusa navigation rail"]')
        ?.getAttribute('data-intro') === 'false',
    undefined,
    { timeout: 15_000 },
  );
  return rail;
}
