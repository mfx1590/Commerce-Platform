// #179 part 3 on a seeded throwaway database, with the resolver the SERVER registers (src/wiring.ts →
// window 9's resolvePrices): sale > group/override > default, quantity tiers, date windows at the mutation's clock,
// and the placement rule — a price that changed since the cart was priced is a 409 `price_changed` (#228), the
// cart is re-priced, nothing is placed; the retry places at the price the customer has now seen.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addLineItem,
  createCart,
  defaultListPriceResolver,
  getCart,
  setPriceResolver,
  setTaxCalculator,
  tableTaxCalculator,
  updateCart,
  updateLineItem,
} from '../src/modules/cart';
import { completeCart, createPaymentSession } from '../src/modules/checkout';
import { registerTaxProvider } from '../src/modules/tax';
import { priceListResolver } from '../src/wiring';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const actor = { id: null, type: 'customer' as const, requestId: 'req-cart-pricing' };
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
let pool: { id: string; price: number }[];
let next = 0;

/** A fresh variant per test (default-list EUR price, plenty of stock) so lists never bleed between tests. */
const freshVariant = () => pool[next++]!;

async function priceList(
  code: string,
  type: 'sale' | 'override',
  opts: { groupId?: string; endsAt?: string; priority?: number } = {},
): Promise<string> {
  const r = await owner.query<{ id: string }>(
    `INSERT INTO price_list (organization_id, store_id, code, name, type, currency, customer_group_id, ends_at, priority)
     VALUES ($1, $2, $3, $3, $4, 'EUR', $5, $6, $7) RETURNING id`,
    [ORG, A, code, type, opts.groupId ?? null, opts.endsAt ?? null, opts.priority ?? 0],
  );
  return r.rows[0]!.id;
}

const priceRow = (listId: string, variantId: string, amount: number, minQuantity = 1) =>
  owner.query(
    `INSERT INTO price (organization_id, store_id, price_list_id, variant_id, currency, amount_minor, min_quantity)
     VALUES ($1, $2, $3, $4, 'EUR', $5, $6)`,
    [ORG, A, listId, variantId, amount, minQuantity],
  );

beforeAll(async () => {
  db = await createTestDatabase('core_cart_pricing');
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
  const variants = await owner.query<{ id: string; price: number }>(
    `SELECT v.id, pr.amount_minor::int AS price
     FROM product_variant v
     JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     JOIN price_list pl ON pl.id = pr.price_list_id AND pl.type = 'default' AND pl.status = 'active'
     WHERE v.store_id = $1 AND pr.amount_minor >= 1000
       AND (SELECT coalesce(sum(il.available), 0) FROM inventory_level il WHERE il.variant_id = v.id) >= 5
     ORDER BY v.sku LIMIT 12`,
    [A],
  );
  pool = variants.rows;
  expect(pool.length).toBeGreaterThanOrEqual(6);
  setPriceResolver(priceListResolver);
}, 180_000);

afterAll(async () => {
  setPriceResolver(defaultListPriceResolver);
  await db?.drop();
});

describe('unit prices through the registered price lists (#179 part 3)', () => {
  it('a sale list beats the default list; without one the default price stands', async () => {
    const v = freshVariant();
    const plain = freshVariant();
    const sale = await priceList('summer-sale', 'sale');
    await priceRow(sale, v.id, v.price - 300);
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
    const c = await addLineItem(a, cart.id, { variant_id: plain.id, quantity: 1 });
    const unit = (variantId: string) =>
      c.items.find((i) => i.variant_id === variantId)!.unit_price.amount_minor;
    expect(unit(v.id)).toBe(v.price - 300);
    expect(unit(plain.id)).toBe(plain.price);
    expect(c.totals.subtotal.amount_minor).toBe(v.price - 300 + plain.price);
  });

  it('quantity tiers: the unit price follows the line quantity up and down', async () => {
    const v = freshVariant();
    const defaults = await owner.query<{ id: string }>(
      `SELECT id FROM price_list WHERE store_id = $1 AND type = 'default' AND currency = 'EUR'`,
      [A],
    );
    await priceRow(defaults.rows[0]!.id, v.id, v.price - 200, 3); // from 3 units
    const cart = await createCart(a, scopeA);
    const two = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 2 });
    expect(two.items[0]!.unit_price.amount_minor).toBe(v.price);
    const three = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 }); // 2 + 1 crosses the tier
    expect(three.items[0]!.unit_price.amount_minor).toBe(v.price - 200);
    expect(three.totals.subtotal.amount_minor).toBe(3 * (v.price - 200));
    const one = await updateLineItem(a, cart.id, three.items[0]!.id, { quantity: 1 });
    expect(one.items[0]!.unit_price.amount_minor).toBe(v.price);
  });

  it("a group list applies only to a cart whose customer has the group; a guest's cart keeps the default", async () => {
    const v = freshVariant();
    const group = await owner.query<{ id: string }>(
      `INSERT INTO customer_group (organization_id, store_id, code, name) VALUES ($1, $2, 'trade', 'Trade') RETURNING id`,
      [ORG, A],
    );
    const list = await priceList('trade-list', 'override', { groupId: group.rows[0]!.id });
    await priceRow(list, v.id, v.price - 500);
    const customer = await owner.query<{ id: string }>(
      `INSERT INTO customer (organization_id, store_id, email, customer_group_id, status)
       VALUES ($1, $2, 'trade.buyer@example.com', $3, 'registered') RETURNING id`,
      [ORG, A, group.rows[0]!.id],
    );
    const guest = await createCart(a, scopeA);
    const g = await addLineItem(a, guest.id, { variant_id: v.id, quantity: 1 });
    expect(g.items[0]!.unit_price.amount_minor).toBe(v.price);

    const trade = await createCart(a, scopeA);
    await owner.query(`UPDATE cart SET customer_id = $2 WHERE id = $1`, [
      trade.id,
      customer.rows[0]!.id,
    ]);
    const t = await addLineItem(a, trade.id, { variant_id: v.id, quantity: 1 });
    expect(t.items[0]!.unit_price.amount_minor).toBe(v.price - 500);
  });
});

