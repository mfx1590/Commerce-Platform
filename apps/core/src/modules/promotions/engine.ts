// The promotion evaluation engine (task 2.5, #138) — pure: no database, no clock (the caller passes `at`).
// The cart (window 1) calls `evaluatePromotions` with its lines, the store's promotions and the customer
// context; the result carries the applied promotions, the per-line allocation (integer minor units summing
// EXACTLY to the discount), the free-shipping flag and the rejections with machine-readable reasons.
//
// Stacking (documented in #189): the best applicable EXCLUSIVE promotion wins over everything and applies
// alone. Otherwise the engine compares the best applicable non-stackable alone against all applicable
// stackables combined and takes the greater total discount (tie: the stackable set). Every promotion's
// discount is computed on the undiscounted eligible subtotal, then applied against a per-LINE budget: a line
// absorbs at most its own subtotal across all promotions together, overflow spills to the promotion's other
// eligible lines, and what does not fit is dropped from that promotion's discount. The cart-level bound is a
// consequence of that, not a separate rule.
import type { Promotion, PromotionRules } from './promotions-types';

export interface CartLineInput {
  /** Caller's line id (cart_line_item.id); allocations are keyed by it. */
  id: string;
  product_id: string;
  category_id?: string | null;
  quantity: number;
  /** Tax-exclusive unit price in minor units (the resolved price). */
  unit_price_minor: number;
}

export interface EvaluationContext {
  currency: string;
  /** Coupon codes the customer entered (compared upper-case). */
  codes?: string[];
  customerGroupIds?: string[];
  salesChannelId?: string | null;
  /** True when the customer has no prior order (rules.first_order_only). */
  isFirstOrder?: boolean;
  /** Prior uses of each promotion by THIS customer (per_customer_limit); missing = 0. */
  customerUses?: Record<string, number>;
  /**
   * Evaluation instant — REQUIRED. The cart passes its own transaction time so a quote and the placement that
   * follows judge every window with the same clock; defaulting to `new Date()` here made two calls a
   * millisecond apart able to disagree about an expiring promotion (post-merge review of #188).
   */
  at: Date;
}

export type RejectReason =
  | 'not_found'
  | 'not_active'
  | 'not_started'
  | 'expired'
  | 'usage_limit_reached'
  | 'per_customer_limit_reached'
  | 'min_subtotal_not_met'
  | 'no_eligible_lines'
  | 'wrong_currency'
  | 'customer_group_required'
  | 'sales_channel_mismatch'
  | 'first_order_only'
  | 'not_stacked';

export interface AppliedPromotion {
  promotion_id: string;
  code: string | null;
  type: Promotion['type'];
  discount_minor: number;
  free_shipping: boolean;
  /** line id → discount share; the values sum exactly to discount_minor. */
  allocations: Record<string, number>;
}

export interface RejectedPromotion {
  promotion_id: string | null;
  code: string | null;
  reason: RejectReason;
}

export interface EvaluationResult {
  applied: AppliedPromotion[];
  rejected: RejectedPromotion[];
  discount_minor: number;
  free_shipping: boolean;
  /** line id → total discount over all applied promotions. */
  allocations: Record<string, number>;
}

const lineSubtotal = (l: CartLineInput): number => l.unit_price_minor * l.quantity;

/** Lines the promotion's product/category rules select; both lists empty = the whole cart. */
export function eligibleLines(lines: CartLineInput[], rules: PromotionRules): CartLineInput[] {
  const products = new Set(rules.product_ids ?? []);
  const categories = new Set(rules.category_ids ?? []);
  if (products.size === 0 && categories.size === 0) return lines;
  return lines.filter(
    (l) => products.has(l.product_id) || (l.category_id != null && categories.has(l.category_id)),
  );
}

/**
 * Splits `total` across lines proportionally to their subtotal using the largest-remainder method, so the
 * integer parts always sum exactly to `total` (the rounding test of #138). Zero-subtotal lines get nothing.
 */
export function allocateAcrossLines(total: number, lines: CartLineInput[]): Record<string, number> {
  const out: Record<string, number> = {};
  const base = lines.reduce((n, l) => n + lineSubtotal(l), 0);
  if (total <= 0 || base <= 0) {
    for (const l of lines) out[l.id] = 0;
    return out;
  }
  const shares = lines.map((l) => {
    const exact = (total * lineSubtotal(l)) / base;
    const floor = Math.floor(exact);
    return { id: l.id, floor, remainder: exact - floor };
  });
  let assigned = shares.reduce((n, s) => n + s.floor, 0);
  shares.sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id));
  for (const s of shares) {
    out[s.id] = s.floor + (assigned < total ? 1 : 0);
    if (assigned < total) assigned++;
  }
  return out;
}

/**
 * Fits one promotion's proposed per-line allocation into what is left of each line's budget: every line is
 * clamped to its remaining room and the overflow spills across the promotion's other eligible lines that still
 * have some (proportionally, largest remainder). Returns only what actually fits, so the caller's discount is
 * exactly the sum of the result. Pure; `budget` is read, never mutated.
 */
