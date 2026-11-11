import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@platform/ui';

/**
 * Brand C sells in **USD**, and this is the test that says so.
 *
 * ## Why a unit test, when this app has visual baselines
 *
 * Because the baselines demonstrably cannot catch it, and that was measured rather than assumed.
 * With the mock serving this brand's own currency (`scripts/e2e-store-mock.mjs`), the difference
 * between a `€` price and a `$` price on the PLP card is **37 pixels**. The element shots allow
 * `maxDiffPixelRatio: 0.002`, which on that image is about 111 pixels, so the suite passes either
 * way — and a full-page shot dilutes it further. #781 chose those tolerances against a heading
 * weight and a typeface swap, both far larger; one glyph is below them by design.
 *
 * So the pixels guard the design and this file guards the money. It is also the cheap half: no
 * server, no browser, no backend.
 *
 * It does NOT prove the server hands the right currency to the component — that is wiring, and
 * `e2e/journey.spec.ts` walks it against a real store. What it does prove is that **this brand's**
 * currency formats the way this brand needs, and that a regression which hard-codes some other
 * currency is visible immediately (#810 is where the platform's EUR fallbacks are being removed).
 */

const STORE = JSON.parse(
  readFileSync(new URL('../perf/store.example.json', import.meta.url), 'utf8'),
) as { default_currency?: string; currencies?: string[]; locales?: string[] };

describe("brand C's money", () => {
  it('sells in USD, by its own store example rather than a literal here', () => {
    // The store example is what `scripts/e2e-store-mock.mjs` serves and what `pnpm perf` measures
    // against, so it is the one place the brand's currency is written down on this side.
    expect(STORE.default_currency).toBe('USD');
    expect(STORE.currencies).toEqual(['USD']);
    expect(STORE.locales).toEqual(['en-US']);
  });

  it('formats a price in the brand’s own currency and locale', () => {
    const locale = STORE.locales?.[0] ?? 'en-US';
    const currency = STORE.default_currency ?? 'USD';
    const formatted = formatMoney({ amount_minor: 1999, currency }, locale);

    expect(formatted).toContain('19.99');
    expect(formatted.startsWith('$'), `expected a leading $, got ${formatted}`).toBe(true);
    // Two decimals: USD is not a zero-decimal currency, and the shared formatter derives the digits
    // from Intl rather than assuming 2 — which is what will matter for a JPY brand.
    expect(formatted).toMatch(/^\$\d+\.\d{2}$/);
  });

  it('does not render some other currency’s symbol for the same amount', () => {
    // The regression this exists for: a fallback that quietly prices this brand in EUR. The two
    // strings must differ, and the brand's must not be the euro one.
    const locale = STORE.locales?.[0] ?? 'en-US';
    const mine = formatMoney(
      { amount_minor: 1999, currency: STORE.default_currency ?? 'USD' },
      locale,
    );
    const euros = formatMoney({ amount_minor: 1999, currency: 'EUR' }, locale);

    expect(mine).not.toBe(euros);
    expect(mine).not.toContain('€');
  });
});
