// Rate shopping against a real seeded database: the SQL the provider issues, and the proof that a live rate
// survives placement — the option the customer picked is frozen on the order as `shipping_method` with the
// price the carrier quoted, through the cart and checkout modules' public APIs only.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addLineItem,
  createCart,
  setShippingRateProvider,
  tableShippingRates,
  updateCart,
  type ShippingRateProvider,
} from '../cart';
import { completeCart, createPaymentSession, listShippingOptions } from '../checkout';
import { createManualCarrierProvider } from './manual-provider';
import { createCarrierRateProvider, registerCarrierProviders } from './rate-shopping';
import { resetCarrierProviders, setCarrierProvider } from './registry';

const ORG = SEED_IDS.organization;
const actor = { id: null, type: 'customer' as const, requestId: 'req-shipping-2-2' };
const A = SEED_IDS.stores.brandA;
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
let variantId: string;
let standardOptionId: string;
let expressOptionId: string;
let previous: ShippingRateProvider;

beforeAll(async () => {
  db = await createTestDatabase('core_shipping_rates');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
  const vs = await owner.query<{ id: string }>(
    `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
      JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
      WHERE v.store_id = $1
        AND coalesce((SELECT sum(il.available) FROM inventory_level il WHERE il.variant_id = v.id), 0) >= 10
      ORDER BY v.sku LIMIT 1`,
    [A],
  );
  variantId = vs.rows[0]!.id;
  await owner.query(`UPDATE product_variant SET weight_g = 600 WHERE id = $1`, [variantId]);
  const options = await owner.query<{ id: string; code: string }>(
    `SELECT id, code FROM shipping_option WHERE store_id = $1 ORDER BY code`,
    [A],
  );
  standardOptionId = options.rows.find((row) => row.code === 'standard')!.id;
  expressOptionId = options.rows.find((row) => row.code === 'express')!.id;
  // `express` is priced by the carrier; `standard` stays a flat table rate.
  await owner.query(
    `UPDATE shipping_option SET service = 'manual_express', rules = '{"live": true}'::jsonb WHERE id = $1`,
    [expressOptionId],
  );
}, 180_000);

afterAll(async () => {
  setShippingRateProvider(previous ?? tableShippingRates);
  await db?.drop();
});

afterEach(() => {
  resetCarrierProviders();
  setShippingRateProvider(tableShippingRates);
});

/** A brand-a cart with one line of two units (1200 g), an address and an email. */
async function readyCart(optionId: string) {
  const cart = await createCart(a, scopeA);
  await addLineItem(a, cart.id, { variant_id: variantId, quantity: 2 });
  await updateCart(a, cart.id, {
    email: 'jane.doe@example.com',
    shipping_address: address,
    billing_address: address,
    shipping_option_id: optionId,
  });
  return cart.id;
}

