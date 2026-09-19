// Boot-time registrations that connect modules through their seams (the hq-rbac lesson: a module is not done
// until something calls it). createServer() runs registerModuleSeams() once, before Medusa loads. Every call here
// is a plain registry write: no I/O, no configuration read — credentials are resolved lazily per store on first
// use, so a store without them keeps the built-in behaviour (manual payments, table shipping rates, table tax).
import type { Queryable } from '@platform/db';
import { setPriceResolver, type PriceQuery, type PriceResolver } from './modules/cart';
import { registerPaymentProviders } from './modules/payments';
import { resolvePrices } from './modules/promotions';
import { registerCarrierProviders } from './modules/shipping';

async function customerGroupIds(tx: Queryable, customerId: string | null): Promise<string[]> {
  if (!customerId) return [];
  const r = await tx.query<{ customer_group_id: string | null }>(
    `SELECT customer_group_id FROM customer WHERE id = $1`,
    [customerId],
  );
  const group = r.rows[0]?.customer_group_id;
  return group ? [group] : [];
}

/**
 * The cart's PriceResolver backed by window 9's price lists (#179 part 3): sale > override/group > default,
 * priority, date windows at the mutation's clock, the cart's sales channel, the customer's group, quantity tiers.
 * `resolvePrices` takes one quantity per call, so lines are grouped by quantity (one statement per distinct one).
 */
export const priceListResolver: PriceResolver = {
  async resolve(q: PriceQuery): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const groups = await customerGroupIds(q.tx, q.customerId);
    const byQuantity = new Map<number, string[]>();
    for (const l of q.lines) {
      byQuantity.set(l.quantity, [...(byQuantity.get(l.quantity) ?? []), l.variantId]);
    }
    for (const [quantity, variantIds] of byQuantity) {
      const prices = await resolvePrices(q.tx, q.storeId, {
        variantIds,
        currency: q.currency,
        quantity,
        customerGroupIds: groups,
        salesChannelId: q.salesChannelId,
        at: q.at,
      });
      for (const [variantId, price] of prices) out.set(variantId, price.amount_minor);
    }
    return out;
  },
};

let registered = false;

/** Idempotent. Payments (#176 part 1), carrier rates (#176 part 3, window 8), price lists (#179 part 3). */
export function registerModuleSeams(): void {
  if (registered) return;
  registered = true;
  registerPaymentProviders(); // stripe next to manual + the payments RefundRequester for returns
  registerCarrierProviders(); // live carrier rates, falling back to the shipping_option table
  setPriceResolver(priceListResolver); // window 9's price lists behind the cart's unit prices
  // pending until src/modules/tax reaches main: registerTaxProvider() (#127 / #221)
}
