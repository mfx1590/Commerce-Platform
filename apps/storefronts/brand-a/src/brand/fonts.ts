import localFont from 'next/font/local';

/**
 * Brand A's two faces, per `src/brand/DESIGN.md` §3.
 *
 * Committed as woff2 beside this file and loaded with `next/font/local` rather than
 * `next/font/google`, following `apps/admin/src/app/fonts.ts`: a build must never need the network,
 * so CI and the image build stay hermetic, a customer's first paint makes no request to
 * `fonts.gstatic.com`, and no third party learns who is reading the page.
 *
 * Latin subset only. Brand A sells in `en-GB` and `de-DE`, and the Latin subset covers both —
 * umlauts and the eszett are inside U+0000-00FF.
 *
 * Licences: `fonts/OFL-*.txt` (SIL Open Font License 1.1).
 *
 * These are consumed by `tokens.ts`, not by any component: a component never names a font family.
 * See DESIGN.md §5 for why the wiring goes through the tokens rather than through a slot.
 *
 * One consequence, measured and accepted (DESIGN.md §6): because nothing renders a `className` or
 * `variable` from these objects, `next/font` emits no `<link rel="preload">`. The size-adjusted
 * fallback it generates absorbs the swap — CLS measures 0.0000 on the PLP and 0.0001 on the PDP —
 * so the preload is not worth reintroducing the checkout hole to buy back.
 */

/**
 * Newsreader — headings, product names, pull quotes.
 *
 * The weight axis only. Newsreader also ships an optical-size axis (`opsz`), and the two-axis file
 * measures 132 kB against 58 kB for this one: 74 kB, more than double, for a face that only sets
 * headings. Measured, not assumed. The optical grading is a real loss, and the budget on a
 * perf-gated storefront is the stronger claim.
 */
export const displaySerif = localFont({
  src: [{ path: './fonts/newsreader-latin.woff2', weight: '400 700', style: 'normal' }],
  display: 'swap',
  fallback: ['Georgia', 'Cambria', 'Times New Roman', 'serif'],
});

/** Hanken Grotesk — body copy, navigation, labels, and every control. */
export const textSans = localFont({
  src: [{ path: './fonts/hanken-grotesk-latin.woff2', weight: '300 700', style: 'normal' }],
  display: 'swap',
  fallback: ['Segoe UI', 'system-ui', '-apple-system', 'Helvetica', 'Arial', 'sans-serif'],
});
