// Public API of the tax module (window 7, task 2.4, #127). Nothing outside this folder may import from its
// other files (ADR 0005).
import { setTaxCalculator, type TaxCalculator } from '../cart';
import { createTaxCalculator, type TaxCalculatorOptions } from './provider';

export {
  DEFAULT_TAX_SETTINGS,
  TAX_SETTINGS_KEY,
  taxSettingsFrom,
  type TaxContext,
  type TaxProvider,
  type TaxProviderName,
  type TaxSettings,
} from './types';
export { inclusiveTaxOn, tableTaxProvider, taxFor } from './table-provider';
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
 * exclusive prices, shipping untaxed) the result is identical to the built-in calculator, so registering it
 * changes nothing for a store until its `settings.tax` says so.
 */
export function registerTaxProvider(opts: TaxCalculatorOptions = {}): TaxCalculator {
  return setTaxCalculator(createTaxCalculator(opts));
}
