import { expect, test, type Page } from '@playwright/test';
import {
  AGAINST_CORE,
  BACKEND,
  CHECKOUT_STEP,
  clickWhenReady,
  hydrated,
  NAVIGATION_TIMEOUT,
  openPurchasableProduct,
  SERVER_ACTION_TIMEOUT,
} from './support/journey';
import { localePath, localeUrl } from './support/locale';

/**
 * The nonce CSP (#782) on a production build: every page a shopper reaches runs with **zero** CSP
 * violations and is interactive, under a `script-src` with no `'unsafe-inline'`.
 *
 * Violations are collected two ways, as apps/admin/e2e/csp.spec.ts does, because either alone can
 * miss one: the document's `securitypolicyviolation` events (an init script, which Playwright
 * injects outside the page's CSP) and the console's "Refused to …" errors. "Interactive" is proven
 * twice per page: the hydration marker, set by a client effect, so the nonced bootstrap and
 * chunks ran; and a click that needs client JS (a client-side navigation or a client component).
 *
 * Runs against either backend. Two parts depend on what the run has:
 * - The account page needs Keycloak: skipped locally without it, required on CI (as account.spec.ts).
 * - The Payment Element mounts only where the card option is offered: a core run with a Stripe TEST
 *   publishable key (as card-payment.spec.ts). Elsewhere the payment step is still visited and
 *   checked, and the run prints why Stripe.js was not loaded. Never a silent pass.
 */

/**
 * Every violation on this app's pages, across full page loads: an exposed function outlives each
 * document, where a list kept in `window` would be reset by the next navigation. Keycloak's own
 * login page (another origin, its own policy) is not ours to judge and is left out.
 */
async function watchCsp(page: Page, appOrigin: string): Promise<() => string[]> {
  const seen: string[] = [];
  const ours = (url: string) => url.startsWith(appOrigin);
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      /Content Security Policy|Refused to/i.test(text) &&
      ours(message.location().url || page.url())
    ) {
      seen.push(`console: ${text}`);
    }
  });
  await page.exposeFunction('__reportCsp', (url: string, entry: string) => {
    if (ours(url)) seen.push(`${url}: ${entry}`);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void (
        window as unknown as { __reportCsp: (url: string, entry: string) => Promise<void> }
      ).__reportCsp(
        location.href,
        `${event.violatedDirective} blocked ${event.blockedURI || '(inline)'}`,
      );
    });
  });
  return () => [...seen];
}

/** The response carries the production nonce policy, and the page's own scripts carry its nonce. */
async function expectNoncePolicy(
  page: Page,
  where: string,
  csp: string | undefined,
): Promise<void> {
  expect(csp, `${where}: a CSP header`).toBeDefined();
  const nonce = /'nonce-([^']+)'/.exec(csp ?? '')?.[1];
  expect(nonce, `${where}: script-src has a nonce`).toBeTruthy();
  expect(csp, `${where}: no unsafe-inline for scripts`).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(csp, `${where}: no unsafe-eval in production`).not.toMatch(/script-src[^;]*unsafe-eval/);
  // Next stamped the nonce on its scripts (the DOM hides the attribute's value, so read the
  // property).
  const stamped = await page.evaluate(
    (n) => [...document.scripts].filter((s) => s.nonce === n).length,
    nonce,
  );
  expect(stamped, `${where}: Next's scripts carry this response's nonce`).toBeGreaterThan(0);
}

/** Load a page and return its own response's policy (each response has its own nonce). */
async function visit(page: Page, path: string): Promise<string | undefined> {
  const response = await page.goto(localePath(path));
  return response?.headers()['content-security-policy'];
}

/** The policy of the page as it is now, from a reload (a helper navigated to it). */
async function reloadPolicy(page: Page): Promise<string | undefined> {
  const response = await page.reload();
  return response?.headers()['content-security-policy'];
}

const REQUIRE_KEYCLOAK = process.env.E2E_REQUIRE_KEYCLOAK === '1' || Boolean(process.env.CI);
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const REALM = process.env.KEYCLOAK_REALM_CUSTOMERS ?? 'customers';

