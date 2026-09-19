// #230 PR A on a seeded throwaway database, with the evaluator the SERVER registers (src/wiring.ts → window 9's
// promotions engine): coupon and automatic promotions as per-line discounts before tax, free shipping, the code
// rejection rule (never-applicable = 400, conditional = stored), and the tax-inclusive conversion done by OUR
// adapter (the engine always sees tax-exclusive prices).
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addLineItem,
  createCart,
  getCart,
  noDiscounts,
  setDiscountEvaluator,
  taxOn,
  updateCart,
  updateLineItem,
} from '../src/modules/cart';
import { createPromotion } from '../src/modules/promotions';
import { promotionsDiscountEvaluator } from '../src/wiring';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const INCLUSIVE_ON = `UPDATE store SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{tax}', '{"prices_include_tax": true}'::jsonb) WHERE id = $1`;
const INCLUSIVE_OFF = `UPDATE store SET settings = coalesce(settings, '{}'::jsonb) - 'tax' WHERE id = $1`;
const address = {
  first_name: 'Jane',
  last_name: 'Doe',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'NL',
};

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let standardOptionId: string;
let pool: { id: string; product_id: string; price: number }[];
let next = 0;
const freshVariant = () => pool[next++]!;

const promo = (body: Record<string, unknown>) =>
  createPromotion(a, A, { status: 'active', ...body });
const rateOf = async (cartId: string) =>
  (
    await owner.query<{ tax_rate_bp: number }>(
      `SELECT tax_rate_bp FROM cart_line_item WHERE cart_id = $1 ORDER BY created_at LIMIT 1`,
      [cartId],
    )
  ).rows[0]!.tax_rate_bp;

beforeAll(async () => {
  db = await createTestDatabase('core_cart_discounts');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
  const option = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  standardOptionId = option.rows[0]!.id;
  // one variant per product, so a product-scoped promotion never touches another test's line
  const variants = await owner.query<{ id: string; product_id: string; price: number }>(
    `SELECT DISTINCT ON (v.product_id) v.id, v.product_id, pr.amount_minor::int AS price
     FROM product_variant v
     JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     JOIN price_list pl ON pl.id = pr.price_list_id AND pl.type = 'default' AND pl.status = 'active'
     WHERE v.store_id = $1 AND pr.amount_minor >= 1000
       AND (SELECT coalesce(sum(il.available), 0) FROM inventory_level il WHERE il.variant_id = v.id) >= 5
     ORDER BY v.product_id, v.sku LIMIT 24`,
    [A],
  );
  pool = variants.rows;
  expect(pool.length).toBeGreaterThanOrEqual(18);
  setDiscountEvaluator(promotionsDiscountEvaluator);
}, 180_000);

afterAll(async () => {
  setDiscountEvaluator(noDiscounts);
  await owner?.query(INCLUSIVE_OFF, [A]);
  await db?.drop();
});