function fitToBudget(
  proposed: Record<string, number>,
  eligible: CartLineInput[],
  budget: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const room = (id: string) => Math.max(0, (budget[id] ?? 0) - (out[id] ?? 0));
  let overflow = 0;
  for (const [id, want] of Object.entries(proposed)) {
    const give = Math.min(want, room(id));
    if (give > 0) out[id] = give;
    overflow += want - give;
  }
  while (overflow > 0) {
    const spillable = eligible.filter((l) => room(l.id) > 0);
    if (spillable.length === 0) break;
    const share = allocateAcrossLines(overflow, spillable);
    let spilled = 0;
    for (const l of spillable) {
      const want = share[l.id] ?? 0;
      const give = Math.min(want, room(l.id));
      if (give > 0) out[l.id] = (out[l.id] ?? 0) + give;
      spilled += want - give;
    }
    if (spilled >= overflow) break; // nothing moved this pass — stop rather than spin
    overflow = spilled;
  }
  return out;
}

interface Candidate {
  promotion: Promotion;
  discount: number;
  freeShipping: boolean;
  allocations: Record<string, number>;
}

/** The discount one promotion yields on its eligible lines (0 = applicable but worthless, still applied). */
function computeDiscount(
  p: Promotion,
  eligible: CartLineInput[],
  currency: string,
): { discount: number; freeShipping: boolean; allocations: Record<string, number> } {
  const subtotal = eligible.reduce((n, l) => n + lineSubtotal(l), 0);
  switch (p.type) {
    case 'percentage': {
      const discount = Math.min(subtotal, Math.floor((subtotal * p.value) / 10000));
      return {
        discount,
        freeShipping: false,
        allocations: allocateAcrossLines(discount, eligible),
      };
    }
    case 'fixed_amount': {
      if ((p.currency ?? '').trim().toUpperCase() !== currency)
        return { discount: 0, freeShipping: false, allocations: {} };
      const discount = Math.min(subtotal, p.value);
      return {
        discount,
        freeShipping: false,
        allocations: allocateAcrossLines(discount, eligible),
      };
    }
    case 'free_shipping':
      return { discount: 0, freeShipping: true, allocations: {} };
    case 'buy_x_get_y': {
      const buy = p.rules.buy_quantity ?? 1;
      const get = p.rules.get_quantity ?? 1;
      const bp = p.rules.get_discount_bp ?? 10000;
      const totalQty = eligible.reduce((n, l) => n + l.quantity, 0);
      const freeUnits = Math.floor(totalQty / (buy + get)) * get;
      if (freeUnits <= 0) return { discount: 0, freeShipping: false, allocations: {} };
      // the cheapest units are the discounted ones (customer-friendly and deterministic)
      const units: { id: string; price: number }[] = [];
      for (const l of eligible)
        for (let i = 0; i < l.quantity; i++) units.push({ id: l.id, price: l.unit_price_minor });
      units.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
      const allocations: Record<string, number> = {};
      let discount = 0;
      for (const u of units.slice(0, freeUnits)) {
        const off = Math.floor((u.price * bp) / 10000);
        allocations[u.id] = (allocations[u.id] ?? 0) + off;
        discount += off;
      }
      return { discount, freeShipping: false, allocations };
    }
  }
}

function applicability(
  p: Promotion,
  lines: CartLineInput[],
  ctx: EvaluationContext,
  at: Date,
): { ok: true; eligible: CartLineInput[] } | { ok: false; reason: RejectReason } {
  if (p.status !== 'active') return { ok: false, reason: 'not_active' };
  if (p.starts_at && new Date(p.starts_at) > at) return { ok: false, reason: 'not_started' };
  if (p.ends_at && new Date(p.ends_at) <= at) return { ok: false, reason: 'expired' };
  if (p.usage_limit !== null && p.usage_count >= p.usage_limit)
    return { ok: false, reason: 'usage_limit_reached' };
  if (p.per_customer_limit !== null && (ctx.customerUses?.[p.id] ?? 0) >= p.per_customer_limit)
    return { ok: false, reason: 'per_customer_limit_reached' };
  const r = p.rules;
  if (r.customer_group_ids?.length) {
    const groups = ctx.customerGroupIds ?? [];
    if (!r.customer_group_ids.some((g) => groups.includes(g)))
      return { ok: false, reason: 'customer_group_required' };
  }
  if (r.sales_channel_ids?.length) {
    if (!ctx.salesChannelId || !r.sales_channel_ids.includes(ctx.salesChannelId))
      return { ok: false, reason: 'sales_channel_mismatch' };
  }
  if (r.first_order_only && !ctx.isFirstOrder) return { ok: false, reason: 'first_order_only' };
  if (
    p.type === 'fixed_amount' &&
    (p.currency ?? '').trim().toUpperCase() !== ctx.currency.trim().toUpperCase()
  )
    return { ok: false, reason: 'wrong_currency' };
  const cartSubtotal = lines.reduce((n, l) => n + lineSubtotal(l), 0);
  if (r.min_subtotal_minor !== undefined && cartSubtotal < r.min_subtotal_minor)
    return { ok: false, reason: 'min_subtotal_not_met' };
  const eligible = eligibleLines(lines, r);
  if (eligible.length === 0) return { ok: false, reason: 'no_eligible_lines' };
  return { ok: true, eligible };
}

