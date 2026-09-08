// Cart module (issue #103) on a fully seeded throwaway database: totals in integer minor units recomputed on
// every change, stock and currency rules, RLS scope, and the pricing provider seams windows 7 and 8 plug into.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addLineItem,
  createCart,
  getCart,
  normalizePromotionCodes,
  removeLineItem,
  setShippingRateProvider,
  setTaxCalculator,
  tableShippingRates,
  tableTaxCalculator,
  taxOn,
  updateCart,
  updateLineItem,
  type ShippingRateProvider,
  type TaxCalculator,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };

interface SeededVariant {
  id: string;
  product_id: string;
  price: number;
  available: number;
  manage_inventory: boolean;
  allow_backorder: boolean;
}

/** Published brand-a variants with an EUR default price and their summed availability. */
async function variantsA(): Promise<SeededVariant[]> {
  const r = await owner.query<SeededVariant>(
    `SELECT v.id, v.product_id, pr.amount_minor::int AS price, v.manage_inventory, v.allow_backorder,
            coalesce((SELECT sum(il.available) FROM inventory_level il WHERE il.variant_id = v.id), 0)::int AS available
     FROM product_variant v
     JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     WHERE v.store_id = $1 ORDER BY v.sku LIMIT 40`,
    [A],
  );
  return r.rows;
}

