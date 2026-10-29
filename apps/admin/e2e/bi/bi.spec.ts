import { expect, test } from '@playwright/test';
import { AGAINST_CORE, stamped } from '../api-mode';
import { placeCoreOrder } from '../core-order';
import { signInAsOwner } from '../owner';
import { BRAND_A, BRAND_C, signIn } from '../staff';

/**
 * HQ · BI (#480 / #604, window 12). The page only reads (the report operations #479 and the metrics API #603); the
 * live-tiles test alone writes, one guest order through the Store API.
 *
 * - A store admin on `/bi` gets the 403 state — never an empty chart. Prism and core alike (the store-admin
 *   journey signs in for real in both modes).
 * - Against the core, the seeded owner (password + TOTP; owner.ts waits out a spent code) sees brands A, B and C,
 *   the finance card, and charts that each hold one currency. Whether the shared dev database has sales in the
 *   default 30-day window is not this spec's to decide: it prints which path it checked.
 *
 * - Against the core (#604), the live tiles count an order WRITTEN during the test: placed through the Store API,
 *   relayed onto the bus, ingested into ClickHouse and read back through the metrics API, with the page left
 *   alone so its own 15 s poll is what shows it — as the owner (HQ, then the store view) and as a store admin. These
 *   need the WHOLE pipeline (the relay, the analytics ingest, ClickHouse), which the core-mode CI job does not run:
 *   they are opt-in with `E2E_BI_LIVE=1` (the machine; README "Tests").
 * - Against the core, always: a store admin asking for brand-c (outside its scope) gets the 403 page, a 403 live poll
 *   and a 403 CSV — the API refuses before any analytics read, so no pipeline is needed.
 *
 * Every test prints one `[bi e2e]` line on pass and on skip, with the reason.
 */
const CORE_URL = process.env.CORE_URL ?? 'http://localhost:9000';
const LIVE = AGAINST_CORE && process.env.E2E_BI_LIVE === '1';
const LIVE_WHY =
  'E2E_API=core and E2E_BI_LIVE=1: it writes a real order and needs the relay, the ingest and ClickHouse';
const say = (line: string) => console.info(`[bi e2e] ${line}`);

