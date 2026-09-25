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
import { registerFraudCheck } from './modules/fraud';
import { registerPaymentProviders } from './modules/payments';
import {
  eligibleLines,
  evaluatePromotions,
  loadCandidatePromotions,
  recordPromotionUse,
  resolvePrices,
} from './modules/promotions';
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

/**
 * Reasons after which a code can never apply to this cart → the cart answers 400 when it is entered (#230).
 * `wrong_currency`: a cart's currency is fixed at creation. `per_customer_limit_reached` / `usage_limit_reached`:
 * exhaustion does not heal. NOT here: `not_started` — time, not the cart, makes it applicable, so a launch code
 * entered at 23:59 stays stored and applies once active (manager ruling on #243).
 */
const PERMANENT_REJECTIONS = new Set([
  'not_found',
  'not_active',
  'expired',
  'usage_limit_reached',
  'per_customer_limit_reached',
  'wrong_currency',
]);

/**
 * "Orders that count" for a customer's first-order state and per-customer uses (ruling in #230 PR B): not
 * cancelled, PAID FOR — the payment is at least authorised (`pending` / `failed` = unpaid) — and not held or
 * condemned by a fraud review. An unpaid or suspicious order must not cost an honest customer their welcome code,
 * and a fraudster's held orders must not be what "uses up" a limit.
 */
const ORDER_COUNTS = `o.status <> 'cancelled'
  AND o.payment_status NOT IN ('pending', 'failed')
  AND coalesce(o.metadata->'fraud'->>'status', 'cleared') NOT IN ('review', 'confirmed_fraud')`;

