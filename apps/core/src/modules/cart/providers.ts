// Default pricing providers of the cart module and the registry that lets other modules replace them.
// Tax: our `tax_rate` table (window 7 swaps in Stripe Tax, #127). Shipping: our `shipping_option` table
// (window 8 swaps in live carrier rates, #130). Both read through the mutation's transaction, so RLS keeps
// them inside the cart's store. Prices are tax-EXCLUSIVE in Phase 2 (owner decision 2026-09-08); tax-inclusive
// display is a later store setting.
import type { Queryable } from '@platform/db';
import type {
  PricingContext,
  ShippingOptionRow,
  ShippingRate,
  ShippingRateProvider,
  LineTaxRecord,
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
export function taxOn(baseMinor: number, rateBp: number, included = false): number {
  if (baseMinor <= 0 || rateBp <= 0) return 0;
  // one rounding rule (half up) for both modes: on top = base × bp / 10000; contained = base × bp / (10000 + bp)
  const divisor = included ? 10000 + rateBp : 10000;
  return Math.floor((2 * baseMinor * rateBp + divisor) / (2 * divisor));
}

interface TaxedLineRow {
  quantity: number;
  unit_price_minor: string | number;
  discount_minor: string | number;
  tax_rate_bp: number;
  metadata?: Record<string, unknown> | null;
}

/**
 * A cart or order line's tax as last calculated (`metadata.tax`, #221). A line that was never calculated (rows
 * older than #221) falls back to the exclusive table formula on its stored rate — what those rows were priced with.
 */
export function lineTaxOf(row: TaxedLineRow): LineTaxRecord {
  const stored = row.metadata?.tax as Partial<LineTaxRecord> | undefined;
  if (
    stored &&
    typeof stored.amount_minor === 'number' &&
    Number.isInteger(stored.amount_minor) &&
    stored.amount_minor >= 0 &&
    (stored.mode === 'exclusive' || stored.mode === 'inclusive')
  ) {
    return {
      amount_minor: stored.amount_minor,
      mode: stored.mode,
      bp: typeof stored.bp === 'number' ? stored.bp : row.tax_rate_bp,
    };
  }
  const base = row.quantity * Number(row.unit_price_minor) - Number(row.discount_minor);
  return { amount_minor: taxOn(base, row.tax_rate_bp), mode: 'exclusive', bp: row.tax_rate_bp };
}

/** What a line costs the customer: tax goes on top of exclusive prices and is already inside inclusive ones. */
export function lineTotalWith(baseMinor: number, tax: LineTaxRecord): number {
  return tax.mode === 'inclusive' ? baseMinor : baseMinor + tax.amount_minor;
}

/** `store.settings.tax.prices_include_tax === true` (default false: prices are tax-exclusive). */
export async function pricesIncludeTaxFor(tx: Queryable, storeId: string): Promise<boolean> {
  const r = await tx.query<{ settings: { tax?: { prices_include_tax?: unknown } } | null }>(
    `SELECT settings FROM store WHERE id = $1`,
    [storeId],
  );
  return r.rows[0]?.settings?.tax?.prices_include_tax === true;
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

/**
 * `tax_rate` table calculator: per line `round((qty*unit − discount) × rate_bp / 10000)` on top of exclusive
 * prices, or the contained `round(gross × rate_bp / (10000 + rate_bp))` when the store's prices include tax —
 * the same `taxOn` rounding in both modes; shipping untaxed.
 */
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
      return {
        lineItemId: l.lineItemId,
        taxRateBp,
        taxMinor: taxOn(base, taxRateBp, ctx.pricesIncludeTax === true),
      };
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
