import type { Page } from '@playwright/test';

/**
 * Shared by every journey: the seeded staff fixture and the sign-in against the real realm.
 *
 * Credentials are the dev realm's seed (`infra/keycloak/staff-realm.json`, mirrored from
 * `packages/db` SEED_IDS). They exist only in the local stack and the CI compose stack.
 */
export const STORE_ADMIN = { username: 'store-admin', password: 'store-admin' };
/** From `packages/db` SEED_IDS — store-admin holds `store_admin` on brand-a and brand-b only. */
export const BRAND_A = '00000000-0000-4000-8000-000000000031';
export const BRAND_C = '00000000-0000-4000-8000-000000000033';

/** The app's session cookie, chunked across `admin_session.N`. */
export async function sessionCookies(page: Page) {
  const cookies = await page.context().cookies();
  return cookies.filter((cookie) => cookie.name.startsWith('admin_session'));
}

export async function signIn(page: Page, to = '/'): Promise<void> {
  await page.goto(to);
  // The middleware bounces an unauthenticated request to the realm's own sign-in form.
  await page.waitForURL(/\/realms\/staff\/protocol\/openid-connect\/auth/);
  // Role-based, not getByLabel: Keycloak renders a "Show password" toggle whose aria-label also
  // contains "password", so a label regex matches two elements and trips strict mode.
  await page.getByRole('textbox', { name: /username/i }).fill(STORE_ADMIN.username);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(STORE_ADMIN.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}