beforeAll(async () => {
  db = await createTestDatabase('core_cart');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

afterEach(() => {
  setTaxCalculator(tableTaxCalculator);
  setShippingRateProvider(tableShippingRates);
});

describe('createCart', () => {
  it('creates an empty active cart with the store defaults and round-trips metadata', async () => {
    const meta = {
      attribution: { first: { source: 'newsletter' } },
      note: 'x',
      n: 1,
      deep: { a: [1, 2] },
    };
    const cart = await createCart(a, scopeA, { metadata: meta });
    expect(cart).toMatchObject({
      status: 'active',
      currency: 'EUR',
      locale: 'en-GB',
      country: 'NL',
      email: null,
      items: [],
      shipping_address: null,
      billing_address: null,
      shipping_option: null,
      promotion_codes: [],
      payment_session: null,
      order_id: null,
      metadata: meta,
    });
    for (const k of ['subtotal', 'discount', 'shipping', 'tax', 'total'] as const) {
      expect(cart.totals[k]).toEqual({ amount_minor: 0, currency: 'EUR' });
    }
    const row = await owner.query<{
      organization_id: string;
      store_id: string;
      sales_channel_id: string;
    }>(`SELECT organization_id, store_id, sales_channel_id FROM cart WHERE id = $1`, [cart.id]);
    expect(row.rows[0]).toEqual({
      organization_id: ORG,
      store_id: A,
      sales_channel_id: scopeA.salesChannelId,
    });
    expect((await getCart(a, cart.id)).metadata).toEqual(meta);
  });

  it('accepts a country/locale override and refuses a currency the store does not sell', async () => {
    const cart = await createCart(a, scopeA, { country: 'DE', locale: 'de-DE' });
    expect(cart).toMatchObject({ country: 'DE', locale: 'de-DE', currency: 'EUR' });
    await expect(createCart(a, scopeA, { currency: 'USD' })).rejects.toMatchObject({
      code: 'validation_error',
      details: { currency: 'one of EUR' },
    });
  });

  it('falls back to the active web channel when the key carries none', async () => {
    const cart = await createCart(a, { ...scopeA, salesChannelId: null });
    const row = await owner.query<{ sales_channel_id: string }>(
      `SELECT sales_channel_id FROM cart WHERE id = $1`,
      [cart.id],
    );
    expect(row.rows[0]!.sales_channel_id).toBe(scopeA.salesChannelId);
  });
});

describe('line items and totals (brand-a: VAT 21% on tax-exclusive prices)', () => {
  it('add / increase / update / remove recompute subtotal, tax and total in minor units', async () => {
    const [v1, v2] = (await variantsA()).filter((v) => v.available >= 5);
    expect(v1 && v2).toBeTruthy();
    const cart = await createCart(a, scopeA);

    let c = await addLineItem(a, cart.id, { variant_id: v1!.id, quantity: 2 });
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({
      variant_id: v1!.id,
      quantity: 2,
      unit_price: { amount_minor: v1!.price, currency: 'EUR' },
      subtotal: { amount_minor: 2 * v1!.price, currency: 'EUR' },
      discount: { amount_minor: 0, currency: 'EUR' },
      tax: { amount_minor: taxOn(2 * v1!.price, 2100), currency: 'EUR' },
    });
    expect(c.items[0]!.sku).toBeTruthy();
    expect(c.items[0]!.title).toBeTruthy();
    expect(c.items[0]!.thumbnail_url).toMatch(/^https:\/\//);

    // adding the same variant again increases the existing line (UNIQUE cart_id, variant_id)
    c = await addLineItem(a, cart.id, { variant_id: v1!.id, quantity: 1 });
    expect(c.items).toHaveLength(1);
    expect(c.items[0]!.quantity).toBe(3);

    c = await addLineItem(a, cart.id, { variant_id: v2!.id, quantity: 1 });
    expect(c.items).toHaveLength(2);
    const subtotal = 3 * v1!.price + v2!.price;
    const tax = taxOn(3 * v1!.price, 2100) + taxOn(v2!.price, 2100);
    expect(c.totals).toEqual({
      subtotal: { amount_minor: subtotal, currency: 'EUR' },
      discount: { amount_minor: 0, currency: 'EUR' },
      shipping: { amount_minor: 0, currency: 'EUR' },
      tax: { amount_minor: tax, currency: 'EUR' },
      total: { amount_minor: subtotal + tax, currency: 'EUR' },
    });
    for (const item of c.items) {
      expect(item.total.amount_minor).toBe(item.subtotal.amount_minor + item.tax.amount_minor);
      expect(Number.isInteger(item.tax.amount_minor)).toBe(true);
    }

    const line1 = c.items.find((i) => i.variant_id === v1!.id)!;
    c = await updateLineItem(a, cart.id, line1.id, { quantity: 1 });
    expect(c.items.find((i) => i.id === line1.id)!.quantity).toBe(1);
    expect(c.totals.subtotal.amount_minor).toBe(v1!.price + v2!.price);

    c = await removeLineItem(a, cart.id, line1.id);
    expect(c.items.map((i) => i.variant_id)).toEqual([v2!.id]);
    expect(c.totals.subtotal.amount_minor).toBe(v2!.price);

    // the persisted row carries the same numbers the API shows
    const row = await owner.query<{
      subtotal_minor: string;
      tax_minor: string;
      total_minor: string;
    }>(`SELECT subtotal_minor::text, tax_minor::text, total_minor::text FROM cart WHERE id = $1`, [
      cart.id,
    ]);
    expect(row.rows[0]).toEqual({
      subtotal_minor: String(v2!.price),
      tax_minor: String(taxOn(v2!.price, 2100)),
      total_minor: String(v2!.price + taxOn(v2!.price, 2100)),
    });
    await expect(removeLineItem(a, cart.id, line1.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('409 out_of_stock for a tracked, non-backorderable variant beyond its availability', async () => {
    const v = (await variantsA()).find(
      (x) => x.manage_inventory && !x.allow_backorder && x.available > 0 && x.available < 1000,
    )!;
    expect(v).toBeTruthy();
    const cart = await createCart(a, scopeA);
    await expect(
      addLineItem(a, cart.id, { variant_id: v.id, quantity: v.available + 1 }),
    ).rejects.toMatchObject({
      code: 'out_of_stock',
      details: { variant_id: v.id, available: v.available },
    });
    const c = await addLineItem(a, cart.id, { variant_id: v.id, quantity: v.available });
    await expect(
      updateLineItem(a, cart.id, c.items[0]!.id, { quantity: v.available + 1 }),
    ).rejects.toMatchObject({ code: 'out_of_stock' });
    // backorderable → no stock gate
    await owner.query(`UPDATE product_variant SET allow_backorder = true WHERE id = $1`, [v.id]);
    const ok = await updateLineItem(a, cart.id, c.items[0]!.id, { quantity: v.available + 5 });
    expect(ok.items[0]!.quantity).toBe(v.available + 5);
    await owner.query(`UPDATE product_variant SET allow_backorder = false WHERE id = $1`, [v.id]);
  });

  it('400 for an unknown variant, a variant of another store, or a variant without a price in the cart currency', async () => {
    const cart = await createCart(a, scopeA);
    await expect(
      addLineItem(a, cart.id, { variant_id: '00000000-0000-4000-8000-00000000dead', quantity: 1 }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { variant_id: expect.any(String) },
    });
    const other = await owner.query<{ id: string }>(
      `SELECT id FROM product_variant WHERE store_id = $1 LIMIT 1`,
      [B],
    );
    await expect(
      addLineItem(a, cart.id, { variant_id: other.rows[0]!.id, quantity: 1 }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    const [v] = await variantsA();
    await owner.query(`DELETE FROM price WHERE variant_id = $1`, [v!.id]);
    await expect(addLineItem(a, cart.id, { variant_id: v!.id, quantity: 1 })).rejects.toMatchObject(
      {
        code: 'validation_error',
        details: { variant_id: 'not sold in EUR' },
      },
    );
  });
});

describe('updateCart', () => {
  it('sets email, addresses, country, promotion codes (normalised) and replaces metadata whole', async () => {
    const cart = await createCart(a, scopeA, { metadata: { keep: 'no' } });
    const address = {
      first_name: 'Jane',
      last_name: 'Doe',
      line1: 'Keizersgracht 1',
      city: 'Amsterdam',
      postal_code: '1015 CJ',
      country: 'NL',
    };
    const c = await updateCart(a, cart.id, {
      email: 'jane@example.com',
      shipping_address: address,
      billing_address: { ...address, company: 'ACME' },
      country: 'DE',
      promotion_codes: [' SUMMER10 ', 'summer10', '', 'WELCOME'],
      metadata: { replaced: true },
    });
    expect(c).toMatchObject({
      email: 'jane@example.com',
      shipping_address: address,
      billing_address: { ...address, company: 'ACME' },
      country: 'DE',
      promotion_codes: ['SUMMER10', 'WELCOME'],
      metadata: { replaced: true },
    });
    expect(c.totals.discount.amount_minor).toBe(0); // no promotions API yet
    // a PATCH without metadata leaves it alone
    const again = await updateCart(a, cart.id, { email: 'j@example.com' });
    expect(again.metadata).toEqual({ replaced: true });
  });

  it('normalizePromotionCodes trims, drops empties and de-duplicates case-insensitively', () => {
    expect(normalizePromotionCodes([' a ', 'A', 'b', '', '  ', 'B', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('shipping option: priced into totals, refused when not available, dropped when the country changes', async () => {
    const [v] = (await variantsA()).filter((x) => x.available >= 1);
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: v!.id, quantity: 1 });
    const options = await owner.query<{ id: string; code: string; price_minor: string }>(
      `SELECT id, code, price_minor::text FROM shipping_option WHERE store_id = $1 ORDER BY code`,
      [A],
    );
    const express = options.rows.find((o) => o.code === 'express')!;
    const c = await updateCart(a, cart.id, { shipping_option_id: express.id });
    expect(c.shipping_option).toMatchObject({
      id: express.id,
      code: 'express',
      carrier: 'manual',
      price: { amount_minor: Number(express.price_minor), currency: 'EUR' },
    });
    expect(c.totals.shipping.amount_minor).toBe(Number(express.price_minor));
    expect(c.totals.total.amount_minor).toBe(
      c.totals.subtotal.amount_minor + c.totals.tax.amount_minor + Number(express.price_minor),
    );

    // brand-b's option is invisible / not quotable for a brand-a cart
    const foreign = await owner.query<{ id: string }>(
      `SELECT id FROM shipping_option WHERE store_id = $1 LIMIT 1`,
      [B],
    );
    await expect(
      updateCart(a, cart.id, { shipping_option_id: foreign.rows[0]!.id }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { shipping_option_id: expect.any(String) },
    });

    // destination outside the option's countries → selection dropped, shipping back to 0
    const moved = await updateCart(a, cart.id, { country: 'US' });
    expect(moved.shipping_option).toBeNull();
    expect(moved.totals.shipping.amount_minor).toBe(0);
    // ... and US has no tax_rate row for brand-a → 0 tax
    expect(moved.totals.tax.amount_minor).toBe(0);
    expect(moved.items[0]!.tax.amount_minor).toBe(0);
  });

  it('mutations on a completed cart → 409 cart_completed; reads still work', async () => {
    const cart = await createCart(a, scopeA);
    await owner.query(`UPDATE cart SET status = 'completed', completed_at = now() WHERE id = $1`, [
      cart.id,
    ]);
    const [v] = await variantsA();
    for (const attempt of [
      () => updateCart(a, cart.id, { email: 'x@example.com' }),
      () => addLineItem(a, cart.id, { variant_id: v!.id, quantity: 1 }),
      () => updateLineItem(a, cart.id, cart.id, { quantity: 1 }),
      () => removeLineItem(a, cart.id, cart.id),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'cart_completed', status: 409 });
    }
    expect((await getCart(a, cart.id)).status).toBe('completed');
  });
});

describe('scope (RLS)', () => {
  it("store B's client cannot see or touch store A's cart (404, never 403)", async () => {
    const cart = await createCart(a, scopeA);
    await expect(getCart(b, cart.id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(updateCart(b, cart.id, { email: 'x@example.com' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const [v] = await variantsA();
    await expect(addLineItem(b, cart.id, { variant_id: v!.id, quantity: 1 })).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    );
  });
});

describe('pricing providers (seams for windows 7 and 8)', () => {
  it('a replaced TaxCalculator drives the totals; the table calculator is restored afterwards', async () => {
    const flat: TaxCalculator = {
      async calculate(ctx) {
        return {
          lines: ctx.lines.map((l) => ({ lineItemId: l.lineItemId, taxRateBp: 500, taxMinor: 7 })),
          shippingTaxMinor: 3,
        };
      },
    };
    const [v] = (await variantsA()).filter((x) => x.available >= 1);
    const cart = await createCart(a, scopeA);
    expect(setTaxCalculator(flat)).toBe(tableTaxCalculator);
    const c = await addLineItem(a, cart.id, { variant_id: v!.id, quantity: 1 });
    expect(c.totals.tax.amount_minor).toBe(10); // 7 on the line + 3 on shipping
    expect(c.items[0]!.tax.amount_minor).toBe(taxOn(v!.price, 500)); // line display from the persisted rate
    const row = await owner.query<{ tax_rate_bp: number }>(
      `SELECT tax_rate_bp FROM cart_line_item WHERE cart_id = $1`,
      [cart.id],
    );
    expect(row.rows[0]!.tax_rate_bp).toBe(500);
  });

  it('a replaced ShippingRateProvider prices the selected option', async () => {
    const options = await owner.query<{ id: string }>(
      `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
      [A],
    );
    const live: ShippingRateProvider = {
      async list() {
        return [];
      },
      async quote(_ctx, optionId) {
        return {
          optionId,
          code: 'live',
          name: 'Live rate',
          carrier: 'easypost',
          priceMinor: 1234,
          currency: 'EUR',
        };
      },
    };
    const cart = await createCart(a, scopeA);
    setShippingRateProvider(live);
    const c = await updateCart(a, cart.id, { shipping_option_id: options.rows[0]!.id });
    expect(c.totals.shipping.amount_minor).toBe(1234);
    expect(c.totals.total.amount_minor).toBe(1234);
  });

  it('taxOn rounds half-up in integer arithmetic', () => {
    expect(taxOn(1000, 2100)).toBe(210);
    expect(taxOn(1, 2100)).toBe(0); // 0.21 → 0
    expect(taxOn(3, 2100)).toBe(1); // 0.63 → 1
    expect(taxOn(238, 2100)).toBe(50); // 49.98 → 50
    expect(taxOn(0, 2100)).toBe(0);
    expect(taxOn(100, 0)).toBe(0);
  });
});
