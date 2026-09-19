// The ONE cart `TaxCalculator` this module registers (task 2.4, #127). Per pricing pass it reads the store's
// `settings.tax` through the mutation's transaction (RLS keeps it inside the cart's store) and dispatches to the
// `table` or `stripe` provider. Stripe Tax outages FAIL CLOSED: the cart mutation fails retryably rather than
// pricing an order with a guessed tax. The only exception is an explicit, non-production opt-in,
// `CORE_TAX_FALLBACK_TO_TABLE=1` — same pattern as `CORE_DEV_TOKENS` / `CORE_STORE_API_FALLBACK`: refused
// unconditionally in production, before the flag's value is even considered.
import type { TaxCalculation, TaxCalculator } from '../cart';
import { AppError } from '../../lib/errors';
import { createStripeTaxProvider, type StripeTaxProviderOptions } from './stripe-provider';
import { tableTaxProvider } from './table-provider';
import { taxSettingsFrom, type TaxContext, type TaxProvider, type TaxSettings } from './types';

export const TAX_FALLBACK_FLAG = 'CORE_TAX_FALLBACK_TO_TABLE';

export interface TaxCalculatorOptions extends StripeTaxProviderOptions {
  /** One line when the opt-in fallback is used (store id and reason only). Default `console.warn`. */
  log?: (line: string) => void;
}

/**
 * Is the table fallback allowed? Production refuses the flag outright (a production environment that carries
 * it refuses to price instead of silently falling back); elsewhere only the exact value `1` enables it.
 */
export function taxFallbackEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const flag = env[TAX_FALLBACK_FLAG]?.trim();
  if (env.NODE_ENV === 'production') {
    if (flag) throw new Error(`${TAX_FALLBACK_FLAG} must not be set in production`);
    return false;
  }
  return flag === '1';
}

async function settingsFor(ctx: TaxContext): Promise<TaxSettings> {
  const r = await ctx.tx.query<{ settings: unknown }>(`SELECT settings FROM store WHERE id = $1`, [
    ctx.storeId,
  ]);
  return taxSettingsFrom(r.rows[0]?.settings);
}

export function createTaxCalculator(opts: TaxCalculatorOptions = {}): TaxCalculator {
  const env = opts.env ?? process.env;
  taxFallbackEnabled(env); // a production environment carrying the flag refuses at registration (boot)
  const stripe = createStripeTaxProvider(opts);
  const providers: Record<TaxProvider['name'], TaxProvider> = { table: tableTaxProvider, stripe };
  const log = opts.log ?? ((line: string) => console.warn(line));

  return {
    async calculate(ctx: TaxContext): Promise<TaxCalculation> {
      const settings = await settingsFor(ctx);
      const provider = providers[settings.provider];
      try {
        return await provider.calculate(ctx, settings);
      } catch (err) {
        // AppErrors are decisions (no key → 400, Stripe refused the address → 400): never a fallback case.
        if (err instanceof AppError || provider.name === 'table') throw err;
        if (!taxFallbackEnabled(env)) throw err; // fail closed: outage → the mutation fails, the client retries
        log(
          `[tax] stripe tax unavailable for store ${ctx.storeId}; ${TAX_FALLBACK_FLAG}=1 → table rates (non-production opt-in)`,
        );
        return tableTaxProvider.calculate(ctx, settings);
      }
    },
  };
}
