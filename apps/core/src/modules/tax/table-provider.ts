// The `table` tax provider (task 2.4, #127): our `tax_rate` rows, offline, the default. The rate lookup is the
// cart module's own `tableTaxCalculator` (category over store-wide, region over country-wide, no row → 0 bp) —
// called, never reimplemented — and this provider adds what the built-in calculator does not have:
//
//   - **tax-inclusive prices** (`prices_include_tax`): the tax is extracted from the gross amount,
//     `gross − round(gross × 10000 / (10000 + bp))`, instead of `round(net × bp / 10000)` on top;
//   - **taxable shipping** (`shipping_taxable`): the shipping price is taxed at the destination's store-wide
//     rate (the rate a line without a category gets), in the same inclusive/exclusive mode.
//
// Rounding: integer arithmetic only, half-up, per LINE (and once for shipping) — never on the cart total — so the
// amounts frozen on order lines add up exactly to the order's tax. Inclusive extraction rounds the NET half-up
// and takes the tax as the remainder, so `net + tax === gross` always holds to the cent.
import { tableTaxCalculator, taxOn, type TaxCalculation } from '../cart';
import type { TaxContext, TaxProvider, TaxSettings } from './types';

/** Tax contained in a gross (tax-inclusive) amount: `gross − round(gross / (1 + rate))`, integer, half-up net. */
export function inclusiveTaxOn(grossMinor: number, rateBp: number): number {
  if (grossMinor <= 0 || rateBp <= 0) return 0;
  const divisor = 10000 + rateBp;
  const net = Math.floor((grossMinor * 10000 + Math.floor(divisor / 2)) / divisor);
  return grossMinor - net;
}

/** Tax on an amount in the store's pricing mode. */
export function taxFor(amountMinor: number, rateBp: number, pricesIncludeTax: boolean): number {
  return pricesIncludeTax ? inclusiveTaxOn(amountMinor, rateBp) : taxOn(amountMinor, rateBp);
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