test('shop and funnel pages run under the nonce CSP with no violation, and are interactive', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const violations = await watchCsp(page, new URL(baseURL ?? 'http://127.0.0.1:3100').origin);

  await test.step('home', async () => {
    const csp = await visit(page, '');
    await hydrated(page);
    await expectNoncePolicy(page, 'home', csp);
    // Client-side navigation needs the router: interactive, not just painted.
    await clickWhenReady(page, page.getByRole('link', { name: 'Products' }).first());
    await expect(page).toHaveURL(localeUrl('/products$'), { timeout: NAVIGATION_TIMEOUT });
  });

  await test.step('PLP', async () => {
    const csp = await visit(page, '/products');
    await hydrated(page);
    await expectNoncePolicy(page, 'PLP', csp);
  });

  await test.step('PDP: a client component answers a click', async () => {
    await openPurchasableProduct(page);
    await hydrated(page);
    const csp = await reloadPolicy(page);
    await hydrated(page);
    await expectNoncePolicy(page, 'PDP', csp);
    await clickWhenReady(page, page.getByRole('button', { name: 'Add to cart' }));
    await expect(page).toHaveURL(localeUrl('/cart$'), { timeout: SERVER_ACTION_TIMEOUT });
  });

  await test.step('cart', async () => {
    const csp = await visit(page, '/cart');
    await hydrated(page);
    await expectNoncePolicy(page, 'cart', csp);
    expect(csp, 'cart: frame-src is Stripe only').toMatch(
      /frame-src 'self' https:\/\/js\.stripe\.com https:\/\/hooks\.stripe\.com;/,
    );
  });

  await test.step('checkout through the payment step', async () => {
    await clickWhenReady(page, page.getByRole('link', { name: 'Checkout' }));
    await expect(page).toHaveURL(CHECKOUT_STEP, { timeout: NAVIGATION_TIMEOUT });
    const csp = await visit(page, '/checkout/payment');
    await hydrated(page);
    await expectNoncePolicy(page, 'checkout payment', csp);

    const card = page.getByRole('radio', { name: /card/i });
    if ((await card.count()) > 0) {
      await card.first().check();
      // Stripe.js arrives through 'strict-dynamic' and mounts its iframe.
      await expect(page.locator('iframe[src^="https://js.stripe.com"]').first()).toBeAttached({
        timeout: 30_000,
      });
    } else {
      console.info(
        `[e2e] csp: the card option is not offered on ${BACKEND}${AGAINST_CORE ? '' : ' (mock run)'}: ` +
          'Stripe.js was not loaded here; card-payment.spec.ts covers it with a core and a TEST key.',
      );
    }
  });

  await test.step('a CMS page (rendered or the content 404) and the shop 404', async () => {
    const cms = await visit(page, '/pages/about');
    await hydrated(page);
    await expectNoncePolicy(page, 'CMS page', cms);

    const missing = await visit(page, '/no-such-page-for-csp');
    await hydrated(page);
    await expectNoncePolicy(page, 'locale 404', missing);
    // The store's own localised 404 (the [...rest] catch-all), not Next's static default.
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await clickWhenReady(page, page.getByRole('link', { name: 'Back to the home page' }));
    await expect(page).toHaveURL(localeUrl('$'), { timeout: NAVIGATION_TIMEOUT });
  });

  expect(violations()).toEqual([]);
});

test('a missing file is answered with a policy too (the prerendered 404)', async ({ request }) => {
  const response = await request.get('/no-such-file-for-csp.png');
  expect(response.status()).toBe(404);
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
});

test('account pages run under the nonce CSP with no violation (Keycloak)', async ({
  page,
  baseURL,
}) => {
  let reachable = false;
  try {
    reachable = (
      await page.request.get(`${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration`, {
        timeout: 5_000,
      })
    ).ok();
  } catch {
    reachable = false;
  }
  if (!reachable && REQUIRE_KEYCLOAK)
    throw new Error(`Keycloak is not reachable at ${KEYCLOAK_URL}`);
  test.skip(!reachable, `Keycloak not reachable at ${KEYCLOAK_URL}`);

  const violations = await watchCsp(page, new URL(baseURL ?? 'http://127.0.0.1:3100').origin);
  await page.goto(localePath('/account'));
  await page.locator('#username').fill('jane@example.com');
  await page.locator('#password').fill('jane');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.href.startsWith(KEYCLOAK_URL), {
    timeout: NAVIGATION_TIMEOUT,
  });
  await expect(page).toHaveURL(localeUrl('/account$'));
  const csp = await reloadPolicy(page);
  await hydrated(page);
  await expectNoncePolicy(page, 'account', csp);
  await clickWhenReady(page, page.getByRole('link', { name: 'Order history' }));
  await expect(page).toHaveURL(localeUrl('/account/orders$'), { timeout: NAVIGATION_TIMEOUT });

  expect(violations()).toEqual([]);
});
