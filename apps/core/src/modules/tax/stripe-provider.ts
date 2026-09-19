// The `stripe` tax provider (task 2.4, #127): Stripe Tax, test mode, through the payments module's fetch-based
// client and the SAME per-store credentials (`STRIPE_SECRET_KEY_<CODE>`, ADR 0006). One `POST
// /v1/tax/calculations` per pricing pass: line amounts (quantity × unit − discount), our line ids as references,
// the shipping price, the destination address, and the store's pricing mode as `tax_behavior`. What leaves the
// process: amounts, ids, currency and the destination (country, postal code, region, city) — never a name, an
// email, a street line or a phone number. Nothing here logs.
//
// Results are Stripe's integer minor units, used as they are (Stripe rounds per line; we never re-round).
// `taxRateBp` — persisted on cart/order lines — is the sum of the line's `tax_breakdown` percentages × 100,
// rounded to a basis point; without a breakdown it is derived from the amounts.
import type { Queryable } from '@platform/db';
import type { TaxCalculation } from '../cart';
import {
  StripeClient,
  StripeError,
  stripeCredentialsFor,
  type StripeApi,
  type StripeCredentials,
  type StripeTaxLineItem,
} from '../payments';
import { validationError } from '../../lib/errors';
import type { TaxContext, TaxProvider, TaxSettings } from './types';

export interface StripeTaxProviderOptions {
  /** Injectable for tests; default a real StripeClient per credential set. */
  apiFactory?: (credentials: StripeCredentials) => StripeApi;
  env?: NodeJS.ProcessEnv;
}

async function storeCodeFor(tx: Queryable, storeId: string): Promise<string> {
  const r = await tx.query<{ code: string }>(`SELECT code FROM store WHERE id = $1`, [storeId]);
  const code = r.rows[0]?.code;
  if (!code) throw new Error(`store ${storeId} not found while resolving stripe tax credentials`);
  return code;
}

/** Basis points of a Stripe Tax line: Σ breakdown percentages, else derived from the amounts. */
export function rateBpOf(line: StripeTaxLineItem): number {
  const parts = line.tax_breakdown ?? [];
  const fromBreakdown = parts.reduce((sum, p) => {
    const pct = Number(p.tax_rate_details?.percentage_decimal ?? NaN);
    return Number.isFinite(pct) ? sum + pct : sum;
  }, 0);
  if (fromBreakdown > 0) return Math.round(fromBreakdown * 100);
  const net = line.tax_behavior === 'inclusive' ? line.amount - line.amount_tax : line.amount;
  return net > 0 && line.amount_tax > 0 ? Math.round((line.amount_tax * 10000) / net) : 0;
}

export function createStripeTaxProvider(opts: StripeTaxProviderOptions = {}): TaxProvider {
  return {
    name: 'stripe',
    async calculate(ctx: TaxContext, settings: TaxSettings): Promise<TaxCalculation> {
      const taxable = ctx.lines
        .map((l) => ({ id: l.lineItemId, amount: l.quantity * l.unitPriceMinor - l.discountMinor }))
        .filter((l) => l.amount > 0);
      if (taxable.length === 0 && ctx.shippingMinor <= 0) {
        return {
          lines: ctx.lines.map((l) => ({ lineItemId: l.lineItemId, taxRateBp: 0, taxMinor: 0 })),
          shippingTaxMinor: 0,
        };
      }
      const code = await storeCodeFor(ctx.tx, ctx.storeId);
      let credentials: StripeCredentials;
      try {
        credentials = stripeCredentialsFor(code, opts.env ?? process.env);
      } catch (err) {
        // Fail closed with the variable names (never values): the store asked for Stripe Tax and has no key.
        throw validationError((err as Error).message, { provider: 'stripe', feature: 'tax' });
      }
      const api = opts.apiFactory
        ? opts.apiFactory(credentials)
        : new StripeClient({ secretKey: credentials.secretKey });

      const behavior = settings.pricesIncludeTax ? 'inclusive' : 'exclusive';
      const a = ctx.shippingAddress;
      const address: Record<string, string> = { country: ctx.country };
      if (a?.postal_code) address.postal_code = a.postal_code;
      if (a?.region) address.state = a.region;
      if (a?.city) address.city = a.city;

      let calculation;
      try {
        calculation = await api.createTaxCalculation(
          {
            currency: ctx.currency.toLowerCase(),
            line_items: taxable.map((l) => ({
              amount: l.amount,
              reference: l.id,
              tax_behavior: behavior,
            })),
            ...(ctx.shippingMinor > 0
              ? { shipping_cost: { amount: ctx.shippingMinor, tax_behavior: behavior } }
              : {}),
            customer_details: { address, address_source: 'shipping' },
          },
          { expand: ['line_items'] },
        );
      } catch (err) {
        // A definitive refusal (an address Stripe cannot locate, an unsupported currency) is the caller's 400;
        // outages are rethrown as they are — the dispatcher decides about the opt-in fallback.
        if (err instanceof StripeError && err.definitive) {
          throw validationError(`stripe tax refused the calculation: ${err.code ?? err.message}`, {
            provider: 'stripe',
            feature: 'tax',
            code: err.code,
          });
        }
        throw err;
      }

      const byReference = new Map(
        (calculation.line_items?.data ?? []).map((l) => [l.reference, l]),
      );
      return {
        lines: ctx.lines.map((l) => {
          const s = byReference.get(l.lineItemId);
          return s
            ? { lineItemId: l.lineItemId, taxRateBp: rateBpOf(s), taxMinor: s.amount_tax }
            : { lineItemId: l.lineItemId, taxRateBp: 0, taxMinor: 0 };
        }),
        shippingTaxMinor: calculation.shipping_cost?.amount_tax ?? 0,
      };
    },
  };
}