describe('discounts through the registered promotions engine (#230 PR A)', () => {
  it('a coupon is a per-line discount before tax; removing the code removes it', async () => {
    const v = freshVariant();
    await promo({ code: 'TEN', name: 'Ten percent', type: 'percentage', value: 1000 });
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: v.id, quantity: 2 });
    const c = await updateCart(a, cart.id, { promotion_codes: [' ten '] });
    const subtotal = 2 * v.price;
    const discount = c.totals.discount.amount_minor;
    expect(Math.abs(discount - subtotal / 10)).toBeLessThan(1);
    expect(c.items[0]!.discount.amount_minor).toBe(discount);
    const bp = await rateOf(cart.id);
    expect(bp).toBeGreaterThan(0);
    expect(c.totals.tax.amount_minor).toBe(taxOn(subtotal - discount, bp)); // tax on the DISCOUNTED base
    expect(c.items[0]!.total.amount_minor).toBe(
      subtotal - discount + taxOn(subtotal - discount, bp),
    );
    expect(c.totals.total.amount_minor).toBe(subtotal - discount + taxOn(subtotal - discount, bp));
    expect(c.promotion_codes).toEqual(['ten']);

    const without = await updateCart(a, cart.id, { promotion_codes: [] });
    expect(without.totals.discount.amount_minor).toBe(0);
    expect(without.items[0]!.discount.amount_minor).toBe(0);
    expect(without.totals.total.amount_minor).toBe(subtotal + taxOn(subtotal, bp));
  });

  it('an automatic promotion needs no code and lands only on the lines it selects', async () => {
    const onSale = freshVariant();
    const plain = freshVariant();
    await promo({
      name: 'Product week',
      type: 'percentage',
      value: 2000,
      rules: { product_ids: [onSale.product_id] },
    });
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: plain.id, quantity: 1 });
    const c = await addLineItem(a, cart.id, { variant_id: onSale.id, quantity: 1 });
    const line = (variantId: string) => c.items.find((i) => i.variant_id === variantId)!;
    expect(Math.abs(line(onSale.id).discount.amount_minor - onSale.price / 5)).toBeLessThan(1);
    expect(line(plain.id).discount.amount_minor).toBe(0);
    expect(c.totals.discount.amount_minor).toBe(line(onSale.id).discount.amount_minor);
  });

  it('free shipping zeroes the shipping total while the code is on the cart', async () => {
    const v = freshVariant();
    await promo({ code: 'SHIPFREE', name: 'Free shipping', type: 'free_shipping' });
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
    const priced = await updateCart(a, cart.id, {
      shipping_address: address,
      shipping_option_id: standardOptionId,
    });
    expect(priced.totals.shipping.amount_minor).toBeGreaterThan(0);
    const free = await updateCart(a, cart.id, { promotion_codes: ['SHIPFREE'] });
    expect(free.totals.shipping.amount_minor).toBe(0);
    expect(free.totals.total.amount_minor).toBe(
      priced.totals.total.amount_minor - priced.totals.shipping.amount_minor,
    );
    const back = await updateCart(a, cart.id, { promotion_codes: [] });
    expect(back.totals.shipping.amount_minor).toBe(priced.totals.shipping.amount_minor);
  });
});

describe('entering a code: never-applicable = 400 and nothing stored; conditional = stored until the cart qualifies', () => {
  it('unknown, expired, inactive and used-up codes are refused with the reason per code', async () => {
    const v = freshVariant();
    await promo({
      code: 'LASTYEAR',
      name: 'Expired',
      type: 'percentage',
      value: 500,
      ends_at: '2020-01-01T00:00:00.000Z',
    });
    await promo({
      code: 'DRAFTED',
      name: 'Not active',
      type: 'percentage',
      value: 500,
      status: 'draft',
    });
    const usedUp = await promo({
      code: 'ONCE',
      name: 'Used up',
      type: 'percentage',
      value: 500,
      usage_limit: 1,
    });
    await owner.query(`UPDATE promotion SET usage_count = 1 WHERE id = $1`, [usedUp.id]);
    await promo({ code: 'GOOD', name: 'Fine', type: 'percentage', value: 500 });

    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
    await expect(
      updateCart(a, cart.id, { promotion_codes: ['GOOD', 'nope', 'LASTYEAR', 'DRAFTED', 'ONCE'] }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
      details: {
        promotion_codes: {
          NOPE: 'not_found',
          LASTYEAR: 'expired',
          DRAFTED: 'not_active',
          ONCE: 'usage_limit_reached',
        },
      },
    });
    // the whole PATCH rolled back: not even the good code was stored
    const after = await getCart(a, cart.id);
    expect(after.promotion_codes).toEqual([]);
    expect(after.totals.discount.amount_minor).toBe(0);
    const ok = await updateCart(a, cart.id, { promotion_codes: ['GOOD'] });
    expect(ok.totals.discount.amount_minor).toBeGreaterThan(0);
  });

  it('a minimum-subtotal code and a first-order code are kept: the first applies once the cart qualifies, a guest never has a first order', async () => {
    const v = freshVariant();
    await promo({
      code: 'BIGCART',
      name: 'Over the threshold',
      type: 'percentage',
      value: 1000,
      rules: { min_subtotal_minor: v.price * 2, product_ids: [v.product_id] },
    });
    await promo({
      code: 'WELCOME',
      name: 'First order',
      type: 'percentage',
      value: 1500,
      rules: { first_order_only: true, product_ids: [v.product_id] },
    });
    const cart = await createCart(a, scopeA);
    const added = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
    const stored = await updateCart(a, cart.id, { promotion_codes: ['BIGCART', 'WELCOME'] });
    expect(stored.promotion_codes).toEqual(['BIGCART', 'WELCOME']);
    expect(stored.totals.discount.amount_minor).toBe(0);
    const qualified = await updateLineItem(a, cart.id, added.items[0]!.id, { quantity: 2 });
    expect(Math.abs(qualified.totals.discount.amount_minor - (2 * v.price) / 10)).toBeLessThan(1);
  });
});

