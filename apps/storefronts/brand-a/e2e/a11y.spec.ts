import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * Accessibility gate for brand A's theme — issue #140, "contrast checks pass (axe in the e2e suite)".
 *
 * This exists because Lighthouse was not enough. It scored accessibility 1.00 on the PLP and the PDP
 * while the theme shipped a real WCAG AA failure: Stone on the `muted` surface at 4.36:1, in the
 * neutral `Badge` and the CMS hero eyebrow. Lighthouse audits the two URLs in `lighthouserc.json`;
 * neither renders those components, so a perfect score said nothing about them. Review caught it.
 *
 * The lesson shapes this file: breadth over depth. It walks every page reachable without a session,
 * and it asserts on the whole WCAG 2.1 A/AA rule set rather than colour alone, because the next thing
 * to slip will not be a contrast ratio.
 *
 * `test/brand-theme.test.ts` checks the same property one level down, over the token matrix, where it
 * runs in milliseconds and does not need a browser. Both are wanted: the unit test proves the palette
 * is sound, this proves the palette is what the pages actually render.
 */

/**
 * The one inherited defect brand A does not own, and the only suppression anywhere in this file.
 *
 * The starter's home page nests each `dt`/`dd` pair inside a `Card`, giving `dl > div > div > dt`.
 * That trips two rules for one root cause: `dlitem` on the orphaned children, `definition-list` on
 * the list that now has disallowed descendants. Ten nodes per locale, on a page Lighthouse never
 * audits. Filed as REQUEST #286 — delete this constant and re-sync when it lands.
 *
 * It is applied **per page** (see `allow` above), not globally, so the suppression cannot quietly
 * cover the same rule breaking somewhere it is genuinely brand A's problem. `color-contrast` — the
 * rule this suite exists for — is never suppressed anywhere.
 */
const INHERITED_DL_DEFECT: readonly string[] = ['dlitem', 'definition-list'];

/**
 * Reachable without signing in. Account and checkout need a session; those come with 2.5 (#143).
 *
 * The `(content)` routes joined this list in 2.3 (#141), now that brand A has real documents. They
 * were deliberately absent in 2.2: `/legal/privacy` was a 404 then, and scanning it would have
 * asserted accessibility on an error page — a green test that checked nothing.
 *
 * These scans need the content to be in the dataset, so they are skipped unless `CMS_DATASET` is
 * configured; `test/cms-brand-content.test.ts` covers the same documents offline and always runs.
 */
interface ScannedPage {
  name: string;
  path: string;
  /** Rule ids suppressed on this page only — see INHERITED_DL_DEFECT. */
  allow: readonly string[];
}

const PUBLIC_PAGES: ScannedPage[] = [
  // `allow` scopes the inherited-defect suppression to the pages that actually contain the defect.
  // The store-facts grid renders on the home page in **every locale**, so this is keyed by page
  // rather than by a single path — /en-GB and /de-DE are the same page, twice.
  { name: 'home', path: '/en-GB', allow: INHERITED_DL_DEFECT },
  { name: 'German home', path: '/de-DE', allow: INHERITED_DL_DEFECT },
  { name: 'product list', path: '/en-GB/products', allow: [] },
  { name: 'product detail', path: '/en-GB/products/classic-tee', allow: [] },
  { name: 'cart (empty)', path: '/en-GB/cart', allow: [] },
];

/** Content routes: only meaningful when the CMS is reachable and seeded (see above). */
const CONTENT_PAGES: ScannedPage[] = [
  { name: 'legal page', path: '/en-GB/legal/privacy', allow: [] },
  { name: 'German legal page', path: '/de-DE/legal/imprint', allow: [] },
  { name: 'content page', path: '/en-GB/pages/about', allow: [] },
];

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const page_ of [...PUBLIC_PAGES, ...CONTENT_PAGES]) {
  const isContent = CONTENT_PAGES.includes(page_);

  test(`${page_.name} has no WCAG A/AA violations`, async ({ page }) => {
    test.skip(
      isContent && !process.env.CMS_DATASET,
      'content routes need a seeded CMS dataset (CMS_DATASET)',
    );
    const response = await page.goto(page_.path);
    // A redirect or a 404 would make an empty scan pass, which is the failure mode this guards.
    expect(response?.status(), `${page_.path} should render`).toBeLessThan(400);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_AA)
      .disableRules([...page_.allow])
      .analyze();

    // Name the offending nodes in the failure message: "2 violations" sends the reader to the trace,
    // a selector and a colour pair sends them to the token.
    const detail = results.violations
      .map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help}\n` +
          v.nodes.map((n) => `      ${n.target.join(' ')}\n      ${n.failureSummary}`).join('\n'),
      )
      .join('\n\n');

    expect(detail, `axe violations on ${page_.path}`).toBe('');
  });
}

/**
 * The suppression list itself, pinned. Without this, a future red build could be made green by
 * quietly adding a rule id — which is how allowlists rot. Widening it now takes editing this test
 * and saying why.
 */
test('suppresses exactly two rules, for one inherited defect, tied to its issue', () => {
  expect([...INHERITED_DL_DEFECT]).toEqual(['dlitem', 'definition-list']);

  const suppressed = PUBLIC_PAGES.flatMap((p) => [...p.allow]);
  expect(new Set(suppressed)).toEqual(new Set(INHERITED_DL_DEFECT));

  // Only the home page in its two locales carries the suppression; nothing else does.
  expect(PUBLIC_PAGES.filter((p) => p.allow.length > 0).map((p) => p.path)).toEqual([
    '/en-GB',
    '/de-DE',
  ]);

  // The rule the suite was added for is never suppressed.
  expect(suppressed).not.toContain('color-contrast');

  // The issue that removes it is named in this file.
  expect(readFileSync(new URL(import.meta.url), 'utf8')).toContain('#286');
});

/**
 * The specific regression, pinned. The neutral `Badge` is where Stone-on-`muted` rendered, so a scan
 * of a page that contains one is the end-to-end counterpart to the unit test's surface matrix.
 */
test('colour-contrast passes on a page that renders muted surfaces', async ({ page }) => {
  await page.goto('/en-GB/products/classic-tee');
  await page.waitForLoadState('networkidle');

  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(results.violations).toEqual([]);
});