const value = (c: Candidate): number => c.discount + (c.freeShipping ? 1 : 0); // free shipping breaks 0-ties

/**
 * Evaluates the store's promotions against the cart. `promotions` = every candidate the caller loaded
 * (automatic ones plus the ones matching entered codes); a code in `ctx.codes` with no matching promotion is
 * rejected as `not_found`. See the module README for the stacking semantics.
 */
export function evaluatePromotions(
  lines: CartLineInput[],
  promotions: Promotion[],
  ctx: EvaluationContext,
): EvaluationResult {
  const at = ctx.at;
  const currency = ctx.currency.trim().toUpperCase();
  const codes = new Set((ctx.codes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean));
  const rejected: RejectedPromotion[] = [];

  const considered = promotions.filter((p) => p.code === null || codes.has(p.code));
  for (const code of codes) {
    if (!promotions.some((p) => p.code === code))
      rejected.push({ promotion_id: null, code, reason: 'not_found' });
  }

  const candidates: Candidate[] = [];
  for (const p of considered) {
    const a = applicability(p, lines, ctx, at);
    if (!a.ok) {
      rejected.push({ promotion_id: p.id, code: p.code, reason: a.reason });
      continue;
    }
    candidates.push({ promotion: p, ...computeDiscount(p, a.eligible, currency) });
  }

  // stacking resolution
  let chosen: Candidate[];
  const exclusives = candidates.filter((c) => c.promotion.exclusive);
  if (exclusives.length > 0) {
    exclusives.sort((a, b) => value(b) - value(a) || a.promotion.id.localeCompare(b.promotion.id));
    chosen = [exclusives[0]!];
    for (const c of candidates)
      if (c !== chosen[0])
        rejected.push({
          promotion_id: c.promotion.id,
          code: c.promotion.code,
          reason: 'not_stacked',
        });
  } else {
    const stackables = candidates.filter((c) => c.promotion.stackable);
    const nonStackables = candidates.filter((c) => !c.promotion.stackable);
    nonStackables.sort(
      (a, b) => value(b) - value(a) || a.promotion.id.localeCompare(b.promotion.id),
    );
    const stackValue = stackables.reduce((n, c) => n + value(c), 0);
    const bestSingle = nonStackables[0];
    if (bestSingle && value(bestSingle) > stackValue) {
      chosen = [bestSingle];
      for (const c of candidates)
        if (c !== bestSingle)
          rejected.push({
            promotion_id: c.promotion.id,
            code: c.promotion.code,
            reason: 'not_stacked',
          });
    } else {
      chosen = stackables;
      for (const c of nonStackables)
        rejected.push({
          promotion_id: c.promotion.id,
          code: c.promotion.code,
          reason: 'not_stacked',
        });
    }
  }

  // Apply in value order against a per-LINE budget. Each line can absorb at most its own subtotal across all
  // promotions together; a promotion that overshoots a line spills the remainder onto its other eligible lines
  // and, when none has room left, keeps only what fit. The cart-level bound falls out of this (the line
  // budgets sum to the cart subtotal) and the invariant the cart needs holds: no line is ever discounted below
  // zero. A cart-level cap alone did not give that — two overlapping stackables could both spend the same
  // line's value (post-merge review of #188).
  chosen.sort((a, b) => value(b) - value(a) || a.promotion.id.localeCompare(b.promotion.id));
  const budget: Record<string, number> = {};
  for (const l of lines) budget[l.id] = lineSubtotal(l);
  const applied: AppliedPromotion[] = [];
  const totalAllocations: Record<string, number> = {};
  for (const l of lines) totalAllocations[l.id] = 0;
  for (const c of chosen) {
    const allocations = fitToBudget(c.allocations, eligibleLines(lines, c.promotion.rules), budget);
    let discount = 0;
    for (const [id, v] of Object.entries(allocations)) {
      discount += v;
      budget[id] = (budget[id] ?? 0) - v;
      totalAllocations[id] = (totalAllocations[id] ?? 0) + v;
    }
    applied.push({
      promotion_id: c.promotion.id,
      code: c.promotion.code,
      type: c.promotion.type,
      discount_minor: discount,
      free_shipping: c.freeShipping,
      allocations,
    });
  }
  return {
    applied,
    rejected,
    discount_minor: applied.reduce((n, a) => n + a.discount_minor, 0),
    free_shipping: applied.some((a) => a.free_shipping),
    allocations: totalAllocations,
  };
}
