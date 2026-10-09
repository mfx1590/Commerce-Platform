import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import {
  AGAINST_CORE,
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
import { localeUrl } from './support/locale';

/**
 * #358: a card order through Stripe's Payment Element, in Stripe TEST mode, against the core.
 *
 * Runs only against the core **and** with a Stripe test publishable key in the environment the e2e
 * server inherits (`STRIPE_PUBLISHABLE_KEY_<STORE CODE>` or `STRIPE_PUBLISHABLE_KEY`; the core needs
 * the matching secret key). Otherwise it is skipped with the reason — loudly, never a silent pass. The
 * mock run is unchanged: Prism's session is no real PaymentIntent, so there is nothing to confirm.
 *
 * Stripe's documented test cards: 4242 4242 4242 4242 (authorised), 4000 0027 6000 3184 (3-D Secure
 * required; Stripe's test modal has a "Complete" button), 4000 0000 0000 0002 (declined).
 */

const HAS_STRIPE_KEY = Object.entries(process.env).some(
  ([name, value]) =>
    /^STRIPE_PUBLISHABLE_KEY(_[A-Z0-9_]+)?$/.test(name) && /^pk_test_/.test(value ?? ''),
);

test.describe.configure({ mode: 'serial' });

/** Why this spec cannot run here, or null when it can. One reason, said once. */
const SKIP_REASON = !AGAINST_CORE
  ? `no core (this run is against ${BACKEND}; set E2E_STORE_API_URL)`
  : !HAS_STRIPE_KEY
    ? 'no Stripe TEST publishable key (STRIPE_PUBLISHABLE_KEY_<STORE CODE>=pk_test_…)'
    : null;

test.beforeAll(() => {
  // Printed, not only recorded: a skipped card spec must say why in the run's output (#358).
  if (SKIP_REASON !== null) console.info(`[e2e] card-payment skipped: ${SKIP_REASON}`);
});

test.beforeEach(() => {
  test.skip(SKIP_REASON !== null, `card payment skipped: ${SKIP_REASON ?? ''}`);
  test.setTimeout(JOURNEY_TIMEOUT);
});

const CARDS = {
  authorised: '4242424242424242',

  threeDSecure: '4000002760003184',
  declined: '4000000000000002',
} as const;

/** To the review step with Card chosen, the Payment Element on screen. */
async function toCardReview(page: Page): Promise<void> {
  await openPurchasableProduct(page);
  await clickWhenReady(page, page.getByRole('button', { name: 'Add to cart' }));
  await expect(page).toHaveURL(localeUrl('/cart$'), { timeout: SERVER_ACTION_TIMEOUT });
  await clickWhenReady(page, page.getByRole('link', { name: 'Checkout' }));
  await expect(page).toHaveURL(CHECKOUT_STEP, { timeout: NAVIGATION_TIMEOUT });
  await advanceToReview(page, `e2e-card+${Date.now().toString(36)}@example.com`, 'card');
  await expect(page.getByTestId('card-payment')).toBeVisible();
}

function paymentElement(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Secure payment input frame"]');
}

async function enterCard(page: Page, number: string): Promise<void> {
  const element = paymentElement(page);
  await element.locator('input[name="number"]').fill(number, { timeout: NAVIGATION_TIMEOUT });
  await element.locator('input[name="expiry"]').fill('12 / 34');
  await element.locator('input[name="cvc"]').fill('123');
  const postal = element.locator('input[name="postalCode"]');
  if (await postal.isVisible()) await postal.fill('1015 CJ');
}

async function placeOrder(page: Page): Promise<void> {
  await clickWhenReady(
    page,
    page.getByTestId('card-payment').getByRole('button', { name: 'Place order' }),
  );
}

async function expectPlaced(page: Page, label: string): Promise<string> {
  await expect(page).toHaveURL(localeUrl('/orders/[^/]+$'), { timeout: SERVER_ACTION_TIMEOUT });
  await expect(page.getByRole('heading', { level: 1, name: 'Thank you' })).toBeVisible();
  const placed = await captureOrder(page, 'the confirmation');
  expect(placed.lines.length, 'the order has lines').toBeGreaterThan(0);
  const orderNumber =
    (await page.getByTestId('order-confirmation').getAttribute('data-order-number')) ?? '';
  console.info(`[e2e] ${label}: order ${orderNumber}, on ${BACKEND}`);
  return orderNumber;
}

test('a card order: the Payment Element authorises it and the order is placed', async ({
  page,
}) => {
  await toCardReview(page);
  await enterCard(page, CARDS.authorised);
  await placeOrder(page);
  await expectPlaced(page, 'card (4242)');
});

test('a 3-D Secure card: the customer completes Stripe’s challenge and the order is placed', async ({
  page,
}) => {
  await toCardReview(page);
  await enterCard(page, CARDS.threeDSecure);
  await placeOrder(page);

  const challenge = page
    .frameLocator('iframe[name^="__stripeJSChallengeFrame"]')
    .frameLocator('iframe[name="stripe-challenge-frame"]');
  await challenge.getByRole('button', { name: /complete/i }).click({ timeout: NAVIGATION_TIMEOUT });
  await expectPlaced(page, 'card (3-D Secure)');
});

test('a declined card is a recoverable message; a good card then places exactly one order', async ({
  page,
}) => {
  await toCardReview(page);
  await enterCard(page, CARDS.declined);
  await placeOrder(page);

  await expect(page.getByTestId('card-payment').getByRole('alert')).toBeVisible({
    timeout: SERVER_ACTION_TIMEOUT,
  });
  await expect(page, 'still on the review step: nothing was placed').toHaveURL(
    /\/checkout\/review/,
  );

  await enterCard(page, CARDS.authorised);
  await placeOrder(page);
  await expectPlaced(page, 'card (declined, then 4242)');
});

test('an abandoned 3-D Secure leaves the cart as it was and says so; a good card then places the order', async ({
  page,
}) => {
  await toCardReview(page);
  const before = await captureOrder(page, 'the review step');
  await enterCard(page, CARDS.threeDSecure);
  await placeOrder(page);

  const challenge = page
    .frameLocator('iframe[name^="__stripeJSChallengeFrame"]')
    .frameLocator('iframe[name="stripe-challenge-frame"]');
  await challenge.getByRole('button', { name: /fail/i }).click({ timeout: NAVIGATION_TIMEOUT });

  await expect(page.getByTestId('card-payment').getByRole('alert')).toContainText(
    'nothing was charged',
    { timeout: SERVER_ACTION_TIMEOUT },
  );
  await expect(page, 'still on the review step: nothing was placed').toHaveURL(
    /\/checkout\/review/,
  );
  const after = await captureOrder(page, 'the review step, after the abandoned challenge');
  expect(after, 'the cart is unchanged').toEqual(before);

  await enterCard(page, CARDS.authorised);
  await placeOrder(page);
  await expectPlaced(page, 'card (3-D Secure abandoned, then 4242)');
});
