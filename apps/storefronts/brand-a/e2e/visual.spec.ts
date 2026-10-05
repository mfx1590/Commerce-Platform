import { expect, test } from '@playwright/test';
import { hydrated } from './support/journey';

/**
 * Visual regression snapshots for home / PLP / PDP — issue #140.
 *
 * The theme is the deliverable of task 2.2, and the theme is the one thing a unit test cannot see: a
 * token can be correct while a page renders wrong. These three snapshots are the record of what the
 * design looks like once, so the next change to it has to be deliberate.
 *
 * **Baselines are per platform, and that is not a detail.** Font rasterisation differs between
 * Windows and CI's Linux, so a PNG generated on a laptop fails on CI by thousands of
 * anti-aliasing pixels — a red build that means nothing, which is worse than no test. Two things
 * follow:
 *
 *   1. `snapshotPathTemplate` in `playwright.config.ts` keys baselines by platform, so a Linux
 *      baseline and a Windows one coexist instead of overwriting each other.
 *   2. This project is **opt-in**: it runs only with `E2E_VISUAL=1`. Committing a baseline for a
 *      platform, then running it on another, is the failure above; the flag makes taking the
 *      baseline an explicit act. It also lines up with brand-storefront journeys being opt-in in CI
 *      (`E2E_INCLUDE_BRAND_STOREFRONTS=1`) until window 2 lands #212.
 *
 * Take or refresh baselines with:
 *   E2E_VISUAL=1 pnpm --filter @platform/storefront-brand-a e2e visual --update-snapshots
 *
 * Review the resulting PNG before committing it. A baseline is an assertion about how the brand
 * looks; an unreviewed one asserts whatever happened to render.
 */
test.skip(process.env.E2E_VISUAL !== '1', 'visual regression is opt-in: set E2E_VISUAL=1');

const PAGES = [
  { name: 'home', path: '/en-GB' },
  { name: 'plp', path: '/en-GB/products' },
  { name: 'pdp', path: '/en-GB/products/classic-tee' },
];

for (const page_ of PAGES) {
  test(`${page_.name} matches its visual baseline`, async ({ page }) => {
    await page.goto(page_.path);
    await hydrated(page);
    // A snapshot needs every image painted. Hydration does not wait for them; asking the
    // images themselves does, without waiting on unrelated requests as the old network-idle wait did (#327).
    await page.waitForFunction(() => Array.from(document.images).every((img) => img.complete));

    // The web fonts are the point of the theme: a snapshot taken mid-swap records the fallback face
    // and then differs on every later run for no real reason.
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot(`${page_.name}.png`, {
      fullPage: true,
      // Anti-aliasing moves a few pixels between runs on the same machine, so this cannot be zero.
      // It started at 0.01 and that was measurably too loose: switching every heading from the sans
      // to Newsreader — the central idea of the type pairing — changed fewer pixels than 1% of a
      // full-page shot, and the suite reported "matches". A threshold that sleeps through a typeface
      // swap is not a visual regression test. 0.002 still absorbs rasterisation jitter on one
      // machine and catches a change that small.
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      // The mock returns stable catalogue data, so nothing here is masked — if a future fixture
      // starts varying (a date, a stock count), mask it rather than loosening the ratio.
    });
  });
}