describe('placement never charges a price the customer did not see (409 price_changed, #228)', () => {
  it('a sale that ended since the cart was priced → 409 with the changed lines, the cart re-priced, nothing placed; the retry places at the new price', async () => {
    const v = freshVariant();
    const sale = await priceList('flash-sale', 'sale');
    await priceRow(sale, v.id, v.price - 400);
    const cart = await createCart(a, scopeA);
    const priced = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 2 });
    expect(priced.items[0]!.unit_price.amount_minor).toBe(v.price - 400);
    await updateCart(a, cart.id, {
      email: 'price.change@example.com',
      shipping_address: address,
      billing_address: address,
      shipping_option_id: standardOptionId,
    });
    await createPaymentSession(a, cart.id, { provider: 'manual' });

    await owner.query(`UPDATE price_list SET ends_at = now() - interval '1 minute' WHERE id = $1`, [
      sale,
    ]);
    const key = `key-price-${cart.id}`;
    await expect(
      completeCart(a, { cartId: cart.id, idempotencyKey: key, actor }),
    ).rejects.toMatchObject({
      code: 'price_changed',
      status: 409,
      details: {
        currency: 'EUR',
        items: [
          {
            line_item_id: priced.items[0]!.id,
            variant_id: v.id,
            previous_unit_price_minor: v.price - 400,
            unit_price_minor: v.price,
          },
        ],
      },
    });
    // nothing placed, nothing authorized …
    const placed = await owner.query<{ orders: string; payments: string }>(
      `SELECT (SELECT count(*) FROM "order" WHERE cart_id = $1)::text AS orders,
              (SELECT count(*) FROM payment p JOIN "order" o ON o.id = p.order_id WHERE o.cart_id = $1)::text AS payments`,
      [cart.id],
    );
    expect(placed.rows[0]).toEqual({ orders: '0', payments: '0' });
    // … and the cart now shows what the customer will pay
    const after = await getCart(a, cart.id);
    expect(after.status).toBe('active');
    expect(after.items[0]!.unit_price.amount_minor).toBe(v.price);
    expect(after.totals.subtotal.amount_minor).toBe(2 * v.price);

    const { order, replayed } = await completeCart(a, {
      cartId: cart.id,
      idempotencyKey: key,
      actor,
    });
    expect(replayed).toBe(false);
    expect(order.items[0]!.unit_price.amount_minor).toBe(v.price);
    expect(order.totals.subtotal.amount_minor).toBe(2 * v.price);
  });

  it('a variant that lost every price → 409 with unit_price_minor null; the line keeps its last price until the storefront removes it', async () => {
    const v = freshVariant();
    const cart = await createCart(a, scopeA);
    const priced = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 1 });
    await updateCart(a, cart.id, {
      email: 'no.price@example.com',
      shipping_address: address,
      billing_address: address,
      shipping_option_id: standardOptionId,
    });
    await createPaymentSession(a, cart.id, { provider: 'manual' });
    await owner.query(`DELETE FROM price WHERE variant_id = $1`, [v.id]);
    await expect(
      completeCart(a, { cartId: cart.id, idempotencyKey: `key-noprice-${cart.id}`, actor }),
    ).rejects.toMatchObject({
      code: 'price_changed',
      details: {
        items: [
          {
            line_item_id: priced.items[0]!.id,
            previous_unit_price_minor: v.price,
            unit_price_minor: null,
          },
        ],
      },
    });
    expect((await getCart(a, cart.id)).items[0]!.unit_price.amount_minor).toBe(v.price);
    // and the line can no longer be increased: not sold in the currency
    await expect(
      updateLineItem(a, cart.id, priced.items[0]!.id, { quantity: 2 }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('the tax calculator the server registers (window 7, registerTaxProvider)', () => {
  it('with default store settings it prices a cart exactly like the built-in table calculator', async () => {
    const v = freshVariant();
    const builtIn = await createCart(a, scopeA);
    const expected = await addLineItem(a, builtIn.id, { variant_id: v.id, quantity: 2 });
    expect(expected.totals.tax.amount_minor).toBeGreaterThan(0);
    expect(registerTaxProvider()).toBe(tableTaxCalculator);
    try {
      const cart = await createCart(a, scopeA);
      const c = await addLineItem(a, cart.id, { variant_id: v.id, quantity: 2 });
      expect(c.totals).toEqual(expected.totals);
      expect(c.items[0]!.tax).toEqual(expected.items[0]!.tax);
      expect(c.items[0]!.total).toEqual(expected.items[0]!.total);
    } finally {
      setTaxCalculator(tableTaxCalculator);
    }
  });
});
