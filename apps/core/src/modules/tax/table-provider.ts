// The `table` tax provider (task 2.4, #127): our `tax_rate` rows, offline, the default. The rate lookup is the
// cart module's own `tableTaxCalculator` (category over store-wide, region over country-wide, no row → 0 bp) —
// called, never reimplemented — and this provider adds what the built-in calculator does not have:
//
//   - **tax-inclusive prices** (`prices_include_tax`): the tax CONTAINED in the gross amount, through the cart
//     module's single rounding seam `taxOn(amount, bp, included)`;
//   - **taxable shipping** (`shipping_taxable`): the shipping price is taxed at the destination's store-wide
//     rate (the rate a line without a category gets), in the same inclusive/exclusive mode.
//
// Rounding: ONE rule, the cart module's `taxOn(base, bp, included)` (core #224) — integer arithmetic, the TAX
// rounded half-up, per LINE (and once for shipping), never on the cart total: on top = base × bp / 10000,
// contained = base × bp / (10000 + bp). This module has no rounding of its own.
import { tableTaxCalculator, taxOn, type TaxCalculation } from '../cart';
import type { TaxContext, TaxProvider, TaxSettings } from './types';

/** Tax on an amount in the store's pricing mode — the cart module's single rounding seam, nothing else. */
export function taxFor(amountMinor: number, rateBp: number, pricesIncludeTax: boolean): number {
  return taxOn(amountMinor, rateBp, pricesIncludeTax);
}

const SHIPPING_REFERENCE = '__shipping__';

export const tableTaxProvider: TaxProvider = {
  name: 'table',
  async calculate(ctx: TaxContext, settings: TaxSettings): Promise<TaxCalculation> {
    const taxShipping = settings.shippingTaxable && ctx.shippingMinor > 0;
    if (ctx.lines.length === 0 && !taxShipping) return { lines: [], shippingTaxMinor: 0 };
    // One lookup for the lines and (when taxable) a synthetic category-less line for the shipping price: the
    // cart's calculator resolves its rate exactly like any store-wide line.
    const rated = await tableTaxCalculator.calculate({
      ...ctx,
      lines: taxShipping
        ? [
            ...ctx.lines,
            {
              lineItemId: SHIPPING_REFERENCE,
              variantId: SHIPPING_REFERENCE,
              productId: SHIPPING_REFERENCE,
              categoryId: null,
              quantity: 1,
              unitPriceMinor: ctx.shippingMinor,
              discountMinor: 0,
            },
          ]
        : ctx.lines,
    });
    const baseOf = new Map(
      ctx.lines.map((l) => [l.lineItemId, l.quantity * l.unitPriceMinor - l.discountMinor]),
    );
    const lines = rated.lines
      .filter((l) => l.lineItemId !== SHIPPING_REFERENCE)
      .map((l) => ({
        lineItemId: l.lineItemId,
        taxRateBp: l.taxRateBp,
        taxMinor: taxFor(baseOf.get(l.lineItemId) ?? 0, l.taxRateBp, settings.pricesIncludeTax),
      }));
    const shippingRate =
      rated.lines.find((l) => l.lineItemId === SHIPPING_REFERENCE)?.taxRateBp ?? 0;
    return {
      lines,
      shippingTaxMinor: taxShipping
        ? taxFor(ctx.shippingMinor, shippingRate, settings.pricesIncludeTax)
        : 0,
    };
  },
};
