// Public API of the tax module (window 7, task 2.4, #127). Nothing outside this folder may import from its
// other files (ADR 0005).
import { setTaxCalculator, type TaxCalculator } from '../cart';
import { createTaxCalculator, type TaxCalculatorOptions } from './provider';

export {
  DEFAULT_TAX_SETTINGS,
  defaultShippingTaxable,
  EU_COUNTRIES,
  TAX_SETTINGS_KEY,
  taxSettingsFrom,
  type TaxContext,
  type TaxSettingsDefaults,
  type TaxProvider,
  type TaxProviderName,
  type TaxSettings,
} from './types';
export {
  allocateProRata,
  shippingTaxAtGoodsRate,
  tableTaxProvider,
  taxFor,
} from './table-provider';
export {
  createStripeTaxProvider,
  rateBpOf,
  type StripeTaxProviderOptions,
} from './stripe-provider';
export {
  createTaxCalculator,
  TAX_FALLBACK_FLAG,
  taxFallbackEnabled,
  type TaxCalculatorOptions,
} from './provider';

/**
 * Registers this module's calculator with the cart module (`setTaxCalculator`), replacing the built-in table
 * calculator; returns the previous one. Called once at boot by src/server.ts, next to
 * `registerPaymentProviders()` (REQUEST #176 part 5). With default store settings (`provider: table`,
 * exclusive prices) the per-line result is identical to the built-in calculator; the one platform default this
 * module adds is delivery VAT for EU stores (#352: shipping taxed at the goods' rate unless
 * `settings.tax.shipping_taxable` is `false`).
 */
export function registerTaxProvider(opts: TaxCalculatorOptions = {}): TaxCalculator {
  return setTaxCalculator(createTaxCalculator(opts));
}