describe('rate shopping on a seeded database', () => {
  it('reads the real option, store, warehouse and variant rows and prices the live option', async () => {
    setShippingRateProvider(createCarrierRateProvider());
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: variantId, quantity: 2 });
    await updateCart(a, cart.id, { shipping_address: address });
    const options = await listShippingOptions(a, cart.id);
    // The seeded warehouse is in NL and the destination is NL: the manual carrier's domestic express table
    // gives 1290 + 2 started kg × 200 = 1690; `standard` keeps its flat 499.
    expect(options).toEqual([
      expect.objectContaining({
        id: standardOptionId,
        code: 'standard',
        carrier: 'manual',
        price: { amount_minor: 499, currency: 'EUR' },
      }),
      expect.objectContaining({
        id: expressOptionId,
        code: 'express',
        carrier: 'manual',
        price: { amount_minor: 1690, currency: 'EUR' },
      }),
    ]);
  });

  it('offers nothing for a destination no option covers', async () => {
    setShippingRateProvider(createCarrierRateProvider());
    const cart = await createCart(a, scopeA);
    await updateCart(a, cart.id, { country: 'US' });
    expect(await listShippingOptions(a, cart.id)).toEqual([]);
  });

  it('freezes the live price on the order as shipping_method (through checkout)', async () => {
    setShippingRateProvider(createCarrierRateProvider());
    const cartId = await readyCart(expressOptionId);
    const before = await owner.query<{ shipping_minor: string; total_minor: string }>(
      `SELECT shipping_minor::text, total_minor::text FROM cart WHERE id = $1`,
      [cartId],
    );
    expect(Number(before.rows[0]!.shipping_minor)).toBe(1690);

    await createPaymentSession(a, cartId, { provider: 'manual' });
    const placed = await completeCart(a, { cartId, idempotencyKey: `ship-2-2-${cartId}`, actor });
    const order = await owner.query<{
      shipping_minor: string;
      shipping_method: { code: string; name: string; carrier: string; price_minor: number };
      shipping_option_id: string;
    }>(
      `SELECT shipping_minor::text, shipping_method, shipping_option_id FROM "order" WHERE id = $1`,
      [placed.order.id],
    );
    const row = order.rows[0]!;
    expect(row.shipping_option_id).toBe(expressOptionId);
    expect(Number(row.shipping_minor)).toBe(1690);
    expect(row.shipping_method).toMatchObject({
      code: 'express',
      carrier: 'manual',
      price_minor: 1690,
    });
  });

  it('prices the cart from the table when the carrier is down, and placement still works', async () => {
    const broken = createManualCarrierProvider(undefined, 'manual');
    broken.rates = async () => {
      throw new Error('carrier exploded');
    };
    setCarrierProvider(broken);
    setShippingRateProvider(createCarrierRateProvider({ onFallback: () => {} }));

    const cartId = await readyCart(expressOptionId);
    const cart = await owner.query<{ shipping_minor: string }>(
      `SELECT shipping_minor::text FROM cart WHERE id = $1`,
      [cartId],
    );
    expect(Number(cart.rows[0]!.shipping_minor)).toBe(999); // the seeded flat express price

    await createPaymentSession(a, cartId, { provider: 'manual' });
    const placed = await completeCart(a, {
      cartId,
      idempotencyKey: `ship-2-2-fb-${cartId}`,
      actor,
    });
    const order = await owner.query<{
      shipping_method: { price_minor: number; code: string };
    }>(`SELECT shipping_method FROM "order" WHERE id = $1`, [placed.order.id]);
    expect(order.rows[0]!.shipping_method).toMatchObject({ code: 'express', price_minor: 999 });
  });

  it('applies the free-over-threshold rule to a real cart', async () => {
    await owner.query(
      `UPDATE shipping_option SET rules = '{"free_over_subtotal_minor": 1}'::jsonb WHERE id = $1`,
      [standardOptionId],
    );
    setShippingRateProvider(createCarrierRateProvider());
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: variantId, quantity: 2 });
    await updateCart(a, cart.id, {
      shipping_address: address,
      shipping_option_id: standardOptionId,
    });
    const row = await owner.query<{ shipping_minor: string }>(
      `SELECT shipping_minor::text FROM cart WHERE id = $1`,
      [cart.id],
    );
    expect(Number(row.rows[0]!.shipping_minor)).toBe(0);
    await owner.query(`UPDATE shipping_option SET rules = '{}'::jsonb WHERE id = $1`, [
      standardOptionId,
    ]);
  });

  it('registerCarrierProviders installs the provider and returns the previous one', async () => {
    previous = registerCarrierProviders();
    expect(previous).toBe(tableShippingRates);
    const cart = await createCart(a, scopeA);
    await addLineItem(a, cart.id, { variant_id: variantId, quantity: 2 });
    await updateCart(a, cart.id, { shipping_address: address });
    const options = await listShippingOptions(a, cart.id);
    expect(options.map((option) => option.code)).toEqual(['standard', 'express']);
    setShippingRateProvider(tableShippingRates);
  });
});
