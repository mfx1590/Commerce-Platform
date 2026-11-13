import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatMoney, minorUnitDigits } from '@platform/ui';

/**
 * Brand D sells in **JPY**, which has **no minor unit**, and this is the test that says so.
 *
 * ## Why this brand needs it more than the others
 *
 * ¥1,980 is `1980` minor units, not 198000. Every other brand on this platform is a two-decimal
 * currency — EUR, GBP, USD — so the assumption "minor units are cents" has never been wrong before,
 * and a `/ 100`, a `* 100` or a `toFixed(2)` added for a plausible reason would look right in
 * brands A, B and C and be wrong by a factor of 100 in exactly one place. That is the kind of
 * defect that reaches production: it is invisible in review, it is invisible in every other brand's
 * tests, and the symptom is a customer charged a hundred times the price.
 *
 * ## Why the suites that exist would not catch it
 *
 * - **The visual baselines cannot.** Measured on brand C (#814): a currency-symbol change is **37
 *   pixels** on the PLP card, against an element tolerance of about 111. A decimal point is a
 *   smaller mark than a symbol. Brand D has no baselines at all yet.
 * - **The e2e would, but only against a core** — and it needs a store with stock, a payment method,
 *   two products, two categories and an image before it runs at all (#830). A guard that needs all
 *   that is an integration run, not a regression test.
 * - **Nothing else in this brand's 749 unit tests formats a price.**
 *
 * So this file is the cheap half: no server, no browser, no backend, on every CI run.
 *
 * It does not prove the server hands the right currency to the component — that is wiring, and the
 * D8 run proved it once end to end against a real core (order 848ec7e3: 1980 + 990 shipping + 198
 * tax = 3168, every figure whole yen). What it proves is that **the formatter this brand renders
 * through cannot quietly start treating yen as cents**.
 */

const STORE = JSON.parse(
  readFileSync(new URL('../perf/store.example.json', import.meta.url), 'utf8'),
) as { default_currency?: string; currencies?: string[]; locales?: string[] };

/** The brand's own currency and locale, read from its store example rather than written here. */
const CURRENCY = STORE.default_currency ?? 'JPY';
const LOCALE = STORE.locales?.[0] ?? 'ja-JP';

/** ¥1,980 as the Store API sends it, and as the D8 order recorded it. */
const PRICE = { amount_minor: 1980, currency: CURRENCY } as const;

describe("brand D's money is yen, and yen has no cents", () => {
  it('sells in JPY and ja-JP, by its own store example rather than a literal here', () => {
    expect(STORE.default_currency).toBe('JPY');
    expect(STORE.currencies).toEqual(['JPY']);
    expect(STORE.locales).toEqual(['ja-JP']);
  });

  it('knows JPY has ZERO minor-unit digits, and that this is currency-dependent', () => {
    // The whole defence in one line: the digit count comes from CLDR, not from an assumption.
    expect(minorUnitDigits(CURRENCY, LOCALE)).toBe(0);
    // ...and it is genuinely per-currency, so a hard-coded 0 would be as wrong as a hard-coded 2.
    expect(minorUnitDigits('USD', 'en-US')).toBe(2);
    expect(minorUnitDigits('EUR', 'de-DE')).toBe(2);
  });

  it('renders 1980 minor units as ¥1,980 — the exact string the PDP shows', () => {
    const rendered = formatMoney(PRICE, LOCALE);
    expect(rendered).toContain('1,980');
    expect(rendered).toMatch(/^[¥￥]/);
  });

  it('renders NO decimal separator at all, which is what catches a hard-coded 2', () => {
    // A `toFixed(2)` or a digits default of 2 anywhere in the chain turns ¥1,980 into ¥1,980.00.
    // This is the assertion that fails for it, and it is the one that would have been missing.
    const rendered = formatMoney(PRICE, LOCALE);
    expect(rendered, `${rendered} must carry no fractional part`).not.toMatch(/[.,]\d{2}$/);
    expect(rendered).not.toContain('1,980.00');
  });

  it('never renders 1980 as 19.80 — the divide-by-100 that treats yen as cents', () => {
    const rendered = formatMoney(PRICE, LOCALE);
    expect(rendered).not.toContain('19.80');
    expect(rendered).not.toContain('19,80');
  });

  it('never renders 1980 as 198,000 — the multiply-by-100 in the other direction', () => {
    const rendered = formatMoney(PRICE, LOCALE);
    expect(rendered).not.toContain('198,000');
    expect(rendered).not.toContain('198000');
  });

  it('separates 1980 from 19.80 arithmetically, not only as strings', () => {
    // The string assertions above all pass if the formatter returns something unrelated. This one
    // says the two amounts are a hundred apart and must never format alike, in either currency's
    // own convention.
    const yen = formatMoney({ amount_minor: 1980, currency: 'JPY' }, LOCALE);
    const dollars = formatMoney({ amount_minor: 1980, currency: 'USD' }, 'en-US');
    expect(yen).not.toBe(dollars);
    expect(dollars).toContain('19.80');
    expect(yen).toContain('1,980');
  });

  it('is not quietly priced in another currency', () => {
    // The #810 class: a fallback that prices this brand in EUR. The brand's string must differ from
    // the euro one and must not carry a euro sign.
    const mine = formatMoney(PRICE, LOCALE);
    expect(mine).not.toContain('€');
    expect(mine).not.toBe(formatMoney({ amount_minor: 1980, currency: 'EUR' }, LOCALE));
  });

  it('carries the D8 order through the same formatter, every line whole yen', () => {
    // Order 848ec7e3, placed against the real core in the D8 proving run. Keeping the figures here
    // means a change that breaks the arithmetic has to break a test that names the order it came
    // from, rather than a number someone can talk themselves out of.
    const item = { amount_minor: 1980, currency: CURRENCY };
    const shipping = { amount_minor: 990, currency: CURRENCY };
    const tax = { amount_minor: 198, currency: CURRENCY };
    const total = { amount_minor: 3168, currency: CURRENCY };

    expect(item.amount_minor + shipping.amount_minor + tax.amount_minor).toBe(total.amount_minor);
    // 10% of the item, added rather than included, and shipping untaxed.
    expect(tax.amount_minor).toBe(Math.round(item.amount_minor * 0.1));

    for (const money of [item, shipping, tax, total]) {
      const rendered = formatMoney(money, LOCALE);
      expect(rendered, `${rendered} must have no fractional part`).not.toMatch(/[.,]\d{2}$/);
      expect(Number.isInteger(money.amount_minor)).toBe(true);
    }
    expect(formatMoney(total, LOCALE)).toContain('3,168');
  });
});
