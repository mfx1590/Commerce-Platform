// Tax module types (task 2.4, #127; delivery VAT #352). A `TaxProvider` computes tax for one pricing pass of the
// cart under a store's tax settings; the module registers ONE cart `TaxCalculator` that reads those settings and
// dispatches.
import type { TaxCalculation, TaxCalculator } from '../cart';

export type TaxProviderName = 'table' | 'stripe';

/** What the cart hands to its calculator (`PricingContext & { shippingMinor }`). */
export type TaxContext = Parameters<TaxCalculator['calculate']>[0];

/**
 * The EU VAT area by ISO 3166-1 alpha-2 (the 27 member states). In the EU the delivery charge is part of the
 * taxable amount of the supply and carries VAT at the rate of the goods delivered (#352: NL 21 % on a €4.99
 * delivery), so a store whose legal entity sits here taxes shipping unless its settings say otherwise.
 */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

/** The platform default for `shipping_taxable` when the store has not set it: EU legal entity → taxable. */
export function defaultShippingTaxable(legalEntityCountry: string | null | undefined): boolean {
  return Boolean(legalEntityCountry && EU_COUNTRIES.has(legalEntityCountry.toUpperCase()));
}

/**
 * `store.settings.tax`:
 *
 * - `provider` — `table` (our `tax_rate` rows; offline, the default) or `stripe` (Stripe Tax, test mode);
 * - `prices_include_tax` — catalogue prices are gross (EU/UK consumer pricing): tax is EXTRACTED from the price
 *   instead of added on top. Default `false` (Phase 2's exclusive pricing, owner decision 2026-09-08);
 * - `shipping_taxable` — the delivery charge carries tax at the rate of the goods delivered (table provider:
 *   pro rata across the cart's rates; an empty cart's shipping at the store-wide rate). **Default: `true` for a
 *   store whose legal entity is in the EU, `false` elsewhere** (#352). An explicit `false` is a shipping-exempt
 *   store: the table provider taxes no shipping and Stripe Tax is not asked about it; an explicit `true` taxes it
 *   anywhere. When the setting is absent, Stripe Tax decides shipping tax itself (it knows the destination's rule).
 */
export interface TaxSettings {
  provider: TaxProviderName;
  pricesIncludeTax: boolean;
  /** Resolved: the store's explicit value, else the country default. */
  shippingTaxable: boolean;
  /** True when `shipping_taxable` was set on the store (vs the country default). */
  shippingTaxableExplicit: boolean;
}

/** The defaults for a store whose legal entity country is unknown (not EU). */
export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  provider: 'table',
  pricesIncludeTax: false,
  shippingTaxable: false,
  shippingTaxableExplicit: false,
};

export const TAX_SETTINGS_KEY = 'tax';

export interface TaxSettingsDefaults {
  /** The store's legal entity country (`legal_entity.country`); decides the `shipping_taxable` default. */
  legalEntityCountry?: string | null;
}

/**
 * Reads `store.settings.tax`. Unknown or malformed fields fall back to the defaults rather than throwing: a
 * store whose settings a human mistyped still prices with the table rates, tax-exclusive (same rule as the
 * shipping module's `carrierConfigFor`). `shipping_taxable` falls back to the legal entity's country rule.
 */
export function taxSettingsFrom(
  storeSettings: unknown,
  defaults: TaxSettingsDefaults = {},
): TaxSettings {
  const byCountry = defaultShippingTaxable(defaults.legalEntityCountry);
  const raw =
    storeSettings && typeof storeSettings === 'object'
      ? (storeSettings as Record<string, unknown>)[TAX_SETTINGS_KEY]
      : undefined;
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_TAX_SETTINGS, shippingTaxable: byCountry };
  }
  const t = raw as Record<string, unknown>;
  const explicit = typeof t.shipping_taxable === 'boolean';
  return {
    provider: t.provider === 'stripe' ? 'stripe' : 'table',
    pricesIncludeTax: t.prices_include_tax === true,
    shippingTaxable: explicit ? t.shipping_taxable === true : byCountry,
    shippingTaxableExplicit: explicit,
  };
}

/** A tax engine. `settings` are the store's, already resolved by the dispatching calculator. */
export interface TaxProvider {
  readonly name: TaxProviderName;
  calculate(ctx: TaxContext, settings: TaxSettings): Promise<TaxCalculation>;
}
