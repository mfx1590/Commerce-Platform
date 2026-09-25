// #230 PR B on a seeded throwaway database, with the evaluator the SERVER registers: promotions are re-evaluated
// under the cart lock at placement (a changed discount = 409 `price_changed`), uses are counted inside the placement
// transaction before any authorisation, the order freezes the applied codes and promotions, "orders that count"
// decide a customer's first order, and an order edit scales the frozen discount pro rata.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import {
  addLineItem,
  createCart,
  getCart,
  noDiscounts,
  setDiscountEvaluator,
  updateCart,
  type DiscountEvaluator,
} from '../src/modules/cart';
import {
  completeCart,
  createPaymentSession,
  manualPaymentProvider,
  setPaymentProvider,
} from '../src/modules/checkout';
import { decreaseLineQuantity } from '../src/modules/orders';
import { createPromotion } from '../src/modules/promotions';
import { mulDivRound, promotionsDiscountEvaluator } from '../src/wiring';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const actor = { id: null, type: 'customer' as const, requestId: 'req-placement-promotions' };
const staff = { id: null, type: 'system' as const, requestId: 'req-placement-promotions-edit' };
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
let n = 0;
const freshVariant = () => pool[next++]!;
const promo = (body: Record<string, unknown>) =>
  createPromotion(a, A, { status: 'active', ...body });

/** A cart ready for placement: one line, email, addresses, the standard option, codes, a manual session. */
async function readyCart(opts: {
  variantId: string;
  quantity?: number;
  codes?: string[];
  customerId?: string;
  metadata?: Record<string, unknown>;
}) {
  const cart = await createCart(a, scopeA, opts.metadata ? { metadata: opts.metadata } : {});
  if (opts.customerId) {
    await owner.query(`UPDATE cart SET customer_id = $2 WHERE id = $1`, [cart.id, opts.customerId]);
  }
  await addLineItem(a, cart.id, { variant_id: opts.variantId, quantity: opts.quantity ?? 1 });
  const email = `placement+${n++}@example.com`;
  await updateCart(a, cart.id, {
    email,
    shipping_address: address,
    billing_address: address,
    shipping_option_id: standardOptionId,
    ...(opts.codes ? { promotion_codes: opts.codes } : {}),
  });
  await createPaymentSession(a, cart.id, { provider: 'manual' });
  return { id: cart.id, email };
}
const place = (cartId: string, key = `key-${cartId}`) =>
  completeCart(a, { cartId, idempotencyKey: key, actor });
const usesOf = async (promotionId: string) =>
  (
    await owner.query<{ usage_count: number }>(`SELECT usage_count FROM promotion WHERE id = $1`, [
      promotionId,
    ])
  ).rows[0]!.usage_count;