describe('tax-inclusive store: our adapter converts, the engine keeps seeing tax-exclusive prices', () => {
  it('a percentage takes that percentage off the gross price; a fixed amount is exactly that GROSS amount; tax stays contained', async () => {
    const pct = freshVariant();
    const fixed = freshVariant();
    await promo({
      code: 'INCL10',
      name: 'Ten percent',
      type: 'percentage',
      value: 1000,
      rules: { product_ids: [pct.product_id] },
    });
    await promo({
      code: 'FIVEOFF',
      name: 'Five euros off the displayed price',
      type: 'fixed_amount',
      value: 500,
      currency: 'EUR',
      rules: { product_ids: [fixed.product_id] },
    });
    await owner.query(INCLUSIVE_ON, [A]);
    try {
      const cart = await createCart(a, scopeA);
      await addLineItem(a, cart.id, { variant_id: pct.id, quantity: 1 });
      const c = await updateCart(a, cart.id, { promotion_codes: ['INCL10'] });
      const bp = await rateOf(cart.id);
      expect(bp).toBeGreaterThan(0);
      const discount = c.totals.discount.amount_minor;
      expect(Math.abs(discount - pct.price / 10)).toBeLessThanOrEqual(1); // 10 % of the GROSS price, ± a cent
      expect(c.totals.tax.amount_minor).toBe(taxOn(pct.price - discount, bp, true)); // contained, on the discounted gross
      expect(c.totals.total.amount_minor).toBe(pct.price - discount); // nothing on top
      expect(c.items[0]!.total.amount_minor).toBe(pct.price - discount);

      const second = await createCart(a, scopeA);
      await addLineItem(a, second.id, { variant_id: fixed.id, quantity: 1 });
      const f = await updateCart(a, second.id, { promotion_codes: ['FIVEOFF'] });
      const rate = await rateOf(second.id);
      expect(rate).toBeGreaterThan(0);
      expect(f.totals.discount.amount_minor).toBe(500); // "5.00 off" drops the displayed total by exactly 5.00
      expect(f.totals.total.amount_minor).toBe(fixed.price - 500);
      expect(f.totals.tax.amount_minor).toBe(taxOn(fixed.price - 500, rate, true)); // contained, on what is paid
    } finally {
      await owner.query(INCLUSIVE_OFF, [A]);
    }
    // the same fixed amount in an exclusive store is simply 5.00
    const exclusive = await createCart(a, scopeA);
    await addLineItem(a, exclusive.id, { variant_id: fixed.id, quantity: 1 });
    const e = await updateCart(a, exclusive.id, { promotion_codes: ['FIVEOFF'] });
    expect(e.totals.discount.amount_minor).toBe(500);
  });

  it('a minimum subtotal compares the DISPLAYED (gross) subtotal: "spend X" is met by a cart showing X', async () => {
    const v = freshVariant();
    // threshold = exactly what a cart of two shows; in net money the same cart is below it
    await promo({
      code: 'SPEND',
      name: 'Spend the displayed amount',
      type: 'percentage',
      value: 1000,
      rules: { min_subtotal_minor: 2 * v.price, product_ids: [v.product_id] },
    });
    await owner.query(INCLUSIVE_ON, [A]);
    try {
      const cart = await createCart(a, scopeA);
      const one = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
      const stored = await updateCart(a, cart.id, { promotion_codes: ['SPEND'] });
      expect(stored.totals.discount.amount_minor).toBe(0); // shows 1 × price: below the threshold, code kept
      expect(stored.promotion_codes).toEqual(['SPEND']);
      const two = await updateLineItem(a, cart.id, one.items[0]!.id, { quantity: 2 });
      expect(two.totals.subtotal.amount_minor).toBe(2 * v.price);
      expect(two.totals.discount.amount_minor).toBeGreaterThan(0); // shows exactly the threshold: met
      expect(Math.abs(two.totals.discount.amount_minor - (2 * v.price) / 10)).toBeLessThanOrEqual(
        1,
      );
    } finally {
      await owner.query(INCLUSIVE_OFF, [A]);
    }
  });
});

