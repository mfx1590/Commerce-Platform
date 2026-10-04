import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The journey's building blocks, shared by `checkout.spec.ts` and `account.spec.ts` (#304, #312).
 *
 * The rule they all follow: assert on **our own UI** — copy from the message catalogue, roles,
 * structure — and on values **captured at runtime** from the page, never on a name, a handle, a
 * price or an id that belongs to whatever dataset is behind the API. See the header of
 * `checkout.spec.ts` for the history and for what each backend can prove.
 */

export const AGAINST_CORE = process.env.E2E_STORE_API_URL !== undefined;
export const BACKEND = AGAINST_CORE ? 'the core' : 'the Prism mock';

export const CHECKOUT_STEP = /\/checkout\/(address|shipping|payment|review)$/;

/** A guard against a redirect cycle, not a real iteration count: there are four steps. */
export const CHECKOUT_STEPS_MAX = 5;

/**
 * The `<h1>` of each step, from our own message catalogue.
 *
 * Waiting for it before acting is not decoration: the step forms use `useActionState`, so React
 * replaces the server-rendered form at hydration and a button clicked in that window detaches
 * mid-click ("element was detached from the DOM"). Waiting for the heading and for the page to go
 * quiet lets hydration finish first.
 */
export const STEP_HEADING: Record<string, string> = {
  address: 'Where should it go?',
  shipping: 'How should it get there?',
  payment: 'How would you like to pay?',
};

export async function settleOn(page: Page, step: string): Promise<void> {
  const heading = STEP_HEADING[step];
  if (heading === undefined) throw new Error(`No heading known for checkout step "${step}"`);

  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Fill the address step. The values are ours, not the dataset's, so they are safe to assert on. */
export async function completeAddressStep(page: Page, email: string): Promise<void> {
  await page.locator('input[name="email"]').fill(email);
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
export async function advanceToReview(page: Page, email: string): Promise<string[]> {
  const visited: string[] = [];

  for (let guard = 0; guard < CHECKOUT_STEPS_MAX; guard += 1) {
    const step = new URL(page.url()).pathname.split('/').pop() ?? '';
    if (step === 'review') return visited;
    visited.push(step);
    await settleOn(page, step);

    switch (step) {
      case 'address':
        await completeAddressStep(page, email);
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
export const SERVER_ACTION_TIMEOUT = 30_000;
export const NAVIGATION_TIMEOUT = 15_000;

/**
 * The budget of a whole test, which has to be larger than the deadlines inside it. Playwright's
 * default is 30 s per test: under it a 30 s deadline can never be used in full — the test is
 * killed first, and reports a test timeout instead of the assertion that was waiting. The journey
 * has two server actions and three navigations; the listing test has four navigations.
 */
export const JOURNEY_TIMEOUT = 180_000;
export const LISTING_TIMEOUT = 120_000;

/**
 * Click a control once the page can act on it.
 *
 * The other half of the same flake: a click dispatched before hydration has attached the handler is
 * swallowed — the sort link was clicked, the URL never changed, and the test waited out its deadline
 * on a page that was fine (one run in four on a quiet machine). Visible, enabled and the network
 * quiet is the same settling `settleOn` does for the checkout steps.
 */
export async function clickWhenReady(page: Page, control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  await page.waitForLoadState('networkidle');
  await control.click();
}

// ── Reading the page ─────────────────────────────────────────────────────────────────────────────

export interface ListedProduct {
  handle: string;
  priceMinor: number;
  /** `''` when the product has no category. */
  category: string;
}

/** The cards of the listing on screen, in the order they are shown. */
export async function readCards(page: Page): Promise<ListedProduct[]> {
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

export interface CapturedLine {
  sku: string;
  quantity: number;
  totalMinor: number;
}

export interface CapturedOrder {
  lines: CapturedLine[];
  totalMinor: number;
  currency: string;
}

/** The lines and the total of the cart or order on screen — as numbers, not as formatted text. */
export async function captureOrder(page: Page, where: string): Promise<CapturedOrder> {
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
export const PURCHASABLE_SEARCH_LIMIT = 12;

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
export async function openPurchasableProduct(page: Page): Promise<{ handle: string; sku: string }> {
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
