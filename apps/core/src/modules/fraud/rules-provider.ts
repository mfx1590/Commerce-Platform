// The local `rules` fraud provider (task 2.5, #128): offline, deterministic, per store.
//
//   - **Velocity per email hash**: the store already has `max_orders` or more orders for this email hash within
//     `window_minutes` → `review`. The comparison happens in SQL on a hash computed from the stored order email
//     (`sha256(lower(btrim(email)))`, the same function as the checkout's `emailHash`): the email itself is never
//     selected, returned, stored here or logged. The query runs on the placement transaction, so RLS keeps it
//     inside the cart's store — another brand's orders never count.
//   - **Mismatched countries**: shipping country ≠ billing country → `review` (or `allow` per store setting).
//
// Rules never `block`: a local heuristic holds an order for a human, it does not refuse a customer.
import {
  ALLOW,
  type FraudContext,
  type FraudDecision,
  type FraudProvider,
  type FraudSettings,
} from './types';

export async function ordersForEmailHash(
  ctx: Pick<FraudContext, 'tx' | 'storeId'>,
  emailHash: string,
  windowMinutes: number,
): Promise<number> {
  const r = await ctx.tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "order"
     WHERE store_id = $1
       AND placed_at > now() - make_interval(mins => $3)
       AND status <> 'cancelled'
       AND encode(sha256(convert_to(lower(btrim(email)), 'UTF8')), 'hex') = $2`,
    [ctx.storeId, emailHash, windowMinutes],
  );
  return Number(r.rows[0]!.n);
}

export const rulesFraudProvider: FraudProvider = {
  name: 'rules',
  async evaluate(ctx: FraudContext, settings: FraudSettings): Promise<FraudDecision> {
    if (ctx.emailHash) {
      const recent = await ordersForEmailHash(ctx, ctx.emailHash, settings.velocity.windowMinutes);
      if (recent >= settings.velocity.maxOrders) {
        return { outcome: 'review', reasonCode: 'velocity_email', provider: 'rules' };
      }
    }
    if (
      settings.countryMismatch === 'review' &&
      ctx.shippingCountry &&
      ctx.billingCountry &&
      ctx.shippingCountry.toUpperCase() !== ctx.billingCountry.toUpperCase()
    ) {
      return { outcome: 'review', reasonCode: 'country_mismatch', provider: 'rules' };
    }
    return ALLOW;
  },
};