const ordersOf = async (cartId: string) =>
  Number(
    (
      await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "order" WHERE cart_id = $1`,
        [cartId],
      )
    ).rows[0]!.n,
  );
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (e) {
    const err = e as AppError;
    return {
      status: err.status,
      body: err.toBody() as { code: string; details?: Record<string, unknown> },
    };
  }
  throw new Error('expected a failure');
};

beforeAll(async () => {
  db = await createTestDatabase('core_placement_promotions');
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
  const variants = await owner.query<{ id: string; product_id: string; price: number }>(
    `SELECT DISTINCT ON (v.product_id) v.id, v.product_id, pr.amount_minor::int AS price
     FROM product_variant v
     JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     JOIN price_list pl ON pl.id = pr.price_list_id AND pl.type = 'default' AND pl.status = 'active'
     WHERE v.store_id = $1 AND pr.amount_minor >= 1000
       AND (SELECT coalesce(sum(il.available), 0) FROM inventory_level il WHERE il.variant_id = v.id) >= 8
     ORDER BY v.product_id, v.sku LIMIT 16`,
    [A],
  );
  pool = variants.rows;
  expect(pool.length).toBeGreaterThanOrEqual(10);
  setDiscountEvaluator(promotionsDiscountEvaluator);
}, 180_000);

afterEach(() => {
  setDiscountEvaluator(promotionsDiscountEvaluator);
  setPaymentProvider(manualPaymentProvider);
});

afterAll(async () => {
  setDiscountEvaluator(noDiscounts);
  await db?.drop();
});

describe('placement freezes what was applied and counts the use', () => {
  it('applied codes only on the order, applied promotions in its metadata, one use counted, the event agrees', async () => {
    const v = freshVariant();
    const ten = await promo({
      code: 'FREEZE10',
      name: 'Ten percent',
      type: 'percentage',
      value: 1000,
      rules: { product_ids: [v.product_id] },
    });
    const big = await promo({
      code: 'FREEZEBIG',
      name: 'Never reached',
      type: 'percentage',
      value: 2000,
      rules: { min_subtotal_minor: 100_000_000, product_ids: [v.product_id] },
    });
    const cart = await readyCart({
      variantId: v.id,
      quantity: 2,
      codes: ['freeze10', 'FREEZEBIG'],
    });
    const quoted = await getCart(a, cart.id);
    const discount = quoted.totals.discount.amount_minor;
    expect(discount).toBeGreaterThan(0);

    const { order } = await place(cart.id);
    expect(order.totals.discount.amount_minor).toBe(discount);
    expect(order.items[0]!.discount.amount_minor).toBe(discount);
    expect(order.totals.total.amount_minor).toBe(quoted.totals.total.amount_minor);
    const row = (
      await owner.query<{ promotion_codes: string[]; metadata: Record<string, unknown> }>(
        `SELECT promotion_codes, metadata FROM "order" WHERE id = $1`,
        [order.id],
      )
    ).rows[0]!;
    expect(row.promotion_codes).toEqual(['FREEZE10']); // the applied one, not the conditional one that sat on the cart
    expect(row.metadata.promotions).toEqual([
      { promotion_id: ten.id, code: 'FREEZE10', discount_minor: discount },
    ]);
    expect(await usesOf(ten.id)).toBe(1);
    expect(await usesOf(big.id)).toBe(0);
    const placed = (
      await owner.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM outbox WHERE topic = 'order.placed' AND aggregate_id::text = $1`,
        [order.id],
      )
    ).rows[0]!.payload;
    expect(placed.promotion_codes).toEqual(['FREEZE10']);
    expect((placed.totals as { discount_minor: number }).discount_minor).toBe(discount);
  });

  it("the storefront's cart metadata cannot pre-write the core's order keys (fraud, promotions)", async () => {
    const v = freshVariant();
    const cart = await readyCart({
      variantId: v.id,
      metadata: { note: 'gift', fraud: { status: 'cleared' }, promotions: [{ promotion_id: 'x' }] },
    });
    const { order } = await place(cart.id);
    const row = (
      await owner.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM "order" WHERE id = $1`,
        [order.id],
      )
    ).rows[0]!;
    expect(row.metadata).toEqual({ note: 'gift' });
  });
});

describe('a discount that changed since the quote is never placed silently (409 price_changed)', () => {
  it('a promotion that ended → 409 with previous and current discount, the cart re-quoted, no use counted; the retry places without it', async () => {
    const v = freshVariant();
    const p = await promo({
      code: 'ENDING',
      name: 'About to end',
      type: 'percentage',
      value: 1500,
      rules: { product_ids: [v.product_id] },
    });
    const cart = await readyCart({ variantId: v.id, quantity: 2, codes: ['ENDING'] });
    const quoted = await getCart(a, cart.id);
    const previous = quoted.totals.discount.amount_minor;
    expect(previous).toBeGreaterThan(0);
    await owner.query(`UPDATE promotion SET ends_at = now() - interval '1 minute' WHERE id = $1`, [
      p.id,
    ]);

    const refused = await failure(() => place(cart.id));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'price_changed',
      details: {
        currency: 'EUR',
        items: [],
        discount_minor: { previous, current: 0 },
        total_minor: { previous: quoted.totals.total.amount_minor },
      },
    });
    expect(await ordersOf(cart.id)).toBe(0);
    expect(await usesOf(p.id)).toBe(0);
    const after = await getCart(a, cart.id);
    expect(after.status).toBe('active');
    expect(after.totals.discount.amount_minor).toBe(0);
    expect((refused.body.details!.total_minor as { current: number }).current).toBe(
      after.totals.total.amount_minor,
    );

    const { order } = await place(cart.id); // same key: no order exists for it
    expect(order.totals.discount.amount_minor).toBe(0);
    expect(order.totals.total.amount_minor).toBe(after.totals.total.amount_minor);
  });

  it('the last use: the second cart quoted with it gets price_changed; a race lost INSIDE the placement is a 409 conflict with nothing authorised', async () => {
    const v = freshVariant();
    const p = await promo({
      code: 'LASTONE',
      name: 'One use only',
      type: 'percentage',
      value: 1000,
      usage_limit: 1,
      rules: { product_ids: [v.product_id] },
    });
    const first = await readyCart({ variantId: v.id, codes: ['LASTONE'] });
    const second = await readyCart({ variantId: v.id, codes: ['LASTONE'] });
    const third = await readyCart({ variantId: v.id, codes: ['LASTONE'] });

    // the true race: evaluation still sees a free use, the counting UPDATE does not — simulated by an evaluator
    // whose recordUse loses exactly like window 9's does past the limit
    let authorizeCalls = 0;
    setPaymentProvider({
      ...manualPaymentProvider,
      async authorize(input) {
        authorizeCalls++;
        return manualPaymentProvider.authorize(input);
      },
    });
    const losing: DiscountEvaluator = {
      evaluate: (q) => promotionsDiscountEvaluator.evaluate(q),
      async recordUse() {
        throw new AppError('conflict', 'promotion usage limit reached');
      },
    };
    setDiscountEvaluator(losing);
    const lost = await failure(() => place(third.id));
    expect(lost).toMatchObject({ status: 409, body: { code: 'conflict' } });
    expect(authorizeCalls).toBe(0); // before any authorisation: nothing to void
    expect(await ordersOf(third.id)).toBe(0);
    expect(await usesOf(p.id)).toBe(0);
    setDiscountEvaluator(promotionsDiscountEvaluator);

    await place(first.id);
    expect(await usesOf(p.id)).toBe(1);
    const late = await failure(() => place(second.id));
    expect(late.body).toMatchObject({ code: 'price_changed' });
    expect((late.body.details!.discount_minor as { current: number }).current).toBe(0);
    expect(await usesOf(p.id)).toBe(1);
  });

  it('a placement that fails after the use was counted gives the use back (declined payment)', async () => {
    const v = freshVariant();
    const p = await promo({
      code: 'NOTBURNT',
      name: 'Survives a decline',
      type: 'percentage',
      value: 1000,
      usage_limit: 1,
      rules: { product_ids: [v.product_id] },
    });
    const cart = await readyCart({ variantId: v.id, codes: ['NOTBURNT'] });
    setPaymentProvider({
      ...manualPaymentProvider,
      async authorize() {
        return { status: 'failed', providerPaymentId: null };
      },
    });
    const declined = await failure(() => place(cart.id));
    expect(declined).toMatchObject({ status: 402, body: { code: 'payment_failed' } });
    expect(await usesOf(p.id)).toBe(0);
    setPaymentProvider(manualPaymentProvider);
    await place(cart.id, `key-retry-${cart.id}`);
    expect(await usesOf(p.id)).toBe(1);
  });
});

describe('"orders that count" decide a first order (ruling in PR B)', () => {
  it('cancelled, unpaid and fraud-held orders do not take the welcome code away; a clean paid order does', async () => {
    const v = freshVariant();
    await promo({
      code: 'WELCOME15',
      name: 'First order',
      type: 'percentage',
      value: 1500,
      rules: { first_order_only: true, product_ids: [v.product_id] },
    });
    const customer = (
      await owner.query<{ id: string }>(
        `INSERT INTO customer (organization_id, store_id, email, status)
         VALUES ($1, $2, 'first.order@example.com', 'registered') RETURNING id`,
        [ORG, A],
      )
    ).rows[0]!.id;
    const welcomeDiscount = async () => {
      const cart = await createCart(a, scopeA);
      await owner.query(`UPDATE cart SET customer_id = $2 WHERE id = $1`, [cart.id, customer]);
      await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
      return (await updateCart(a, cart.id, { promotion_codes: ['WELCOME15'] })).totals.discount
        .amount_minor;
    };
    expect(await welcomeDiscount()).toBeGreaterThan(0); // no order at all

    const earlier = await readyCart({ variantId: freshVariant().id, customerId: customer });
    const { order } = await place(earlier.id);
    expect(await welcomeDiscount()).toBe(0); // a clean, authorised order counts

    const set = (sql: string, params: unknown[] = []) =>
      owner.query(`UPDATE "order" SET ${sql} WHERE id = $1`, [order.id, ...params]);
    await set(`payment_status = 'failed'`);
    expect(await welcomeDiscount()).toBeGreaterThan(0); // unpaid
    await set(
      `payment_status = 'authorized', metadata = metadata || '{"fraud":{"status":"review","reason_code":"velocity_email"}}'::jsonb`,
    );
    expect(await welcomeDiscount()).toBeGreaterThan(0); // held by a fraud review
    await set(
      `metadata = metadata || '{"fraud":{"status":"cleared","reason_code":"velocity_email"}}'::jsonb`,
    );
    expect(await welcomeDiscount()).toBe(0); // cleared: it counts again
    await set(`status = 'cancelled'`);
    expect(await welcomeDiscount()).toBeGreaterThan(0); // cancelled
  });
});

describe('an order edit scales the frozen discount pro rata (cumulative floor, from the line as placed)', () => {
  it('3 → 2 → 1 gives the same discounts as 3 → 1 would; totals follow; no re-evaluation', async () => {
    const v = freshVariant();
    const p = await promo({
      code: 'EDIT10',
      name: 'Ten percent',
      type: 'percentage',
      value: 1000,
      rules: { product_ids: [v.product_id] },
    });
    const cart = await readyCart({ variantId: v.id, quantity: 3, codes: ['EDIT10'] });
    const { order } = await place(cart.id);
    const line = order.items[0]!;
    const placedDiscount = line.discount.amount_minor;
    expect(placedDiscount).toBeGreaterThan(0);
    await owner.query(`UPDATE promotion SET status = 'disabled' WHERE id = $1`, [p.id]); // the deal stays frozen

    const lineRow = async () =>
      (
        await owner.query<{
          quantity: number;
          discount_minor: string;
          metadata: Record<string, unknown>;
        }>(`SELECT quantity, discount_minor::text, metadata FROM order_line_item WHERE id = $1`, [
          line.id,
        ])
      ).rows[0]!;
    await decreaseLineQuantity(a, order.id, line.id, 2, staff);
    expect(Number((await lineRow()).discount_minor)).toBe(Math.floor((placedDiscount * 2) / 3));
    const two = await decreaseLineQuantity(a, order.id, line.id, 1, staff);
    const row = await lineRow();
    expect(Number(row.discount_minor)).toBe(Math.floor(placedDiscount / 3)); // from the line as placed
    expect(row.metadata.discount_base).toEqual({ quantity: 3, discount_minor: placedDiscount });
    expect(two.totals.discount.amount_minor).toBe(Math.floor(placedDiscount / 3));
  });
});

describe('mulDivRound (the blended fixed-amount conversion)', () => {
  it('rounds half up and stays exact beyond 2^53', () => {
    expect(mulDivRound(500, 100, 119)).toBe(420); // 420.17
    expect(mulDivRound(1, 1, 2)).toBe(1); // .5 up
    expect(mulDivRound(Number.MAX_SAFE_INTEGER, 3, 3)).toBe(Number.MAX_SAFE_INTEGER);
    expect(mulDivRound(9_000_000_000_000_000, 1_000_000, 2_000_000)).toBe(4_500_000_000_000_000);
  });
});
