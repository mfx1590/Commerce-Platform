// Pure engine matrix (task 2.5, #138): stacking allowed/denied, exclusive wins, usage/per-customer limits,
// expired code, condition gates, buy-X-get-Y, and the integer allocation summing exactly to the discount.
import { describe, expect, it } from 'vitest';
import {
  allocateAcrossLines,
  evaluatePromotions,
  type CartLineInput,
  type EvaluationContext,
} from './index';
import type { Promotion } from './promotions-types';

const lines: CartLineInput[] = [
  { id: 'l1', product_id: 'p1', category_id: 'c1', quantity: 1, unit_price_minor: 1000 },
  { id: 'l2', product_id: 'p2', category_id: 'c1', quantity: 2, unit_price_minor: 500 },
  { id: 'l3', product_id: 'p3', category_id: 'c2', quantity: 1, unit_price_minor: 3000 },
]; // subtotal 5000

let seq = 0;
function promo(over: Partial<Promotion>): Promotion {
  seq += 1;
  return {
    id: `50000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    code: null,
    name: 'p',
    type: 'percentage',
    value: 1000, // 10%
    currency: null,
    rules: {},
    usage_limit: null,
    usage_count: 0,
    per_customer_limit: null,
    starts_at: null,
    ends_at: null,
    status: 'active',
    stackable: false,
    exclusive: false,
    ...over,
  };
}

const ctx: EvaluationContext = { currency: 'EUR', at: new Date('2026-09-08T12:00:00Z') };

describe('allocation (largest remainder)', () => {
  it('sums exactly to the discount whatever the split', () => {
    const three = [
      { id: 'a', product_id: 'x', quantity: 1, unit_price_minor: 1000 },
      { id: 'b', product_id: 'y', quantity: 1, unit_price_minor: 1000 },
      { id: 'c', product_id: 'z', quantity: 1, unit_price_minor: 1000 },
    ];
    const alloc = allocateAcrossLines(100, three);
    expect(Object.values(alloc).reduce((n, v) => n + v, 0)).toBe(100);
    expect(Object.values(alloc).sort()).toEqual([33, 33, 34]);
    for (const total of [1, 7, 99, 101, 4999]) {
      const a = allocateAcrossLines(total, lines);
      expect(Object.values(a).reduce((n, v) => n + v, 0)).toBe(total);
    }
    expect(Object.values(allocateAcrossLines(0, three))).toEqual([0, 0, 0]);
  });
});

describe('single-promotion discounts', () => {
  it('percentage floors, allocates exactly; fixed_amount caps at the eligible subtotal and needs the currency', () => {
    const pct = promo({ value: 333 }); // 3.33% of 5000 = 166.5 → 166
    const r = evaluatePromotions(lines, [pct], ctx);
    expect(r.discount_minor).toBe(166);
    expect(Object.values(r.allocations).reduce((n, v) => n + v, 0)).toBe(166);

    const fixed = promo({
      type: 'fixed_amount',
      value: 9999,
      currency: 'EUR',
      rules: { product_ids: ['p1'] },
    });
    const rf = evaluatePromotions(lines, [fixed], ctx);
    expect(rf.discount_minor).toBe(1000); // capped at l1's subtotal
    expect(rf.allocations.l1).toBe(1000);

    const wrong = promo({ type: 'fixed_amount', value: 100, currency: 'USD' });
    expect(evaluatePromotions(lines, [wrong], ctx).rejected[0]!.reason).toBe('wrong_currency');
  });

  it('free_shipping sets the flag with zero line discount; buy 2 get 1 frees the cheapest units', () => {
    const ship = promo({ type: 'free_shipping', value: 0 });
    const r = evaluatePromotions(lines, [ship], ctx);
    expect(r.free_shipping).toBe(true);
    expect(r.discount_minor).toBe(0);
    expect(r.applied[0]!.free_shipping).toBe(true);

    // 4 units total (1000, 500, 500, 3000) → buy 2 get 1: 1 bundle of 3 → 1 free unit = cheapest 500
    const bxgy = promo({
      type: 'buy_x_get_y',
      value: 0,
      rules: { buy_quantity: 2, get_quantity: 1 },
    });
    const rb = evaluatePromotions(lines, [bxgy], ctx);
    expect(rb.discount_minor).toBe(500);
    expect(rb.allocations.l2).toBe(500);

    // half off instead of free
    const half = promo({
      type: 'buy_x_get_y',
      value: 0,
      rules: { buy_quantity: 2, get_quantity: 1, get_discount_bp: 5000 },
    });
    expect(evaluatePromotions(lines, [half], ctx).discount_minor).toBe(250);

    // not enough units → applicable but zero discount
    const big = promo({
      type: 'buy_x_get_y',
      value: 0,
      rules: { buy_quantity: 9, get_quantity: 1 },
    });
    expect(evaluatePromotions(lines, [big], ctx).discount_minor).toBe(0);
  });
});

describe('conditions and codes', () => {
  it('gates on subtotal, groups, channel, first order, window, status and eligible lines', () => {
    const cases: [Promotion, EvaluationContext, string][] = [
      [promo({ rules: { min_subtotal_minor: 5001 } }), ctx, 'min_subtotal_not_met'],
      [promo({ rules: { customer_group_ids: ['g1'] } }), ctx, 'customer_group_required'],
      [promo({ rules: { sales_channel_ids: ['s1'] } }), ctx, 'sales_channel_mismatch'],
      [promo({ rules: { first_order_only: true } }), ctx, 'first_order_only'],
      [promo({ starts_at: '2026-09-09T00:00:00Z' }), ctx, 'not_started'],
      [promo({ ends_at: '2026-09-08T12:00:00Z' }), ctx, 'expired'],
      [promo({ status: 'draft' }), ctx, 'not_active'],
      [promo({ status: 'disabled' }), ctx, 'not_active'],
      [promo({ rules: { product_ids: ['nope'] } }), ctx, 'no_eligible_lines'],
      [promo({ usage_limit: 5, usage_count: 5 }), ctx, 'usage_limit_reached'],
    ];
    for (const [p, c, reason] of cases) {
      const r = evaluatePromotions(lines, [p], c);
      expect(r.applied, reason).toHaveLength(0);
      expect(r.rejected[0]!.reason).toBe(reason);
    }
    // the same gates pass with the right context
    const ok = evaluatePromotions(
      lines,
      [
        promo({
          rules: { customer_group_ids: ['g1'], first_order_only: true, min_subtotal_minor: 5000 },
        }),
      ],
      { ...ctx, customerGroupIds: ['g1'], isFirstOrder: true },
    );
    expect(ok.applied).toHaveLength(1);
  });

  it('code promotions need their code; unknown codes are rejected as not_found; per-customer limit counts', () => {
    const coupon = promo({ code: 'SAVE10' });
    expect(evaluatePromotions(lines, [coupon], ctx).applied).toHaveLength(0); // no code entered → not considered
    const r = evaluatePromotions(lines, [coupon], { ...ctx, codes: [' save10 '] });
    expect(r.applied).toHaveLength(1); // case-insensitive, trimmed

    const unknown = evaluatePromotions(lines, [coupon], { ...ctx, codes: ['NOPE'] });
    expect(unknown.rejected).toContainEqual({
      promotion_id: null,
      code: 'NOPE',
      reason: 'not_found',
    });

    const limited = promo({ code: 'ONCE', per_customer_limit: 1 });
    const used = evaluatePromotions(lines, [limited], {
      ...ctx,
      codes: ['ONCE'],
      customerUses: { [limited.id]: 1 },
    });
    expect(used.rejected[0]!.reason).toBe('per_customer_limit_reached');
  });
});

describe('stacking and exclusion', () => {
  it('stackables combine; a better non-stackable alone beats them; exclusive beats everything', () => {
    const s1 = promo({ stackable: true, value: 1000 }); // 500
    const s2 = promo({ stackable: true, value: 500 }); // 250
    const single = promo({ value: 1200 }); // 600 alone
    const bigSingle = promo({ value: 2000 }); // 1000 alone
    const exclusive = promo({ exclusive: true, value: 100 }); // 50, but exclusive

    // stackables only → both apply
    const stacked = evaluatePromotions(lines, [s1, s2], ctx);
    expect(stacked.applied).toHaveLength(2);
    expect(stacked.discount_minor).toBe(750);

    // stack (750) beats single 600 → single rejected not_stacked
    const vsSingle = evaluatePromotions(lines, [s1, s2, single], ctx);
    expect(vsSingle.discount_minor).toBe(750);
    expect(vsSingle.rejected).toContainEqual({
      promotion_id: single.id,
      code: null,
      reason: 'not_stacked',
    });

    // a bigger single (1000) beats the stack → stackables rejected
    const vsBig = evaluatePromotions(lines, [s1, s2, bigSingle], ctx);
    expect(vsBig.applied.map((a) => a.promotion_id)).toEqual([bigSingle.id]);
    expect(vsBig.discount_minor).toBe(1000);
    expect(vsBig.rejected.filter((x) => x.reason === 'not_stacked')).toHaveLength(2);

    // exclusive wins even at lower value; among exclusives the best one
    const ex2 = promo({ exclusive: true, value: 400 }); // 200
    const withEx = evaluatePromotions(lines, [s1, s2, bigSingle, exclusive, ex2], ctx);
    expect(withEx.applied.map((a) => a.promotion_id)).toEqual([ex2.id]);
    expect(withEx.discount_minor).toBe(200);
    expect(withEx.rejected.filter((x) => x.reason === 'not_stacked')).toHaveLength(4);
  });

  it('no line is ever discounted past its own total, and the overflow spills to other eligible lines', () => {
    // the defect the post-merge review of #188 found: two stackable fixed_amount 1000 promotions both
    // targeting the 1000 line used to allocate 2000 to it, because the cap was cart-level only
    const onL1 = { product_ids: ['p1'] };
    const a = promo({
      type: 'fixed_amount',
      value: 1000,
      currency: 'EUR',
      stackable: true,
      rules: onL1,
    });
    const b = promo({
      type: 'fixed_amount',
      value: 1000,
      currency: 'EUR',
      stackable: true,
      rules: onL1,
    });
    const r = evaluatePromotions(lines, [a, b], ctx);
    expect(r.allocations.l1).toBe(1000); // l1's own total, not 2000
    expect(r.discount_minor).toBe(1000);
    expect(r.applied.map((x) => x.discount_minor)).toEqual([1000, 0]); // the second finds no room

    // spill: a category promotion covering l1 + l2, applied after `a` exhausted l1, keeps its full value by
    // moving l1's blocked share onto l2 instead of silently losing it
    const catC1 = promo({
      type: 'fixed_amount',
      value: 900,
      currency: 'EUR',
      stackable: true,
      rules: { category_ids: ['c1'] },
    });
    const spill = evaluatePromotions(lines, [a, catC1], ctx);
    expect(spill.allocations.l1).toBe(1000); // exhausted by `a`, never beyond its own total
    expect(spill.allocations.l2).toBe(900); // l1's blocked 450 spilled here on top of l2's own 450
    expect(spill.applied.find((x) => x.promotion_id === catC1.id)!.discount_minor).toBe(900);
    expect(spill.discount_minor).toBe(1900);

    // the invariant, over every case in this file's fixtures
    for (const set of [
      [a, b],
      [a, catC1],
      [a, b, catC1],
    ]) {
      const out = evaluatePromotions(lines, set, ctx);
      for (const l of lines)
        expect(out.allocations[l.id] ?? 0).toBeLessThanOrEqual(l.unit_price_minor * l.quantity);
      expect(Object.values(out.allocations).reduce((n, v) => n + v, 0)).toBe(out.discount_minor);
      for (const ap of out.applied)
        expect(Object.values(ap.allocations).reduce((n, v) => n + v, 0)).toBe(ap.discount_minor);
    }
  });

  it('the combined discount never exceeds the subtotal and still allocates exactly', () => {
    const a = promo({ stackable: true, value: 8000 }); // 4000
    const b = promo({ stackable: true, value: 6000 }); // 3000 → capped to 1000
    const r = evaluatePromotions(lines, [a, b], ctx);
    expect(r.discount_minor).toBe(5000); // = subtotal
    expect(Object.values(r.allocations).reduce((n, v) => n + v, 0)).toBe(5000);
    for (const applied of r.applied)
      expect(Object.values(applied.allocations).reduce((n, v) => n + v, 0)).toBe(
        applied.discount_minor,
      );
  });
});