describe('a code that has not started yet is conditional: time makes it applicable, not the cart (#243 ruling)', () => {
  it('a launch code entered before its start is stored without a discount and applies once it is active', async () => {
    const v = freshVariant();
    const launch = await promo({
      code: 'LAUNCH',
      name: 'Starts tomorrow',
      type: 'percentage',
      value: 1000,
      starts_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      rules: { product_ids: [v.product_id] },
    });
    const cart = await createCart(a, scopeA);
    const added = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
    const early = await updateCart(a, cart.id, { promotion_codes: ['LAUNCH'] });
    expect(early.promotion_codes).toEqual(['LAUNCH']);
    expect(early.totals.discount.amount_minor).toBe(0);

    await owner.query(
      `UPDATE promotion SET starts_at = now() - interval '1 minute' WHERE id = $1`,
      [launch.id],
    );
    const live = await updateLineItem(a, cart.id, added.items[0]!.id, { quantity: 2 });
    expect(Math.abs(live.totals.discount.amount_minor - (2 * v.price) / 10)).toBeLessThan(1);
  });
});

describe('tax-inclusive fixed amounts are exact on awkward carts (#243 re-review)', () => {
  /** A cart of tiny, small and ordinary lines — the sizes where a net → gross round trip overshoots a line. */
  async function mixedCart(prices: number[]) {
    const variants = prices.map(() => freshVariant());
    for (const [i, v] of variants.entries()) {
      await owner.query(
        `UPDATE price SET amount_minor = $2 WHERE variant_id = $1 AND currency = 'EUR'`,
        [v.id, prices[i]],
      );
    }
    return variants;
  }
  const fill = async (variants: { id: string }[]) => {
    const cart = await createCart(a, scopeA);
    for (const v of variants) await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
    return cart;
  };

  it('mixed line sizes: whatever the rounding drift, the displayed total drops by exactly the configured amount and no line goes below zero', async () => {
    const prices = [3, 101, 1999];
    const variants = await mixedCart(prices);
    const displayed = prices.reduce((n, p) => n + p, 0);
    const amounts = [7, 50, 333, 1500];
    for (const amount of amounts) {
      await promo({
        code: `MIX${amount}`,
        name: `${amount} off the mixed cart`,
        type: 'fixed_amount',
        value: amount,
        currency: 'EUR',
        rules: { product_ids: variants.map((v) => v.product_id) },
      });
    }
    await owner.query(INCLUSIVE_ON, [A]);
    try {
      for (const amount of amounts) {
        const cart = await fill(variants);
        const c = await updateCart(a, cart.id, { promotion_codes: [`MIX${amount}`] });
        expect(c.totals.subtotal.amount_minor).toBe(displayed);
        expect(c.totals.discount.amount_minor).toBe(amount);
        expect(c.totals.total.amount_minor).toBe(displayed - amount);
        expect(c.items.reduce((n, i) => n + i.discount.amount_minor, 0)).toBe(amount);
        for (const item of c.items) {
          expect(item.discount.amount_minor).toBeGreaterThanOrEqual(0);
          expect(item.discount.amount_minor).toBeLessThanOrEqual(item.subtotal.amount_minor);
          expect(item.total.amount_minor).toBe(
            item.subtotal.amount_minor - item.discount.amount_minor,
          );
        }
      }
    } finally {
      await owner.query(INCLUSIVE_OFF, [A]);
    }
  });

  it("the reviewer's case — lines 3 + 100, 200 off: the discount is exactly the eligible displayed subtotal (103), not 102; a line outside the promotion is untouched", async () => {
    const [tiny, small, outside] = await mixedCart([3, 100, 1200]);
    await promo({
      code: 'TOOBIG',
      name: 'More than the eligible lines are worth',
      type: 'fixed_amount',
      value: 200,
      currency: 'EUR',
      rules: { product_ids: [tiny!.product_id, small!.product_id] },
    });
    await owner.query(INCLUSIVE_ON, [A]);
    try {
      const cart = await fill([tiny!, small!, outside!]);
      const c = await updateCart(a, cart.id, { promotion_codes: ['TOOBIG'] });
      const line = (variantId: string) => c.items.find((i) => i.variant_id === variantId)!;
      expect(line(tiny!.id).discount.amount_minor).toBe(3);
      expect(line(small!.id).discount.amount_minor).toBe(100);
      expect(line(outside!.id).discount.amount_minor).toBe(0);
      expect(c.totals.discount.amount_minor).toBe(Math.min(200, 103));
      expect(c.totals.total.amount_minor).toBe(1303 - 103);
    } finally {
      await owner.query(INCLUSIVE_OFF, [A]);
    }
  });
});
