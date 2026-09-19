// Tax module types (task 2.4, #127). A `TaxProvider` computes tax for one pricing pass of the cart under a
// store's tax settings; the module registers ONE cart `TaxCalculator` that reads those settings and dispatches.
import type { TaxCalculation, TaxCalculator } from '../cart';

export type TaxProviderName = 'table' | 'stripe';

/** What the cart hands to its calculator (`PricingContext & { shippingMinor }`). */
export type TaxContext = Parameters<TaxCalculator['calculate']>[0];

/**
 * `store.settings.tax`:
 *
 * - `provider` — `table` (our `tax_rate` rows; offline, the default) or `stripe` (Stripe Tax, test mode);
 * - `prices_include_tax` — catalogue prices are gross (EU/UK consumer pricing): tax is EXTRACTED from the price
 *   instead of added on top. Default `false` (Phase 2's exclusive pricing, owner decision 2026-09-08);
 * - `shipping_taxable` — tax the shipping price at the destination's store-wide rate (table provider; Stripe Tax
 *   always decides shipping tax itself). Default `false`, which is what the cart's built-in calculator does.
 */
export interface TaxSettings {
  provider: TaxProviderName;
  pricesIncludeTax: boolean;
  shippingTaxable: boolean;
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  provider: 'table',
  pricesIncludeTax: false,
  shippingTaxable: false,
};

export const TAX_SETTINGS_KEY = 'tax';

/**
 * Reads `store.settings.tax`. Unknown or malformed fields fall back to the defaults rather than throwing: a
 * store whose settings a human mistyped still prices with the table rates, tax-exclusive (same rule as the
 * shipping module's `carrierConfigFor`).
 */
export function taxSettingsFrom(storeSettings: unknown): TaxSettings {
  const raw =
    storeSettings && typeof storeSettings === 'object'
      ? (storeSettings as Record<string, unknown>)[TAX_SETTINGS_KEY]
      : undefined;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TAX_SETTINGS };
  const t = raw as Record<string, unknown>;
  return {
    provider: t.provider === 'stripe' ? 'stripe' : 'table',
    pricesIncludeTax: t.prices_include_tax === true,
    shippingTaxable: t.shipping_taxable === true,
  };
}

/** A tax engine. `settings` are the store's, already resolved by the dispatching calculator. */
export interface TaxProvider {
  readonly name: TaxProviderName;
  calculate(ctx: TaxContext, settings: TaxSettings): Promise<TaxCalculation>;
}
