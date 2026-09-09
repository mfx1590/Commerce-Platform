// Checkout module (issue #104) on a fully seeded throwaway database: shipping options, payment session, placement
// as ONE transaction (order + lines + payment + attribution + order.placed + cart completed), idempotency on
// payment.idempotency_key, 402 / 409 / 400 paths, rollback after the outbox insert, concurrent display ids,
// and the order read access rule.
import { createHash } from 'node:crypto';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addLineItem, createCart, updateCart } from '../cart';
import { getStoreOrder } from '../orders';
import {
  completeCart,
  createPaymentSession,
  emailHash,
  listShippingOptions,
  manualPaymentProvider,
  setPaymentProvider,
  type PaymentProvider,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: null, type: 'customer' as const, requestId: 'req-checkout' };
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
let b: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let variants: { id: string; available: number }[];
let standardOptionId: string;

beforeAll(async () => {
  db = await createTestDatabase('core_checkout');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  const channel = await owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
    [A],
  );
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: channel.rows[0]!.id };
  const vs = await owner.query<{ id: string; available: number }>(
    `SELECT v.id, coalesce((SELECT sum(il.available) FROM inventory_level il WHERE il.variant_id = v.id), 0)::int AS available
     FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     WHERE v.store_id = $1 AND v.manage_inventory AND NOT v.allow_backorder ORDER BY v.sku`,
    [A],
  );
  variants = vs.rows.filter((v) => v.available >= 10);
  const opt = await owner.query<{ id: string }>(
    `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
    [A],
  );
  standardOptionId = opt.rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

afterEach(() => {
  setPaymentProvider(manualPaymentProvider);
});

let counter = 0;
/** A brand-a cart with one line, email, addresses, the standard option and a manual payment session. */
async function readyCart(
  opts: { metadata?: Record<string, unknown>; variant?: number; session?: boolean } = {},
) {
  const n = counter++;
  const cart = await createCart(a, scopeA, opts.metadata ? { metadata: opts.metadata } : {});
  await addLineItem(a, cart.id, {
    variant_id: variants[opts.variant ?? n % variants.length]!.id,
    quantity: 2,
  });
  const email = `Jane.Doe+${n}@Example.com`;
  await updateCart(a, cart.id, {
    email,
    shipping_address: address,
    billing_address: { ...address, country: 'NL' },
    shipping_option_id: standardOptionId,
  });
  if (opts.session !== false) await createPaymentSession(a, cart.id, { provider: 'manual' });
  return { id: cart.id, email };
}

const outboxFor = (orderId: string) =>
  owner.query<{ topic: string; payload: Record<string, unknown> }>(
    `SELECT topic, payload FROM outbox WHERE aggregate_id::text = $1::text OR payload->>'order_id' = $1::text ORDER BY occurred_at, topic`,
    [orderId],
  );

describe('shipping options and payment session', () => {
  it('lists the options the ShippingRateProvider quotes for the destination; 404 outside the store', async () => {
    const cart = await createCart(a, scopeA);
    const nl = await listShippingOptions(a, cart.id);
    expect(nl.map((o) => o.code)).toEqual(['standard', 'express']);
    expect(nl[0]).toMatchObject({
      carrier: 'manual',
      price: { amount_minor: 499, currency: 'EUR' },
    });
    await updateCart(a, cart.id, { country: 'US' });
    expect(await listShippingOptions(a, cart.id)).toEqual([]);
    await expect(listShippingOptions(b, cart.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('creates a manual session for the current total and stores it on the cart; unknown provider → 400', async () => {
    const cart = await readyCart({ session: false });
    const session = await createPaymentSession(a, cart.id, { provider: 'manual' });
    expect(session).toMatchObject({ provider: 'manual', client_secret: null, status: 'pending' });
    expect(session.session_id).toMatch(/^man_/);
    const row = await owner.query<{ payment_session: unknown; total_minor: string }>(
      `SELECT payment_session, total_minor::text FROM cart WHERE id = $1`,
      [cart.id],
    );
    expect(row.rows[0]!.payment_session).toEqual(session);
    expect(session.amount).toEqual({
      amount_minor: Number(row.rows[0]!.total_minor),
      currency: 'EUR',
    });
    await expect(createPaymentSession(a, cart.id, { provider: 'paypal' })).rejects.toMatchObject({
      code: 'validation_error',
      details: { provider: 'one of manual' },
    });
  });
});

describe('completeCart — one transaction', () => {
  it('writes order, lines, payment, attribution and order.placed; copies metadata; completes the cart', async () => {
    const meta = {
      attribution: {
        first: { utm_source: 'google', utm_medium: 'cpc', at: '2026-09-01T10:00:00.000Z' },
        last: { utm_source: 'newsletter', utm_medium: 'email', at: '2026-09-07T09:00:00.000Z' },
      },
      ab: 'B',
    };
    const cart = await readyCart({ metadata: meta });
    const { order, replayed } = await completeCart(a, {
      cartId: cart.id,
      idempotencyKey: `key-${cart.id}`,
      actor,
    });
    expect(replayed).toBe(false);
    expect(order).toMatchObject({
      status: 'pending',
      payment_status: 'authorized',
      fulfillment_status: 'unfulfilled',
      email: cart.email.trim(),
      currency: 'EUR',
      metadata: meta,
      shipping_method: {
        id: standardOptionId,
        code: 'standard',
        price: { amount_minor: 499, currency: 'EUR' },
      },
      shipments: [],
    });
    expect(order.display_id).toBeGreaterThanOrEqual(1000);
    expect(order.items).toHaveLength(1);
    const line = order.items[0]!;
    expect(line.total.amount_minor).toBe(
      line.subtotal.amount_minor - line.discount.amount_minor + line.tax.amount_minor,
    );
    expect(order.totals.total.amount_minor).toBe(
      order.totals.subtotal.amount_minor +
        order.totals.shipping.amount_minor +
        order.totals.tax.amount_minor,
    );

    const cartRow = await owner.query<{
      status: string;
      order_id: string;
      payment_session: { status: string };
    }>(`SELECT status, order_id, payment_session FROM cart WHERE id = $1`, [cart.id]);
    expect(cartRow.rows[0]).toMatchObject({ status: 'completed', order_id: order.id });
    expect(cartRow.rows[0]!.payment_session.status).toBe('authorized');

    const payment = await owner.query<{
      provider: string;
      status: string;
      idempotency_key: string;
      amount_minor: string;
    }>(
      `SELECT provider, status, idempotency_key, amount_minor::text FROM payment WHERE order_id = $1`,
      [order.id],
    );
    expect(payment.rows).toHaveLength(1);
    expect(payment.rows[0]).toMatchObject({
      provider: 'manual',
      status: 'authorized',
      idempotency_key: `${A}:key-${cart.id}`, // stored per store
      amount_minor: String(order.totals.total.amount_minor),
    });

    const attribution = await owner.query<{ touch: string }>(
      `SELECT touch FROM attribution WHERE order_id = $1 ORDER BY touch`,
      [order.id],
    );
    expect(attribution.rows.map((r) => r.touch)).toEqual(['first', 'last']);

    const events = await outboxFor(order.id);
    expect(events.rows.map((e) => e.topic).sort()).toEqual([
      'attribution.recorded',
      'attribution.recorded',
      'order.placed',
      'payment.authorized', // #176 (window 7): the payment row's baseline event, same transaction
    ]);
    const authorized = events.rows.find((e) => e.topic === 'payment.authorized')!.payload;
    expect(authorized).toMatchObject({
      order_id: order.id,
      legal_entity_id: SEED_IDS.legalEntities.brandA,
      provider: 'manual',
      amount_minor: order.totals.total.amount_minor,
      currency: 'EUR',
    });
    expect(String(authorized.provider_payment_id)).toMatch(/^manpay_/);
    const placed = events.rows.find((e) => e.topic === 'order.placed')!.payload;
    expect(placed).toMatchObject({
      order_id: order.id,
      display_id: order.display_id,
      legal_entity_id: SEED_IDS.legalEntities.brandA,
      sales_channel_id: scopeA.salesChannelId,
      customer_id: null,
      email_hash: createHash('sha256').update(cart.email.trim().toLowerCase()).digest('hex'),
      currency: 'EUR',
      shipping: {
        shipping_option_id: standardOptionId,
        code: 'standard',
        carrier: 'manual',
        price_minor: 499,
      },
      shipping_country: 'NL',
      billing_country: 'NL',
      promotion_codes: [],
    });
    expect((placed.line_items as unknown[]).length).toBe(1);
    expect((placed.line_items as { order_line_item_id: string }[])[0]!.order_line_item_id).toBe(
      line.id,
    );
    // no PII: neither the raw email nor the address leaves through the event
    const serialized = JSON.stringify(placed).toLowerCase();
    expect(serialized).not.toContain('jane.doe');
    expect(serialized).not.toContain('keizersgracht');
    expect(emailHash(' JANE.doe+1@example.com ')).toBe(emailHash('jane.doe+1@example.com'));
  });

  it('idempotency: same key → the stored order, provider called once; another key → 409 cart_completed', async () => {
    let authorizeCalls = 0;
    const counting: PaymentProvider = {
      ...manualPaymentProvider,
      async authorize(input) {
        authorizeCalls++;
        return manualPaymentProvider.authorize(input);
      },
    };
    setPaymentProvider(counting);
    const cart = await readyCart();
    const key = `key-replay-${cart.id}`;
    const first = await completeCart(a, { cartId: cart.id, idempotencyKey: key, actor });
    const second = await completeCart(a, { cartId: cart.id, idempotencyKey: key, actor });
    expect(second.replayed).toBe(true);
    expect(second.order).toEqual(first.order);
    expect(authorizeCalls).toBe(1);
    const orders = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "order" WHERE cart_id = $1`,
      [cart.id],
    );
    expect(orders.rows[0]!.n).toBe('1');
    expect(
      (await outboxFor(first.order.id)).rows.filter((e) => e.topic === 'order.placed'),
    ).toHaveLength(1);

    await expect(
      completeCart(a, { cartId: cart.id, idempotencyKey: `${key}-other`, actor }),
    ).rejects.toMatchObject({
      code: 'cart_completed',
      status: 409,
      details: { order_id: first.order.id },
    });

    // the same key on a DIFFERENT cart is a conflict, never someone else's order
    const other = await readyCart();
    await expect(
      completeCart(a, { cartId: other.id, idempotencyKey: key, actor }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('402 payment_failed when the provider refuses: nothing is written, the cart stays active', async () => {
    setPaymentProvider({
      ...manualPaymentProvider,
      async authorize() {
        return { status: 'failed', providerPaymentId: null, failureReason: 'Card declined' };
      },
    });
    const cart = await readyCart();
    const before = await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox`);
    await expect(
      completeCart(a, { cartId: cart.id, idempotencyKey: `key-fail-${cart.id}`, actor }),
    ).rejects.toMatchObject({
      code: 'payment_failed',
      status: 402,
      message: 'Card declined',
    });
    const after = await owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(
      (await owner.query(`SELECT 1 FROM "order" WHERE cart_id = $1`, [cart.id])).rows,
    ).toHaveLength(0);
    expect(
      (
        await owner.query(`SELECT 1 FROM payment WHERE idempotency_key = $1`, [
          `key-fail-${cart.id}`,
        ])
      ).rows,
    ).toHaveLength(0);
    const row = await owner.query<{ status: string }>(`SELECT status FROM cart WHERE id = $1`, [
      cart.id,
    ]);
    expect(row.rows[0]!.status).toBe('active');
  });

  it('rollback: a failure after the outbox insert leaves no order, no payment, no attribution, no event, cart active', async () => {
    const cart = await readyCart({
      metadata: { attribution: { first: { utm_source: 'x' }, last: { utm_source: 'y' } } },
    });
    const count = async (sql: string, params: unknown[] = []) =>
      Number(
        (await owner.query<{ n: string }>(`SELECT count(*)::text AS n ${sql}`, params)).rows[0]!.n,
      );
    const outboxBefore = await count('FROM outbox');
    const attributionBefore = await count('FROM attribution');
    await expect(
      completeCart(a, {
        cartId: cart.id,
        idempotencyKey: `key-rollback-${cart.id}`,
        actor,
        hooks: {
          afterEvents: async () => {
            throw new Error('boom after events');
          },
        },
      }),
    ).rejects.toThrow('boom after events');
    expect(await count('FROM "order" WHERE cart_id = $1', [cart.id])).toBe(0);
    expect(
      await count('FROM payment WHERE idempotency_key = $1', [`key-rollback-${cart.id}`]),
    ).toBe(0);
    expect(await count('FROM attribution')).toBe(attributionBefore);
    expect(await count('FROM outbox')).toBe(outboxBefore);
    expect(
      await count(`FROM cart WHERE id = $1 AND status = 'active' AND order_id IS NULL`, [cart.id]),
    ).toBe(1);
  });

  it('400 when the cart is not ready; 409 out_of_stock when stock vanished since the add', async () => {
    const empty = await createCart(a, scopeA);
    await expect(
      completeCart(a, { cartId: empty.id, idempotencyKey: 'not-ready-1', actor }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: {
        items: 'cart is empty',
        email: 'required',
        shipping_address: 'required',
        billing_address: 'required',
        shipping_option_id: 'required',
        payment_session: expect.any(String),
      },
    });
    const idx = variants.length - 1;
    const cart = await readyCart({ variant: idx });
    await owner.query(`UPDATE inventory_level SET on_hand = 0 WHERE variant_id = $1`, [
      variants[idx]!.id,
    ]);
    await expect(
      completeCart(a, { cartId: cart.id, idempotencyKey: `key-oos-${cart.id}`, actor }),
    ).rejects.toMatchObject({
      code: 'out_of_stock',
      details: { variant_id: variants[idx]!.id, available: 0 },
    });
    expect(
      (await owner.query(`SELECT 1 FROM "order" WHERE cart_id = $1`, [cart.id])).rows,
    ).toHaveLength(0);
  });

  it('concurrent placements on one store get distinct, consecutive display ids', async () => {
    const carts = await Promise.all(Array.from({ length: 8 }, () => readyCart()));
    const results = await Promise.all(
      carts.map((c) =>
        completeCart(a, { cartId: c.id, idempotencyKey: `key-conc-${c.id}`, actor }),
      ),
    );
    const ids = results.map((r) => r.order.display_id).sort((x, y) => x - y);
    expect(new Set(ids).size).toBe(8);
    expect(ids[7]! - ids[0]!).toBe(7);
    // ... and never collide with the store's next number
    const next = await owner.query<{ next_order_number: string }>(
      `SELECT next_order_number::text FROM store WHERE id = $1`,
      [A],
    );
    expect(Number(next.rows[0]!.next_order_number)).toBe(ids[7]! + 1);
  });

  it('RLS: store B cannot complete or read store A carts/orders', async () => {
    const cart = await readyCart();
    await expect(
      completeCart(b, { cartId: cart.id, idempotencyKey: `key-b-${cart.id}`, actor }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    const { order } = await completeCart(a, {
      cartId: cart.id,
      idempotencyKey: `key-a-${cart.id}`,
      actor,
    });
    await expect(getStoreOrder(b, order.id, { email: cart.email })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('idempotency is per store (RLS on payment rows)', () => {
  it('the same Idempotency-Key used by store B places a separate order for store B', async () => {
    const cart = await readyCart();
    const key = `shared-key-${cart.id}`;
    const { order } = await completeCart(a, { cartId: cart.id, idempotencyKey: key, actor });
    // a brand-b cart, readied through the module on store B's client
    const scopeB = { organizationId: ORG, storeId: B, salesChannelId: null };
    const cartB = await createCart(b, scopeB);
    const vB = await owner.query<{ id: string }>(
      `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
       JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'GBP' AND pr.min_quantity = 1
       JOIN inventory_level il ON il.variant_id = v.id AND il.available >= 5
       WHERE v.store_id = $1 ORDER BY v.sku LIMIT 1`,
      [B],
    );
    await addLineItem(b, cartB.id, { variant_id: vB.rows[0]!.id, quantity: 1 });
    const optB = await owner.query<{ id: string }>(
      `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
      [B],
    );
    await updateCart(b, cartB.id, {
      email: 'b.customer@example.com',
      shipping_address: { ...address, country: 'GB' },
      billing_address: { ...address, country: 'GB' },
      country: 'GB',
      shipping_option_id: optB.rows[0]!.id,
    });
    await createPaymentSession(b, cartB.id, { provider: 'manual' });
    const placedB = await completeCart(b, { cartId: cartB.id, idempotencyKey: key, actor });
    expect(placedB.replayed).toBe(false);
    expect(placedB.order.id).not.toBe(order.id);
    expect(placedB.order.currency).toBe('GBP');
    // and store A's replay still returns store A's order
    const again = await completeCart(a, { cartId: cart.id, idempotencyKey: key, actor });
    expect(again).toMatchObject({ replayed: true, order: { id: order.id } });
  });
});

