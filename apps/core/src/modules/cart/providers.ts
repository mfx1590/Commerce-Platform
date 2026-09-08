// Default pricing providers of the cart module and the registry that lets other modules replace them.
// Tax: our `tax_rate` table (window 7 swaps in Stripe Tax, #127). Shipping: our `shipping_option` table
// (window 8 swaps in live carrier rates, #130). Both read through the mutation's transaction, so RLS keeps
// them inside the cart's store. Prices are tax-EXCLUSIVE in Phase 2 (owner decision 2026-09-08); tax-inclusive
// display is a later store setting.
import type {
  PricingContext,
  ShippingOptionRow,
  ShippingRate,
  ShippingRateProvider,
  TaxCalculation,
  TaxCalculator,
  TaxLine,
} from './types';

interface TaxRateRow {
  region: string | null;
  rate_bp: number;
  product_category_id: string | null;
}

/** Half-up rounding of `base * bp / 10000` in integer arithmetic (no floats on money). */
export function taxOn(baseMinor: number, rateBp: number): number {
  if (baseMinor <= 0 || rateBp <= 0) return 0;
  return Math.floor((baseMinor * rateBp + 5000) / 10000);
}

/**
 * Picks the most specific `tax_rate` for a line: the line's category over a store-wide rate, and a region match
 * over a country-wide (`region IS NULL`) rate. No matching row → 0 bp (an untaxed destination, not an error).
 */
function pickRate(rates: TaxRateRow[], categoryId: string | null, region: string | null): number {
  const score = (r: TaxRateRow) =>
    (r.product_category_id ? 2 : 0) + (r.region !== null && r.region === region ? 1 : 0);
  const candidates = rates.filter(
    (r) =>
      (r.product_category_id === null || r.product_category_id === categoryId) &&
      (r.region === null || r.region === region),
  );
  return candidates.sort((x, y) => score(y) - score(x))[0]?.rate_bp ?? 0;
}

/** `tax_rate` table calculator: per line `round((qty*unit − discount) × rate_bp / 10000)`; shipping untaxed. */
export const tableTaxCalculator: TaxCalculator = {
  async calculate(ctx): Promise<TaxCalculation> {
    if (ctx.lines.length === 0) return { lines: [], shippingTaxMinor: 0 };
    const r = await ctx.tx.query<TaxRateRow>(
      `SELECT region, rate_bp, product_category_id FROM tax_rate WHERE store_id = $1 AND country = $2`,
      [ctx.storeId, ctx.country],
    );
    const region = ctx.shippingAddress?.region ?? null;
    const lines: TaxLine[] = ctx.lines.map((l) => {
      const taxRateBp = pickRate(r.rows, l.categoryId, region);
      const base = l.quantity * l.unitPriceMinor - l.discountMinor;
      return { lineItemId: l.lineItemId, taxRateBp, taxMinor: taxOn(base, taxRateBp) };
    });
    return { lines, shippingTaxMinor: 0 };
  },
};

const toRate = (o: ShippingOptionRow): ShippingRate => ({
  optionId: o.id,
  code: o.code,
  name: o.name,
  carrier: o.carrier,
  priceMinor: Number(o.price_minor),
  currency: o.currency,
});

/**
 * `shipping_option` table provider: active options of the store in the cart currency whose `countries` list the
 * destination (an empty list = everywhere) and whose sales channel is unset or the cart's. Flat `price_minor`.
 */
export const tableShippingRates: ShippingRateProvider = {
  async list(ctx): Promise<ShippingRate[]> {
    const r = await ctx.tx.query<ShippingOptionRow>(
      `SELECT id, code, name, carrier, price_minor::text, currency FROM shipping_option
       WHERE store_id = $1 AND is_active AND currency = $2
         AND (cardinality(countries) = 0 OR $3 = ANY(countries))
         AND (sales_channel_id IS NULL OR sales_channel_id = $4)
       ORDER BY price_minor, code`,
      [ctx.storeId, ctx.currency, ctx.country, ctx.salesChannelId],
    );
    return r.rows.map(toRate);
  },
  async quote(ctx, optionId): Promise<ShippingRate | null> {
    const r = await ctx.tx.query<ShippingOptionRow>(
      `SELECT id, code, name, carrier, price_minor::text, currency FROM shipping_option
       WHERE id = $1 AND store_id = $2 AND is_active AND currency = $3
         AND (cardinality(countries) = 0 OR $4 = ANY(countries))
         AND (sales_channel_id IS NULL OR sales_channel_id = $5)`,
      [optionId, ctx.storeId, ctx.currency, ctx.country, ctx.salesChannelId],
    );
    const row = r.rows[0];
    return row ? toRate(row) : null;
  },
};

// ---- registry: process-wide, set once at boot by the module that owns the real provider ----
let taxCalculator: TaxCalculator = tableTaxCalculator;
let shippingRates: ShippingRateProvider = tableShippingRates;

/** Replaces the tax calculator (window 7). Returns the previous one so tests can restore it. */
export function setTaxCalculator(next: TaxCalculator): TaxCalculator {
  const previous = taxCalculator;
  taxCalculator = next;
  return previous;
}

/** Replaces the shipping rate provider (window 8). Returns the previous one so tests can restore it. */
export function setShippingRateProvider(next: ShippingRateProvider): ShippingRateProvider {
  const previous = shippingRates;
  shippingRates = next;
  return previous;
}

export function currentTaxCalculator(): TaxCalculator {
  return taxCalculator;
}

export function currentShippingRateProvider(): ShippingRateProvider {
  return shippingRates;
}

export type { PricingContext };
