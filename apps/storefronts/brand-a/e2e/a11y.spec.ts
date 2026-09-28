import AxeBuilder from '@axe-core/playwright';
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
 * Reachable without signing in. Account and checkout need a session; those come with 2.5 (#143).
 *
 * The `(content)` routes are deliberately absent: brand A has no CMS documents until 2.3 (#141), so
 * `/legal/privacy` is a 404 today and scanning it would assert accessibility on an error page. They
 * join this list in 2.3, when there is content to scan.
 */
const PUBLIC_PAGES = [
  { name: 'home', path: '/en-GB' },
  { name: 'product list', path: '/en-GB/products' },
  { name: 'product detail', path: '/en-GB/products/classic-tee' },
  { name: 'cart (empty)', path: '/en-GB/cart' },
  { name: 'German home', path: '/de-DE' },
];

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Rules suppressed because the markup that breaks them is not brand A's to fix, each tied to the
 * issue that will remove it from this list. Nothing else is suppressed — in particular
 * `color-contrast` is fully enforced, which is the rule this suite was added for.
 *
 * - `dlitem` and `definition-list` — the same single defect seen from both sides. The starter's home
 *   page nests each `dt`/`dd` pair inside a `Card`, giving `dl > div > div > dt`: `dlitem` fires on
 *   the orphaned children, `definition-list` on the list that now has disallowed descendants. Ten
 *   nodes per locale, on a page Lighthouse never audits. Filed as REQUEST #286; delete both entries
 *   and re-sync when it lands.
 */
const INHERITED_VIOLATIONS = ['dlitem', 'definition-list'];

for (const page_ of PUBLIC_PAGES) {
  test(`${page_.name} has no WCAG A/AA violations`, async ({ page }) => {
    const response = await page.goto(page_.path);
    // A redirect or a 404 would make an empty scan pass, which is the failure mode this guards.
    expect(response?.status(), `${page_.path} should render`).toBeLessThan(400);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(WCAG_AA)
      .disableRules(INHERITED_VIOLATIONS)
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
 * The specific regression, pinned. The neutral `Badge` is where Stone-on-`muted` rendered, so a scan
 * of a page that contains one is the end-to-end counterpart to the unit test's surface matrix.
 */
test('colour-contrast passes on a page that renders muted surfaces', async ({ page }) => {
  await page.goto('/en-GB/products/classic-tee');
  await page.waitForLoadState('networkidle');

  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(results.violations).toEqual([]);
});
