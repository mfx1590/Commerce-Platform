import { expect, test, type Locator, type Page } from '@playwright/test';
import { hydrated } from './support/journey';
// The app's own default locale (#797): a hard-coded `/en-GB` shot brand C's 404 page.
import { localePath } from './support/locale';

/**
 * Visual regression for home / PLP / PDP (#140, tolerances from #766's measurement).
 *
 * The theme is the one thing a unit test cannot see: a token can be correct while a page renders
 * wrong. These snapshots record what the design looks like, so the next change to it has to be
 * deliberate.
 *
 * **Two kinds of shot, because one cannot do both jobs.** A full-page shot catches a change
 * anywhere, but a small one is diluted by the whole page. An element shot catches a small change
 * in what it frames and nothing outside it. Measured on one machine and one build (#766): repeat
 * shots differ by exactly 0 pixels, while one heading weight step (700 → 500) changes
 * 0.0002–0.0008 of a full-page shot and 0.021–0.113 of the h1's own shot. A heading typeface swap
 * changes 0.0004–0.0008 of the full page and 0.021–0.137 of the h1.
 *
 * - Full page: `maxDiffPixelRatio: 0.0001`. That is half the smallest real change measured. The old
 *   0.002 let both of those changes pass.
 * - Element shots (the h1, the first product card, the add-to-cart button): `0.002`, an order of
 *   magnitude below the changes they exist for.
 *
 * **Baselines are per platform and per app, and that is not a detail.**
 * - Font rasterisation differs between Windows and CI's Linux, so a baseline taken on a laptop fails
 *   on Linux by thousands of anti-aliasing pixels. The Playwright config keys baselines by platform
 *   (`snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}'`), and the suite is
 *   **opt-in** (`E2E_VISUAL=1`), so taking a baseline is an explicit act.
 * - The starter commits **no** baselines. The brand sync copies every tracked starter file, so a
 *   starter PNG would overwrite each brand's own. A brand takes and commits its own.
 *
 * Take or refresh baselines (then REVIEW every PNG before committing; an unreviewed baseline
 * asserts whatever happened to render):
 *   E2E_VISUAL=1 pnpm --filter <app> e2e visual --update-snapshots
 */
test.skip(process.env.E2E_VISUAL !== '1', 'visual regression is opt-in: set E2E_VISUAL=1');

const FULL_PAGE = { fullPage: true, maxDiffPixelRatio: 0.0001, animations: 'disabled' } as const;
const ELEMENT = { maxDiffPixelRatio: 0.002, animations: 'disabled' } as const;

/**
 * Each page, and what proves it IS that page (#797): a wrong page can be perfectly stable, so a
 * baseline would happily record a 404. Checked (with a 200 status) before any screenshot.
 */
const PAGES: {
  name: string;
  path: string;
  marker: (page: Page) => Locator;
  elements: (page: Page) => Record<string, Locator>;
}[] = [
  {
    name: 'home',
    path: localePath(''),
    // Home's own section, not "any h1": the 404 page has an h1 too (#793 review).
    marker: (page) => page.locator('section[aria-labelledby="store-facts"]'),
    elements: (page) => ({ h1: page.getByRole('heading', { level: 1 }).first() }),
  },
  {
    name: 'plp',
    path: localePath('/products'),
    marker: (page) => page.getByTestId('product-card').first(),
    elements: (page) => ({
      h1: page.getByRole('heading', { level: 1 }).first(),
      card: page.getByTestId('product-card').first(),
    }),
  },
  {
    name: 'pdp',
    path: localePath('/products/classic-tee'),
    marker: (page) => page.getByTestId('add-to-cart'),
    elements: (page) => ({
      h1: page.getByRole('heading', { level: 1 }).first(),
      button: page.getByTestId('add-to-cart').getByRole('button').first(),
    }),
  },
];

for (const entry of PAGES) {
  test(`${entry.name} matches its visual baselines`, async ({ page }) => {
    const response = await page.goto(entry.path);
    // The expected page, not a 404 or an error page that happens to render the same every time.
    expect(response?.status(), `${entry.name}: ${entry.path} answers 200`).toBe(200);
    await expect(
      entry.marker(page),
      `${entry.name}: the page's own content is there`,
    ).toBeVisible();
    await hydrated(page);
    // A snapshot needs every image painted. Hydration does not wait for them; asking the images
    // themselves does, without waiting on unrelated requests as a network-idle wait would (#327).
    await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));
    // A brand's web fonts are the point of its theme: a snapshot taken mid-swap records the
    // fallback face and then differs on every later run for no real reason.
    await page.evaluate(() => document.fonts.ready);

    // The full page keeps its old file name, so a brand's existing baseline still applies.
    // The mock returns stable catalogue data, so nothing is masked. If a fixture starts varying
    // (a date, a stock count), mask it rather than loosening a ratio.
    await expect.soft(page).toHaveScreenshot(`${entry.name}.png`, FULL_PAGE);
    for (const [element, locator] of Object.entries(entry.elements(page))) {
      await expect.soft(locator).toHaveScreenshot(`${entry.name}-${element}.png`, ELEMENT);
    }
  });
}
