// Boot-time registrations that connect modules through their seams (the hq-rbac lesson: a module is not done
// until something calls it). createServer() runs registerModuleSeams() once, before Medusa loads. Every call here
// is a plain registry write: no I/O, no configuration read — credentials are resolved lazily per store on first
// use, so a store without them keeps the built-in behaviour (manual payments, table shipping rates, table tax).
import type { Queryable } from '@platform/db';
import {
  setDiscountEvaluator,
  setPriceResolver,
  taxOn,
  type DiscountEvaluator,
  type DiscountQuery,
  type DiscountQuote,
  type PriceQuery,
  type PriceResolver,
} from './modules/cart';
import { setFraudCheck } from './modules/checkout';
import { currentFraudCheck as fraudModuleCheck, registerFraudCheck } from './modules/fraud';
import { registerPaymentProviders } from './modules/payments';
import { evaluatePromotions, loadCandidatePromotions, resolvePrices } from './modules/promotions';
import { registerCarrierProviders } from './modules/shipping';
import { registerTaxProvider } from './modules/tax';

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

/** Reasons after which a code can never apply to this cart → the cart answers 400 when it is entered (#230). */
const PERMANENT_REJECTIONS = new Set([
  'not_found',
  'not_active',
  'not_started',
  'expired',
  'usage_limit_reached',
  'per_customer_limit_reached',
  'wrong_currency',
]);

/** What the engine needs to know about a signed-in customer; a guest has no identity: no first-order rule, no uses. */
async function customerPromotionFacts(
  tx: Queryable,
  customerId: string | null,
): Promise<{ isFirstOrder: boolean; customerUses: Record<string, number> }> {
  if (!customerId) return { isFirstOrder: false, customerUses: {} };
  const orders = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "order" WHERE customer_id = $1 AND status <> 'cancelled'`,
    [customerId],
  );
  // applied promotions are recorded on the order at placement (order.metadata.promotions, #230 PR B)
  const uses = await tx.query<{ promotion_id: string; n: string }>(
    `SELECT p->>'promotion_id' AS promotion_id, count(*)::text AS n
     FROM "order" o, jsonb_array_elements(coalesce(o.metadata->'promotions', '[]'::jsonb)) p
     WHERE o.customer_id = $1 AND o.status <> 'cancelled' GROUP BY 1`,
    [customerId],
  );
  return {
    isFirstOrder: Number(orders.rows[0]?.n ?? 0) === 0,
    customerUses: Object.fromEntries(uses.rows.map((r) => [r.promotion_id, Number(r.n)])),
  };
}

/**
 * The cart's DiscountEvaluator backed by window 9's promotions engine (#230 PR A): candidates = automatic
 * promotions + the cart's codes, judged at the mutation's clock.
 *
 * TAX-INCLUSIVE STORES (manager decision 2026-09-19 — window 9 changes nothing): the engine always receives
 * TAX-EXCLUSIVE unit prices. For a `pricesIncludeTax` store this adapter derives each line's net unit price through
 * the cart's own `taxOn` seam (`net = gross − taxOn(gross, bp, true)`), lets the engine evaluate and allocate
 * against that net base, and converts every line's allocation back to the cart's gross base
 * (`gross = net + taxOn(net, bp)`) — so a percentage takes the same percentage off what the customer sees, while
 * fixed amounts and `min_subtotal` thresholds of a promotion are NET figures in such a store.
 */
export const promotionsDiscountEvaluator: DiscountEvaluator = {
  async evaluate(q: DiscountQuery): Promise<DiscountQuote> {
    const empty: DiscountQuote = {
      allocations: new Map(),
      freeShipping: false,
      applied: [],
      rejected: [],
    };
    if (q.lines.length === 0 && q.codes.length === 0) return empty;
    const promotions = await loadCandidatePromotions(q.tx, q.storeId, q.codes);
    if (promotions.length === 0 && q.codes.length === 0) return empty;

    const bpOf = new Map(q.lines.map((l) => [l.lineItemId, l.taxRateBp]));
    const toNet = (gross: number, bp: number) =>
      q.pricesIncludeTax ? gross - taxOn(gross, bp, true) : gross;
    const toCartBase = (net: number, bp: number) =>
      q.pricesIncludeTax ? net + taxOn(net, bp) : net;
    const facts = await customerPromotionFacts(q.tx, q.customerId);
    const result = evaluatePromotions(
      q.lines.map((l) => ({
        id: l.lineItemId,
        product_id: l.productId,
        category_id: l.categoryId,
        quantity: l.quantity,
        unit_price_minor: toNet(l.unitPriceMinor, l.taxRateBp),
      })),
      promotions,
      {
        currency: q.currency,
        codes: q.codes,
        customerGroupIds: await customerGroupIds(q.tx, q.customerId),
        salesChannelId: q.salesChannelId,
        isFirstOrder: facts.isFirstOrder,
        customerUses: facts.customerUses,
        at: q.at,
      },
    );
    const inCartBase = (allocations: Record<string, number>) =>
      Object.entries(allocations).map(
        ([lineId, net]) => [lineId, toCartBase(net, bpOf.get(lineId) ?? 0)] as const,
      );
    return {
      allocations: new Map(inCartBase(result.allocations)),
      freeShipping: result.free_shipping,
      applied: result.applied.map((a) => ({
        promotionId: a.promotion_id,
        code: a.code,
        discountMinor: inCartBase(a.allocations).reduce((n, [, d]) => n + d, 0),
      })),
      rejected: result.rejected.map((r) => ({
        code: r.code,
        reason: r.reason,
        permanent: PERMANENT_REJECTIONS.has(r.reason),
      })),
    };
  },
};

let registered = false;

/** Idempotent. Payments (#176), carrier rates (window 8), tax (#127 / #221), fraud (#231), price lists (#179). */
export function registerModuleSeams(): void {
  if (registered) return;
  registered = true;
  registerPaymentProviders(); // stripe next to manual + the payments RefundRequester for returns
  registerCarrierProviders(); // live carrier rates, falling back to the shipping_option table
  setPriceResolver(priceListResolver); // window 9's price lists behind the cart's unit prices
  setDiscountEvaluator(promotionsDiscountEvaluator); // window 9's promotions engine behind the cart's discounts
  // window 7's tax calculator (table | Stripe Tax per store.settings.tax); with default settings it answers
  // exactly like the built-in table calculator, so nothing changes for a store until its settings say so
  registerTaxProvider();
  // window 7's fraud check (rules + Stripe Radar) and Radar's review.* webhook handlers (#231). Its
  // registerFraudCheck() still writes to the module's own stand-in registry (built before the checkout seam
  // existed), so the same check is handed to the checkout's seam here; once window 7 repoints its registration at
  // `setFraudCheck` from the checkout this second line is redundant and harmless.
  registerFraudCheck();
  setFraudCheck(fraudModuleCheck());
}
