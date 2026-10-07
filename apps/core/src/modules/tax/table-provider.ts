// The `table` tax provider (task 2.4, #127; delivery VAT #352): our `tax_rate` rows, offline, the default. The
// rate lookup is the cart module's own `tableTaxCalculator` (category over store-wide, region over country-wide,
// no row → 0 bp) — called, never reimplemented — and this provider adds what the built-in calculator does not
// have:
//
//   - **tax-inclusive prices** (`prices_include_tax`): the tax CONTAINED in the gross amount, through the cart
//     module's single rounding seam `taxOn(amount, bp, included)`;
//   - **taxable shipping** (`shipping_taxable`, EU default): the delivery charge carries tax **at the rate of the
//     goods delivered** (EU VAT rule, #352). One rate in the cart → the whole charge at that rate. Mixed rates →
//     the charge is apportioned pro rata to the lines' taxable bases (largest remainder, integer minor units) and
//     each share is taxed at its rate — the NL rule for a mixed-rate supply. An empty cart's shipping is taxed at
//     the destination's store-wide rate (the rate a category-less line gets). Same inclusive/exclusive mode.
//
// Rounding: ONE rule, the cart module's `taxOn(base, bp, included)` (core #224) — integer arithmetic, the TAX
// rounded half-up, per LINE (and per shipping share), never on the cart total. The pro-rata split of the shipping
// charge is an ALLOCATION of a base amount (like a discount allocation), not a rounding of tax: the shares add up
// to the charge exactly and each share's tax goes through `taxOn`. This module has no tax rounding of its own.
import { tableTaxCalculator, taxOn, type TaxCalculation } from '../cart';
import type { TaxContext, TaxProvider, TaxSettings } from './types';

/** Tax on an amount in the store's pricing mode — the cart module's single rounding seam, nothing else. */
export function taxFor(amountMinor: number, rateBp: number, pricesIncludeTax: boolean): number {
  return taxOn(amountMinor, rateBp, pricesIncludeTax);
}

/**
 * Splits `total` across `weights` proportionally, integer results that add up to `total` exactly (largest
 * remainder). Zero or empty weights → everything to the first bucket (callers pass non-empty weights).
 */
export function allocateProRata(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const exact = weights.map((w) => (total * Math.max(0, w)) / sum);
  const shares = exact.map((x) => Math.floor(x));
  let left = total - shares.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((p, q) => q.frac - p.frac || p.i - q.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares;
}

const SHIPPING_REFERENCE = '__shipping__';

/**
 * Tax on the delivery charge at the goods' rate(s): `ratedBases` = the cart's lines as (rate, taxable base);
 * lines with no base carry no weight. No weighted line → `fallbackRateBp` (the store-wide rate).
 */
export function shippingTaxAtGoodsRate(
  shippingMinor: number,
  ratedBases: { rateBp: number; baseMinor: number }[],
  fallbackRateBp: number,
  pricesIncludeTax: boolean,
): number {
  if (shippingMinor <= 0) return 0;
  const byRate = new Map<number, number>();
  for (const { rateBp, baseMinor } of ratedBases) {
    if (baseMinor > 0) byRate.set(rateBp, (byRate.get(rateBp) ?? 0) + baseMinor);
  }
  if (byRate.size === 0) return taxFor(shippingMinor, fallbackRateBp, pricesIncludeTax);
  const rates = [...byRate.keys()];
  if (rates.length === 1) return taxFor(shippingMinor, rates[0]!, pricesIncludeTax);
  const shares = allocateProRata(
    shippingMinor,
    rates.map((r) => byRate.get(r)!),
  );
  return rates.reduce((sum, r, i) => sum + taxFor(shares[i]!, r, pricesIncludeTax), 0);
}

export const tableTaxProvider: TaxProvider = {
  name: 'table',
  async calculate(ctx: TaxContext, settings: TaxSettings): Promise<TaxCalculation> {
    const taxShipping = settings.shippingTaxable && ctx.shippingMinor > 0;
    if (ctx.lines.length === 0 && !taxShipping) return { lines: [], shippingTaxMinor: 0 };
    // One lookup for the lines and (when taxable) a synthetic category-less line for the shipping price: it
    // yields the store-wide rate — the fallback for a cart whose lines carry no taxable base.
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
    const goods = rated.lines.filter((l) => l.lineItemId !== SHIPPING_REFERENCE);
    const lines = goods.map((l) => ({
      lineItemId: l.lineItemId,
      taxRateBp: l.taxRateBp,
      taxMinor: taxFor(baseOf.get(l.lineItemId) ?? 0, l.taxRateBp, settings.pricesIncludeTax),
    }));
    const storeWideRate =
      rated.lines.find((l) => l.lineItemId === SHIPPING_REFERENCE)?.taxRateBp ?? 0;
    return {
      lines,
      shippingTaxMinor: taxShipping
        ? shippingTaxAtGoodsRate(
            ctx.shippingMinor,
            goods.map((l) => ({ rateBp: l.taxRateBp, baseMinor: baseOf.get(l.lineItemId) ?? 0 })),
            storeWideRate,
            settings.pricesIncludeTax,
          )
        : 0,
    };
  },
};