/** What the engine needs to know about a signed-in customer; a guest has no identity: no first-order rule, no uses. */
async function customerPromotionFacts(
  tx: Queryable,
  customerId: string | null,
): Promise<{ isFirstOrder: boolean; customerUses: Record<string, number> }> {
  if (!customerId) return { isFirstOrder: false, customerUses: {} };
  const orders = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "order" o WHERE o.customer_id = $1 AND ${ORDER_COUNTS}`,
    [customerId],
  );
  // applied promotions are recorded on the order at placement (order.metadata.promotions, #230 PR B)
  const uses = await tx.query<{ promotion_id: string; n: string }>(
    `SELECT p->>'promotion_id' AS promotion_id, count(*)::text AS n
     FROM "order" o, jsonb_array_elements(coalesce(o.metadata->'promotions', '[]'::jsonb)) p
     WHERE o.customer_id = $1 AND ${ORDER_COUNTS} GROUP BY 1`,
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
 * TAX-INCLUSIVE STORES (manager decision 4 of 2026-09-19 + ruling on #243 — window 9 changes nothing): the engine
 * always works in TAX-EXCLUSIVE money; everything a merchant configures and a customer sees in such a store is
 * GROSS. This adapter converts both ways through the cart's own `taxOn` seam:
 * - unit prices: `net = gross − taxOn(gross, bp, true)` per line;
 * - a `fixed_amount` value: gross → net at the blended rate of the promotion's eligible lines, and after the
 *   evaluation its per-line allocations are brought back so that they sum to EXACTLY
 *   `min(configured gross amount, eligible lines' displayed subtotal)` — each share clamped to its line's displayed
 *   subtotal, the rounding drift spread only over eligible lines with headroom ("5.00 off" drops the displayed
 *   total by exactly 5.00, a coupon larger than the eligible lines takes exactly those lines to zero);
 * - a `min_subtotal_minor` threshold is compared here against the DISPLAYED (gross) cart subtotal — the engine
 *   only receives the outcome (threshold 0 when met, an unreachable one when not);
 * - every other allocation (percentages, buy-x-get-y): `gross = net + taxOn(net, bp)` per line, so a percentage
 *   is the same percentage of what the customer sees.
 * In a tax-exclusive store nothing is converted.
 */
export const promotionsDiscountEvaluator: DiscountEvaluator = {
  /** One use per applied promotion, inside the placement transaction; 409 `conflict` past the usage limit. */
  recordUse: (tx, storeId, promotionId) => recordPromotionUse(tx, storeId, promotionId),

  async evaluate(q: DiscountQuery): Promise<DiscountQuote> {
    const empty: DiscountQuote = {
      allocations: new Map(),
      freeShipping: false,
      applied: [],
      rejected: [],
    };
    if (q.lines.length === 0 && q.codes.length === 0) return empty;
    const stored = await loadCandidatePromotions(q.tx, q.storeId, q.codes);
    if (stored.length === 0 && q.codes.length === 0) return empty;

    const inclusive = q.pricesIncludeTax;
    const bpOf = new Map(q.lines.map((l) => [l.lineItemId, l.taxRateBp]));
    const grossOf = new Map(q.lines.map((l) => [l.lineItemId, l.quantity * l.unitPriceMinor]));
    const toNet = (gross: number, bp: number) =>
      inclusive ? gross - taxOn(gross, bp, true) : gross;
    const toCartBase = (net: number, bp: number) => (inclusive ? net + taxOn(net, bp) : net);
    const engineLines = q.lines.map((l) => ({
      id: l.lineItemId,
      product_id: l.productId,
      category_id: l.categoryId,
      quantity: l.quantity,
      unit_price_minor: toNet(l.unitPriceMinor, l.taxRateBp),
    }));
    const netCartSubtotal = engineLines.reduce((n, l) => n + l.quantity * l.unit_price_minor, 0);
    const grossCartSubtotal = q.lines.reduce((n, l) => n + l.quantity * l.unitPriceMinor, 0);
    const grossEligible = (p: (typeof stored)[number]) =>
      eligibleLines(engineLines, p.rules).reduce((n, l) => n + (grossOf.get(l.id) ?? 0), 0);

    // what the engine sees of each promotion: its GROSS figures brought into the engine's net money
    const promotions = !inclusive
      ? stored
      : stored.map((p) => {
          const rules = { ...p.rules };
          if (rules.min_subtotal_minor !== undefined) {
            rules.min_subtotal_minor =
              grossCartSubtotal >= rules.min_subtotal_minor ? 0 : netCartSubtotal + 1;
          }
          if (p.type !== 'fixed_amount') return { ...p, rules };
          const eligible = eligibleLines(engineLines, p.rules);
          const net = eligible.reduce((n, l) => n + l.quantity * l.unit_price_minor, 0);
          const gross = grossEligible(p);
          const value = gross > 0 ? mulDivRound(p.value, net, gross) : p.value;
          return { ...p, rules, value };
        });

    const facts = await customerPromotionFacts(q.tx, q.customerId);
    const result = evaluatePromotions(engineLines, promotions, {
      currency: q.currency,
      codes: q.codes,
      customerGroupIds: await customerGroupIds(q.tx, q.customerId),
      salesChannelId: q.salesChannelId,
      isFirstOrder: facts.isFirstOrder,
      customerUses: facts.customerUses,
      at: q.at,
    });

    const configured = new Map(stored.map((p) => [p.id, p]));
    const allocations = new Map<string, number>();
    const applied = result.applied.map((a) => {
      const p = configured.get(a.promotion_id);
      // A net → gross round trip can overshoot a small line (gross 3 at 19 %: net 3, back to gross 4), so every
      // converted share is clamped to its line's DISPLAYED subtotal — the cart would clamp it anyway, silently.
      const share = new Map<string, number>();
      // STACKING RULE (#230 PR B): promotions are taken in the engine's order, and each one only gets what the
      // promotions before it left on a line — a line's combined discount never exceeds its displayed subtotal,
      // and nothing is shaved silently later by the cart's own clamp.
      const headroom = (lineId: string) =>
        (grossOf.get(lineId) ?? 0) - (allocations.get(lineId) ?? 0);
      for (const [lineId, net] of Object.entries(a.allocations)) {
        share.set(
          lineId,
          Math.max(0, Math.min(headroom(lineId), toCartBase(net, bpOf.get(lineId) ?? 0))),
        );
      }
      if (inclusive && p?.type === 'fixed_amount') {
        // Exactly min(configured amount, eligible lines' displayed subtotal): the rounding drift is spread one
        // line at a time over the promotion's ELIGIBLE lines that still have headroom (up) or a share (down),
        // largest room first, until the target is met or every line is saturated — and when all are saturated the
        // target IS the eligible subtotal (the cap case), so the sum is exact there too (#243 re-review).
        const lineIds = eligibleLines(engineLines, p.rules).map((l) => l.id);
        // …of what is LEFT on its eligible lines: a second stacked fixed amount takes exactly the remainder
        const target = Math.min(
          p.value,
          lineIds.reduce((n, id) => n + headroom(id), 0),
        );
        let drift = target - [...share.values()].reduce((n, d) => n + d, 0);
        while (drift !== 0) {
          const room = (id: string) =>
            drift > 0 ? headroom(id) - (share.get(id) ?? 0) : (share.get(id) ?? 0);
          const id = lineIds.filter((x) => room(x) > 0).sort((x, y) => room(y) - room(x))[0];
          if (id === undefined) break; // every line saturated
          const step = Math.sign(drift) * Math.min(Math.abs(drift), room(id));
          share.set(id, (share.get(id) ?? 0) + step);
          drift -= step;
        }
      }
      let discountMinor = 0;
      for (const [lineId, d] of share) {
        if (d === 0) continue;
        allocations.set(lineId, (allocations.get(lineId) ?? 0) + d);
        discountMinor += d;
      }
      return { promotionId: a.promotion_id, code: a.code, discountMinor };
    });
    return {
      allocations,
      freeShipping: result.free_shipping,
      applied,
      rejected: result.rejected.map((r) => ({
        code: r.code,
        reason: r.reason,
        permanent: PERMANENT_REJECTIONS.has(r.reason),
      })),
    };
  },
};

/** `round(a × b / c)` for non-negative integers without leaving the safe-integer range (a × b can exceed 2^53). */
export function mulDivRound(a: number, b: number, c: number): number {
  const [x, y, z] = [BigInt(Math.trunc(a)), BigInt(Math.trunc(b)), BigInt(Math.trunc(c))];
  return Number((x * y * BigInt(2) + z) / (z * BigInt(2)));
}

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
  // window 7's fraud check (rules + Stripe Radar) and Radar's review.* webhook handlers (#231). It registers
  // with the checkout's real seam itself. Blocks are still recorded by the module's own deferred flush (the
  // approved interim): the checkout's post-rollback hook (#241) takes over the day the check sets
  // `recordsBlockedAfterRollback` — no change needed here then.
  registerFraudCheck();
}
