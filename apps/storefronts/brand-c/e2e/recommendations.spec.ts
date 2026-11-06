import { expect, test, type Page } from '@playwright/test';
import {
  AGAINST_CORE,
  BACKEND,
  clickWhenReady,
  hydrated,
  openPurchasableProduct,
  SERVER_ACTION_TIMEOUT,
} from './support/journey';
import { localePath, localeUrl } from './support/locale';

/**
 * The recommendation rails (#609), end to end.
 *
 * - **Server-rendered**: the rail is in the HTML the server sends, read without a browser. Nothing
 *   is inserted after paint, which is the reason it cannot shift the layout.
 * - **No layout shift**: the page's `layout-shift` entries, loaded and scrolled to the rail, stay at
 *   zero. Lighthouse measures the same on the budget run.
 * - **Analytics**: `recommendation_viewed` when the rail is on screen and `recommendation_clicked` on
 *   a card, both carrying the SERVED kind (the rail's `data-kind`) and the surface.
 *
 * Against the mock the rail is always populated (the spec example). Against a real core it can be
 * empty — the nightly job may not have run — and an empty rail is valid. So the populated checks
 * skip there rather than fail.
 */

/**
 * Keeps every analytics event and layout shift in sessionStorage, so a click that navigates away
 * does not take the evidence with it.
 */
async function record(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const keep = (key: string, value: unknown) => {
      const list = JSON.parse(sessionStorage.getItem(key) ?? '[]') as unknown[];
      list.push(value);
      sessionStorage.setItem(key, JSON.stringify(list));
    };
    window.addEventListener('platform:analytics', (event) =>
      keep('e2e-analytics', (event as CustomEvent).detail),
    );
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!entry.hadRecentInput) keep('e2e-shifts', entry.value);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

async function recorded<T>(page: Page, key: string): Promise<T[]> {
  return page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? '[]'), key);
}

interface Seen {
  event: string;
  kind: string;
  surface: string;
  product_ids: string[];
  product_id?: string;
  position?: number;
}

async function firstHandle(page: Page): Promise<string> {
  const { handle } = await openPurchasableProduct(page);
  return handle;
}

test('PDP: the rail is in the server HTML, shifts nothing, and reports view and click', async ({
  page,
}) => {
  await record(page);
  const handle = await firstHandle(page);
  const path = localePath(`/products/${handle}`);

  // Raw HTML, no JavaScript: a rail that only appears after hydration would be missing here.
  const html = await (await page.request.get(path)).text();
  const inHtml = /data-testid="recommendation-rail"[^>]*data-surface="pdp"/.test(html);
  test.skip(AGAINST_CORE && !inHtml, `${BACKEND} served no recommendations for ${handle}`);
  expect(inHtml, 'the PDP rail is server-rendered').toBe(true);

  // Only this page's shifts and events count, not the listing's that chose the product.
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(path);
  await hydrated(page);
  const rail = page.locator('[data-testid="recommendation-rail"][data-surface="pdp"]');
  await expect(rail.getByRole('heading', { level: 2 })).toHaveText('Frequently bought together');
  const kind = await rail.getAttribute('data-kind');

  await rail.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await recorded<Seen>(page, 'e2e-analytics')).map((e) => e.event))
    .toContain('recommendation_viewed');
  const [viewed] = await recorded<Seen>(page, 'e2e-analytics');
  expect(viewed).toMatchObject({ kind, surface: 'pdp' });
  expect(viewed!.product_ids.length).toBeGreaterThan(0);

  const shifts = await recorded<number>(page, 'e2e-shifts');
  expect(
    shifts.reduce((sum, value) => sum + value, 0),
    'cumulative layout shift on the PDP, loaded and scrolled to the rail',
  ).toBeLessThan(0.01);

  await clickWhenReady(
    page,
    rail.getByTestId('product-card').first().getByRole('heading').getByRole('link'),
  );
  await expect(page).toHaveURL(localeUrl('/products/[^/]+$'));
  const clicked = (await recorded<Seen>(page, 'e2e-analytics')).find(
    (e) => e.event === 'recommendation_clicked',
  );
  expect(clicked).toMatchObject({ kind, surface: 'pdp', position: 1 });
  expect(clicked!.product_id).toBe(viewed!.product_ids[0]);
});

test('cart: "You may also like" from the cart lines, reported with surface cart', async ({
  page,
}) => {
  await record(page);
  await firstHandle(page);
  await clickWhenReady(page, page.getByRole('button', { name: 'Add to cart' }));
  await expect(page).toHaveURL(localeUrl('/cart$'), { timeout: SERVER_ACTION_TIMEOUT });

  const rail = page.locator('[data-testid="recommendation-rail"][data-surface="cart"]');
  const count = await rail.count();
  test.skip(AGAINST_CORE && count === 0, `${BACKEND} served no recommendations for this cart`);

  await expect(rail.getByRole('heading', { level: 2 })).toHaveText('You may also like');
  await rail.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await recorded<Seen>(page, 'e2e-analytics')).map((e) => e.surface))
    .toContain('cart');
  const viewed = (await recorded<Seen>(page, 'e2e-analytics')).find((e) => e.surface === 'cart');
  expect(viewed).toMatchObject({
    event: 'recommendation_viewed',
    kind: await rail.getAttribute('data-kind'),
  });
});