test.describe('bi', () => {
  test('a store admin on /bi gets the 403 state, not an empty chart', async ({ page }) => {
    await signIn(page, '/bi');
    await page.waitForURL(/\/bi$/);
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
    // A store-only principal is refused by the HQ layout before the BI section guard: its hint names that.
    await expect(page.getByText(/This is an HQ section/)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Currency', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Metrics currency' })).toHaveCount(0);
    await expect(page.getByRole('figure')).toHaveCount(0);
    say('PASS store-admin: 403 panel (HQ section, store relations only), no chart');
  });

  test('the owner sees every brand, the finance card, and one currency per chart', async ({
    page,
  }) => {
    if (!AGAINST_CORE) {
      say(
        "SKIP owner journey: core mode only — Prism's /admin/me is always the store-admin example",
      );
    }
    test.skip(!AGAINST_CORE, "core mode only: Prism's /admin/me is always the store-admin example");

    await signInAsOwner(page, '/bi');
    await page.waitForURL(/\/bi/);
    await expect(page.getByRole('heading', { name: 'BI', exact: true })).toBeVisible();

    // Brands A, B and C: the stock tabs list every store the owner reaches.
    const stores = page.getByRole('navigation', { name: 'Store' });
    await expect(stores.getByRole('link')).toHaveText(['brand-a', 'brand-b', 'brand-c']);
    await expect(page.getByRole('heading', { name: 'Stock', exact: true })).toBeVisible();

    // The owner holds finance: the card renders, fees labelled unreconciled when there is data.
    await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();

    const tabs = page.getByRole('navigation', { name: 'Currency', exact: true });
    if ((await tabs.count()) === 0) {
      await expect(page.getByText('No sales in this window.')).toBeVisible();
      say(
        'PASS owner: brands A, B, C in the stock tabs; finance card; sales path = no sales in the default window',
      );
      return;
    }
    const currencies = await tabs.getByRole('link').allTextContents();
    // the v1 report's two charts (net revenue, orders); the metrics dashboard above draws its own (bookings,
    // refunds), and the shell has its own img
    const charts = page.locator(
      'figure [role="img"][aria-label^="Net revenue per day"], figure [role="img"][aria-label^="Orders per day"]',
    );
    await expect(charts).toHaveCount(2);
    for (const label of await charts.evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label') ?? ''),
    )) {
      const shown = currencies.filter((c) => label.includes(`(${c})`));
      expect(shown, label).toHaveLength(1);
    }
    say(
      `PASS owner: brands A, B, C in the stock tabs; finance card; sales path = tabs ${currencies.join(', ')}, each chart one currency`,
    );
  });

  test('an order written now shows up in the live tiles by their own poll, HQ and store view', async ({
    page,
    request,
  }) => {
    if (!LIVE) say(`SKIP live tiles: ${LIVE_WHY}`);
    test.skip(!LIVE, LIVE_WHY);
    test.setTimeout(240_000);

    await signInAsOwner(page, '/bi');
    await page.waitForURL(/\/bi/);
    const freshness = page.getByTestId('bi-live-freshness');
    await expect(freshness).toBeVisible();
    // brand-a's tile in EUR (the seeded brand-a dev key places EUR orders); absent = no order today yet
    const tile = page.locator('[data-testid="bi-live-tile"][data-currency="EUR"]').filter({
      hasText: 'brand-a',
    });
    const ordersOf = async () =>
      (await tile.count()) === 0
        ? 0
        : Number(/(\d+)/.exec((await tile.getByTestId('bi-live-orders').textContent()) ?? '')?.[1]);
    const before = await ordersOf();

    const placed = await placeCoreOrder(request, CORE_URL, stamped('bi-live'));
    // no reload: the tiles' own 15 s poll has to bring it (relay → bus → ingest → ClickHouse → metrics API)
    await expect.poll(ordersOf, { timeout: 180_000, intervals: [5_000] }).toBe(before + 1);
    const storeId = await tile.getAttribute('data-store');
    say(`live HQ: brand-a EUR ${before} → ${before + 1} after order ${placed.display_id}`);

    // the store view: the same tile, narrowed to brand-a, with its own poll endpoint
    await page.goto(`/${storeId}/bi`);
    await expect(page.getByTestId('bi-live-freshness')).toBeVisible();
    const tiles = page.getByTestId('bi-live-tile');
    await expect(tiles.filter({ hasText: 'brand-a' }).first()).toBeVisible();
    for (const store of await tiles.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-store')),
    ))
      expect(store).toBe(storeId);
    say(
      `PASS live tiles: order ${placed.display_id} counted by the poll; store view shows brand-a only`,
    );
  });

  // The seeded store-admin holds store_admin on brand-a and brand-b only: brand-c is the store outside its scope.
  test('a store admin asking for a store outside its scope: 403 page, 403 live poll, 403 CSV, no tile', async ({
    page,
  }) => {
    if (!AGAINST_CORE) say('SKIP store-admin scope: core mode only (the real scope check)');
    test.skip(!AGAINST_CORE, "core mode only: Prism's answers carry no scope");

    await signIn(page, `/${BRAND_C}/bi`);
    await page.waitForURL(new RegExp(`/${BRAND_C}/bi`));
    await expect(page.getByRole('heading', { name: /do not have access/i })).toBeVisible();
    await expect(page.getByTestId('bi-live-tile')).toHaveCount(0);
    const live = await page.request.get(`/${BRAND_C}/bi/live`);
    expect(live.status()).toBe(403);
    expect(await live.json()).toMatchObject({ code: 'forbidden' });
    const csv = await page.request.get(`/${BRAND_C}/bi/export?table=period`);
    expect(csv.status()).toBe(403);
    expect(csv.headers()['content-disposition']).toBeUndefined();
    say('PASS store-admin scope: brand-c = 403 page, 403 live, 403 CSV, no tile');
  });

  test('a store admin writes an order: its own store tile moves, and only its store is shown', async ({
    page,
    request,
  }) => {
    if (!LIVE) say(`SKIP store-admin live: ${LIVE_WHY}`);
    test.skip(!LIVE, LIVE_WHY);
    test.setTimeout(240_000);

    await signIn(page, `/${BRAND_A}/bi`);
    await page.waitForURL(new RegExp(`/${BRAND_A}/bi`));
    await expect(page.getByTestId('bi-live-freshness')).toBeVisible();
    const tiles = page.getByTestId('bi-live-tile');
    const tile = tiles.and(page.locator('[data-currency="EUR"]'));
    const ordersOf = async () =>
      (await tile.count()) === 0
        ? 0
        : Number(/(\d+)/.exec((await tile.getByTestId('bi-live-orders').textContent()) ?? '')?.[1]);
    const before = await ordersOf();

    const placed = await placeCoreOrder(request, CORE_URL, stamped('bi-store-admin'));
    await expect.poll(ordersOf, { timeout: 180_000, intervals: [5_000] }).toBe(before + 1);
    for (const store of await tiles.evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-store')),
    ))
      expect(store).toBe(BRAND_A);
    say(
      `PASS store-admin live: order ${placed.display_id} moved brand-a's tile (${before} → ${before + 1}); brand-a only`,
    );
  });
});