describe('getStoreOrder access rule (200 or 404, nothing else)', () => {
  it('guest email trimmed + case-insensitive; customer by id or by matching email; otherwise 404', async () => {
    const cart = await readyCart();
    const { order } = await completeCart(a, {
      cartId: cart.id,
      idempotencyKey: `key-read-${cart.id}`,
      actor,
    });

    expect(
      (await getStoreOrder(a, order.id, { email: `  ${cart.email.toUpperCase()}  ` })).id,
    ).toBe(order.id);
    await expect(
      getStoreOrder(a, order.id, { email: 'someone.else@example.com' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(getStoreOrder(a, order.id, {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(getStoreOrder(a, order.id, { email: '' })).rejects.toMatchObject({
      code: 'not_found',
    });

    const sameEmail = await owner.query<{ id: string }>(
      `INSERT INTO customer (organization_id, store_id, keycloak_subject, email, status)
       VALUES ($1, $2, 'kc-sub-same', $3, 'registered') RETURNING id`,
      [ORG, A, cart.email.toLowerCase()],
    );
    const otherCustomer = await owner.query<{ id: string }>(
      `INSERT INTO customer (organization_id, store_id, keycloak_subject, email, status)
       VALUES ($1, $2, 'kc-sub-other', 'other@example.com', 'registered') RETURNING id`,
      [ORG, A],
    );
    expect((await getStoreOrder(a, order.id, { customerId: sameEmail.rows[0]!.id })).id).toBe(
      order.id,
    );
    await expect(
      getStoreOrder(a, order.id, { customerId: otherCustomer.rows[0]!.id }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    // an order placed for a customer id is readable by that id even with another email on the order
    await owner.query(`UPDATE "order" SET customer_id = $2 WHERE id = $1`, [
      order.id,
      otherCustomer.rows[0]!.id,
    ]);
    expect((await getStoreOrder(a, order.id, { customerId: otherCustomer.rows[0]!.id })).id).toBe(
      order.id,
    );
  });
});
