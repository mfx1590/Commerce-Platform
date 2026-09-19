// Store API routes (issue #6): the exact chain src/server.ts mounts (middleware + Store API routes) on a bare
// Express app over a fully seeded throwaway database. Responses are validated against the frozen OpenAPI
// components, and the Store API requests of packages/contracts/test/contract.test.ts are replayed.
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DevTokenVerifier } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const KEY_A = SEED_IDS.publishableKeys.brandA;
const KEY_B = SEED_IDS.publishableKeys.brandB;
const spec = specValidator('store-api.yaml');

let db: TestDatabase;
let app: express.Express;
let owner: ReturnType<typeof createOrganizationClient>;

const asA = (path: string) => request(app).get(path).set('X-Publishable-Key', KEY_A);

beforeAll(async () => {
  db = await createTestDatabase('core_store_api');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: SEED_IDS.organization });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = SEED_IDS.organization;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier()); // includes the Store API routes
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('contract replay (packages/contracts/test/contract.test.ts, Store API part)', () => {
  it('refuses requests without the publishable key', async () => {
    const res = await request(app).get('/store');
    expect(res.status).toBe(401);
    spec.assertSchema('Error', res.body);
    expect(res.body.code).toBe('unauthorized');
  });

  it('GET /store returns the seeded brand-a store', async () => {
    const res = await asA('/store');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('brand-a');
    expect(res.body.id).toBe(SEED_IDS.stores.brandA);
    spec.assertSchema('Store', res.body);
    expect(res.body).toMatchObject({
      default_currency: 'EUR',
      currencies: ['EUR'],
      locales: ['en-GB', 'de-DE'],
      sales_channel: { code: 'web', type: 'web' },
    });
  });

  it('GET /store/products and /store/products/{handle} conform to their schemas', async () => {
    const list = await asA('/store/products?limit=24');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    spec.assertPage('ProductSummary', list.body);
    expect(list.body).toMatchObject({ page: 1, limit: 24, total: 200 });
    expect(list.body.items).toHaveLength(24);

    // The mock's example handle (classic-tee) is not in the seed; replay with a real one.
    const handle = list.body.items[0].handle as string;
    const one = await asA(`/store/products/${handle}`);
    expect(one.status).toBe(200);
    expect(one.body.handle).toBe(handle);
    spec.assertSchema('Product', one.body);
    const variants = one.body.variants as Array<{
      price: { amount_minor: number; currency: string };
    }>;
    expect(variants[0]?.price).toEqual({
      amount_minor: list.body.items[0].price.amount_minor,
      currency: 'EUR',
    });
  });
});

describe('Store API routes', () => {
  it('GET /store/categories lists active categories as a flat tree', async () => {
    const res = await asA('/store/categories');
    expect(res.status).toBe(200);
    spec.assertItems('Category', res.body);
    const handles = res.body.items.map((c: { handle: string }) => c.handle);
    expect(handles).toEqual(expect.arrayContaining(['tops', 't-shirts', 'bags']));
  });

  it('list query params: category includes children, tag, sort, pagination', async () => {
    const tops = await asA('/store/products?category=tops&limit=1');
    const tees = await asA('/store/products?category=t-shirts&limit=1');
    const hoodies = await asA('/store/products?category=hoodies&limit=1');
    expect(tops.body.total).toBe(tees.body.total + hoodies.body.total);

    const asc = await asA('/store/products?sort=price_asc&limit=3');
    const prices = asc.body.items.map(
      (i: { price: { amount_minor: number } }) => i.price.amount_minor,
    );
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);

    const page2 = await asA('/store/products?page=2&limit=10');
    expect(page2.body).toMatchObject({ page: 2, limit: 10, total: 200 });
    expect(page2.body.items).toHaveLength(10);

    const tagged = await asA('/store/products?tag=jeans&limit=2');
    expect(tagged.body.total).toBeGreaterThan(0);
    spec.assertPage('ProductSummary', tagged.body);
  });

  it('invalid query params → 400 validation_error with details', async () => {
    const res = await asA('/store/products?limit=0&sort=cheapest&page=x');
    expect(res.status).toBe(400);
    spec.assertSchema('Error', res.body);
    expect(res.body).toMatchObject({
      code: 'validation_error',
      details: {
        limit: 'integer between 1 and 100',
        page: 'integer >= 1',
        sort: 'one of relevance, price_asc, price_desc, newest',
      },
    });
  });

  it("404 for a handle from another store (brand-b's product with brand-a's key)", async () => {
    const b = await request(app).get('/store/products?limit=1').set('X-Publishable-Key', KEY_B);
    expect(b.status).toBe(200);
    const bHandle = b.body.items[0].handle as string;
    const asAOnB = await asA(`/store/products/${bHandle}`);
    // The same handle may legitimately exist in brand-a (deterministic seed); only assert when it does not.
    if (asAOnB.status === 200) {
      expect(asAOnB.body.id).not.toBe(b.body.items[0].id);
    } else {
      expect(asAOnB.status).toBe(404);
      spec.assertSchema('Error', asAOnB.body);
      expect(asAOnB.body.code).toBe('not_found');
    }
    const missing = await asA('/store/products/definitely-not-a-handle');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      code: 'not_found',
      message: 'product definitely-not-a-handle not found',
    });
  });

  it('prices are in the store default currency: brand-b answers in GBP', async () => {
    const res = await request(app).get('/store/products?limit=2').set('X-Publishable-Key', KEY_B);
    expect(res.status).toBe(200);
    for (const item of res.body.items) expect(item.price.currency).toBe('GBP');
    const store = await request(app).get('/store').set('X-Publishable-Key', KEY_B);
    expect(store.body).toMatchObject({ code: 'brand-b', default_currency: 'GBP' });
  });
});

describe('Store API 0.3.0 `currency` query (products)', () => {
  const A = SEED_IDS.stores.brandA;
  let usdHandles: string[] = [];

  beforeAll(async () => {
    // Test-database-only fixture: brand-a also sells USD, with prices for the variants of five products.
    await owner.query(
      `INSERT INTO store_currency (organization_id, store_id, currency, is_default) VALUES ($1, $2, 'USD', false)`,
      [SEED_IDS.organization, A],
    );
    const list = await owner.query<{ id: string }>(
      `INSERT INTO price_list (organization_id, store_id, code, name, type, currency, status)
       VALUES ($1, $2, 'default-usd', 'Default USD', 'default', 'USD', 'active') RETURNING id`,
      [SEED_IDS.organization, A],
    );
    const products = await owner.query<{ id: string; handle: string }>(
      `SELECT id, handle FROM product WHERE store_id = $1 AND status = 'published' ORDER BY handle LIMIT 5`,
      [A],
    );
    usdHandles = products.rows.map((p) => p.handle);
    await owner.query(
      `INSERT INTO price (organization_id, store_id, price_list_id, variant_id, currency, amount_minor, compare_at_minor)
       SELECT $1, $2, $3, v.id, 'USD', pr.amount_minor * 11 / 10, NULL
       FROM product_variant v
       JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
       WHERE v.product_id = ANY($4)`,
      [SEED_IDS.organization, A, list.rows[0]!.id, products.rows.map((p) => p.id)],
    );
  });

  it('GET /store now lists both currencies; the default stays EUR', async () => {
    const res = await asA('/store');
    expect(res.body).toMatchObject({ default_currency: 'EUR', currencies: ['EUR', 'USD'] });
    const list = await asA('/store/products?limit=2');
    for (const item of list.body.items) expect(item.price.currency).toBe('EUR');
  });

  it('?currency=USD switches prices and lists only products priced in USD', async () => {
    const list = await asA('/store/products?currency=USD&limit=24');
    expect(list.status).toBe(200);
    spec.assertPage('ProductSummary', list.body);
    expect(list.body.total).toBe(5);
    expect(list.body.items.map((i: { handle: string }) => i.handle).sort()).toEqual(
      [...usdHandles].sort(),
    );
    for (const item of list.body.items) expect(item.price.currency).toBe('USD');

    const handle = usdHandles[0]!;
    const eur = await asA(`/store/products/${handle}`);
    const usd = await asA(`/store/products/${handle}?currency=USD`);
    expect(usd.status).toBe(200);
    spec.assertSchema('Product', usd.body);
    expect(usd.body.variants.length).toBe(eur.body.variants.length);
    for (let i = 0; i < usd.body.variants.length; i++) {
      expect(usd.body.variants[i].price).toEqual({
        amount_minor: Math.floor((eur.body.variants[i].price.amount_minor * 11) / 10),
        currency: 'USD',
      });
    }
    // a product without a USD price is a 200 in EUR but "not sold" in USD → 404 (#157 review nit)
    const other = await asA('/store/products?limit=1&page=9');
    const unpriced = other.body.items[0].handle as string;
    expect(usdHandles).not.toContain(unpriced);
    const u = await asA(`/store/products/${unpriced}?currency=USD`);
    expect(u.status).toBe(404);
    spec.assertSchema('Error', u.body);
    expect(u.body.code).toBe('not_found');
    expect((await asA(`/store/products/${unpriced}`)).status).toBe(200);
  });

  it('an unsupported or malformed currency → 400 validation_error', async () => {
    const chf = await asA('/store/products?currency=CHF');
    expect(chf.status).toBe(400);
    spec.assertSchema('Error', chf.body);
    expect(chf.body).toMatchObject({
      code: 'validation_error',
      details: { currency: 'one of EUR, USD' },
    });
    const bad = await asA('/store/products/anything?currency=eur');
    expect(bad.status).toBe(400);
    expect(bad.body.details).toEqual({ currency: 'ISO 4217 code, e.g. EUR' });
    // brand-b never sells USD
    const b = await request(app)
      .get('/store/products?currency=USD')
      .set('X-Publishable-Key', KEY_B);
    expect(b.status).toBe(400);
    expect(b.body.details).toEqual({ currency: 'one of GBP' });
  });
});

describe('cart routes (contract replay, task 2.1)', () => {
  const json = (method: 'post' | 'patch', path: string, key = KEY_A) =>
    request(app)
      [method](path)
      .set('X-Publishable-Key', key)
      .set('Content-Type', 'application/json');

  async function firstVariant(): Promise<{ id: string; price: number }> {
    const list = await asA('/store/products?limit=1&sort=price_asc');
    const product = await asA(`/store/products/${list.body.items[0].handle}`);
    const v = product.body.variants.find((x: { in_stock: boolean }) => x.in_stock);
    return { id: v.id, price: v.price.amount_minor };
  }

  it('POST /store/carts without a body → 201 CartEmpty-shaped cart; metadata round-trips', async () => {
    const empty = await request(app).post('/store/carts').set('X-Publishable-Key', KEY_A);
    expect(empty.status).toBe(201);
    spec.assertSchema('Cart', empty.body);
    expect(empty.body).toMatchObject({
      status: 'active',
      currency: 'EUR',
      country: 'NL',
      items: [],
    });

    const meta = { attribution: { first: { source: 'google', medium: 'cpc' } }, ab: 'B' };
    const withMeta = await json('post', '/store/carts').send({ country: 'DE', metadata: meta });
    expect(withMeta.status).toBe(201);
    spec.assertSchema('Cart', withMeta.body);
    expect(withMeta.body).toMatchObject({ country: 'DE', metadata: meta });
    const got = await asA(`/store/carts/${withMeta.body.id}`);
    expect(got.status).toBe(200);
    spec.assertSchema('Cart', got.body);
    expect(got.body.metadata).toEqual(meta);
  });

  it('request bodies are validated against store-api.yaml (400 with per-field details)', async () => {
    const bad = await json('post', '/store/carts').send({ currency: 'eur', country: 'NLD' });
    expect(bad.status).toBe(400);
    spec.assertSchema('Error', bad.body);
    expect(bad.body.code).toBe('validation_error');
    expect(Object.keys(bad.body.details).sort()).toEqual(['country', 'currency']);

    const usd = await json('post', '/store/carts').send({ currency: 'USD' });
    expect(usd.status).toBe(201); // the fixture above enabled USD for brand-a
    expect(usd.body.currency).toBe('USD');
    const chf = await json('post', '/store/carts').send({ currency: 'CHF' });
    expect(chf.status).toBe(400);
    expect(chf.body.details).toEqual({ currency: 'one of EUR, USD' });

    const malformed = await json('post', '/store/carts').send('{not json');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('validation_error');
    const notUuid = await asA('/store/carts/not-a-uuid');
    expect(notUuid.status).toBe(400);
    expect(notUuid.body.details).toEqual({ cartId: 'uuid' });
  });

  it('line items: add, update, remove; totals recomputed; 409 out_of_stock; 404 unknown line', async () => {
    const cart = (await request(app).post('/store/carts').set('X-Publishable-Key', KEY_A)).body;
    const v = await firstVariant();

    const added = await json('post', `/store/carts/${cart.id}/line-items`).send({
      variant_id: v.id,
      quantity: 2,
    });
    expect(added.status).toBe(200);
    spec.assertSchema('Cart', added.body);
    expect(added.body.items).toHaveLength(1);
    expect(added.body.items[0]).toMatchObject({
      variant_id: v.id,
      quantity: 2,
      unit_price: { amount_minor: v.price, currency: 'EUR' },
    });
    expect(added.body.totals.subtotal.amount_minor).toBe(2 * v.price);
    expect(added.body.totals.total.amount_minor).toBe(
      added.body.totals.subtotal.amount_minor + added.body.totals.tax.amount_minor,
    );

    const lineId = added.body.items[0].id as string;
    const updated = await json('patch', `/store/carts/${cart.id}/line-items/${lineId}`).send({
      quantity: 1,
    });
    expect(updated.status).toBe(200);
    spec.assertSchema('Cart', updated.body);
    expect(updated.body.totals.subtotal.amount_minor).toBe(v.price);

    const zero = await json('patch', `/store/carts/${cart.id}/line-items/${lineId}`).send({
      quantity: 0,
    });
    expect(zero.status).toBe(400);
    expect(zero.body.code).toBe('validation_error');

    const tooMany = await json('post', `/store/carts/${cart.id}/line-items`).send({
      variant_id: v.id,
      quantity: 100000,
    });
    expect(tooMany.status).toBe(409);
    spec.assertSchema('Error', tooMany.body);
    expect(tooMany.body).toMatchObject({
      code: 'out_of_stock',
      details: { variant_id: v.id, available: expect.any(Number) },
    });

    const removed = await request(app)
      .delete(`/store/carts/${cart.id}/line-items/${lineId}`)
      .set('X-Publishable-Key', KEY_A);
    expect(removed.status).toBe(200);
    spec.assertSchema('Cart', removed.body);
    expect(removed.body.items).toEqual([]);
    expect(removed.body.totals.total.amount_minor).toBe(0);

    const gone = await request(app)
      .delete(`/store/carts/${cart.id}/line-items/${lineId}`)
      .set('X-Publishable-Key', KEY_A);
    expect(gone.status).toBe(404);
    spec.assertSchema('Error', gone.body);
  });

  it('PATCH /store/carts/{cartId}: email, addresses, shipping option, promotion codes, country', async () => {
    const cart = (await request(app).post('/store/carts').set('X-Publishable-Key', KEY_A)).body;
    const v = await firstVariant();
    await json('post', `/store/carts/${cart.id}/line-items`).send({
      variant_id: v.id,
      quantity: 1,
    });
    const options = await owner.query<{ id: string; price_minor: string }>(
      `SELECT id, price_minor::text FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
      [SEED_IDS.stores.brandA],
    );
    const address = {
      first_name: 'Jane',
      last_name: 'Doe',
      line1: 'Keizersgracht 1',
      city: 'Amsterdam',
      postal_code: '1015 CJ',
      country: 'NL',
    };
    const res = await json('patch', `/store/carts/${cart.id}`).send({
      email: 'jane@example.com',
      shipping_address: address,
      billing_address: address,
      shipping_option_id: options.rows[0]!.id,
      promotion_codes: ['SUMMER10', 'summer10'],
    });
    expect(res.status).toBe(200);
    spec.assertSchema('Cart', res.body);
    expect(res.body).toMatchObject({
      email: 'jane@example.com',
      shipping_address: address,
      promotion_codes: ['SUMMER10'],
      shipping_option: { id: options.rows[0]!.id, code: 'standard' },
    });
    expect(res.body.totals.shipping.amount_minor).toBe(Number(options.rows[0]!.price_minor));
    expect(res.body.totals.total.amount_minor).toBe(
      res.body.totals.subtotal.amount_minor +
        res.body.totals.tax.amount_minor +
        res.body.totals.shipping.amount_minor,
    );

    const badEmail = await json('patch', `/store/carts/${cart.id}`).send({ email: 'nope' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.details).toHaveProperty('email');
  });

  it("RLS: brand-b's key gets 404 (not 403) for brand-a's cart on every operation", async () => {
    const cart = (await request(app).post('/store/carts').set('X-Publishable-Key', KEY_A)).body;
    const v = await firstVariant();
    const asB = (p: string) => request(app).get(p).set('X-Publishable-Key', KEY_B);
    const get = await asB(`/store/carts/${cart.id}`);
    expect(get.status).toBe(404);
    spec.assertSchema('Error', get.body);
    expect(get.body.code).toBe('not_found');
    const patch = await json('patch', `/store/carts/${cart.id}`, KEY_B).send({
      email: 'x@example.com',
    });
    expect(patch.status).toBe(404);
    const add = await json('post', `/store/carts/${cart.id}/line-items`, KEY_B).send({
      variant_id: v.id,
      quantity: 1,
    });
    expect(add.status).toBe(404);
    const del = await request(app)
      .delete(`/store/carts/${cart.id}/line-items/${cart.id}`)
      .set('X-Publishable-Key', KEY_B);
    expect(del.status).toBe(404);
  });

  it('a completed cart refuses mutations with 409 cart_completed', async () => {
    const cart = (await request(app).post('/store/carts').set('X-Publishable-Key', KEY_A)).body;
    await owner.query(`UPDATE cart SET status = 'completed' WHERE id = $1`, [cart.id]);
    const res = await json('patch', `/store/carts/${cart.id}`).send({ email: 'x@example.com' });
    expect(res.status).toBe(409);
    spec.assertSchema('Error', res.body);
    expect(res.body).toMatchObject({ code: 'cart_completed', details: { cart_id: cart.id } });
  });
});

describe('checkout routes (contract replay, task 2.2)', () => {
  const json = (method: 'post' | 'patch', path: string, key = KEY_A) =>
    request(app)
      [method](path)
      .set('X-Publishable-Key', key)
      .set('Content-Type', 'application/json');
  const address = {
    first_name: 'Jane',
    last_name: 'Doe',
    line1: 'Keizersgracht 1',
    city: 'Amsterdam',
    postal_code: '1015 CJ',
    country: 'NL',
  };

  /** A brand-a cart with one in-stock line, email, addresses and the standard shipping option. */
  async function readyCart(
    metadata?: Record<string, unknown>,
  ): Promise<{ id: string; email: string }> {
    const created = await json('post', '/store/carts').send(metadata ? { metadata } : {});
    const list = await asA('/store/products?limit=1&sort=price_asc');
    const product = await asA(`/store/products/${list.body.items[0].handle}`);
    const v = product.body.variants.find((x: { in_stock: boolean }) => x.in_stock);
    await json('post', `/store/carts/${created.body.id}/line-items`).send({
      variant_id: v.id,
      quantity: 1,
    });
    const options = await asA(`/store/carts/${created.body.id}/shipping-options`);
    const email = `Jane.Doe+${created.body.id.slice(0, 8)}@Example.com`;
    await json('patch', `/store/carts/${created.body.id}`).send({
      email,
      shipping_address: address,
      billing_address: address,
      shipping_option_id: options.body.items[0].id,
    });
    return { id: created.body.id, email };
  }

  it('GET /store/carts/{cartId}/shipping-options lists the options for the destination', async () => {
    const cart = (await request(app).post('/store/carts').set('X-Publishable-Key', KEY_A)).body;
    const res = await asA(`/store/carts/${cart.id}/shipping-options`);
    expect(res.status).toBe(200);
    spec.assertItems('ShippingOption', res.body);
    expect(res.body.items.map((o: { code: string }) => o.code)).toEqual(['standard', 'express']);
    await json('patch', `/store/carts/${cart.id}`).send({ country: 'US' });
    expect((await asA(`/store/carts/${cart.id}/shipping-options`)).body.items).toEqual([]);
    const foreign = await request(app)
      .get(`/store/carts/${cart.id}/shipping-options`)
      .set('X-Publishable-Key', KEY_B);
    expect(foreign.status).toBe(404);
  });

  it('POST /store/carts/{cartId}/payment-session with the manual provider', async () => {
    const cart = await readyCart();
    const res = await json('post', `/store/carts/${cart.id}/payment-session`).send({
      provider: 'manual',
    });
    expect(res.status).toBe(200);
    spec.assertSchema('PaymentSession', res.body);
    const current = await asA(`/store/carts/${cart.id}`);
    expect(res.body).toMatchObject({
      provider: 'manual',
      client_secret: null,
      status: 'pending',
      amount: current.body.totals.total,
    });
    expect(current.body.payment_session).toEqual(res.body);
    const bad = await json('post', `/store/carts/${cart.id}/payment-session`).send({
      provider: 'paypal',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('validation_error');
  });

  it('POST /store/carts/{cartId}/complete → 201 Order; replay with the same key; 409 with another key', async () => {
    const meta = {
      attribution: {
        first: { utm_source: 'google', utm_medium: 'cpc', at: '2026-09-01T10:00:00.000Z' },
        last: { utm_source: 'newsletter', utm_medium: 'email', at: '2026-09-07T09:00:00.000Z' },
      },
      ab: 'B',
    };
    const cart = await readyCart(meta);
    await json('post', `/store/carts/${cart.id}/payment-session`).send({ provider: 'manual' });

    const noKey = await json('post', `/store/carts/${cart.id}/complete`).send();
    expect(noKey.status).toBe(400);
    expect(noKey.body.details).toEqual({ 'Idempotency-Key': 'required, at least 8 characters' });

    const key = `idem-${cart.id}`;
    const placed = await json('post', `/store/carts/${cart.id}/complete`)
      .set('Idempotency-Key', key)
      .send();
    expect(placed.status).toBe(201);
    spec.assertSchema('Order', placed.body);
    expect(placed.body).toMatchObject({
      status: 'pending',
      payment_status: 'authorized',
      fulfillment_status: 'unfulfilled',
      email: cart.email,
      currency: 'EUR',
      shipping_address: address,
      shipping_method: { code: 'standard', carrier: 'manual' },
      shipments: [],
      metadata: meta,
    });
    expect(placed.body.display_id).toBeGreaterThanOrEqual(1000);
    expect(placed.body.items).toHaveLength(1);
    expect(placed.body.total.amount_minor).toBe(placed.body.totals.total.amount_minor);

    const cartAfter = await asA(`/store/carts/${cart.id}`);
    expect(cartAfter.body).toMatchObject({ status: 'completed', order_id: placed.body.id });

    const replay = await json('post', `/store/carts/${cart.id}/complete`)
      .set('Idempotency-Key', key)
      .send();
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(placed.body.id);
    expect(replay.body.display_id).toBe(placed.body.display_id);

    const other = await json('post', `/store/carts/${cart.id}/complete`)
      .set('Idempotency-Key', `${key}-second`)
      .send();
    expect(other.status).toBe(409);
    spec.assertSchema('Error', other.body);
    expect(other.body).toMatchObject({
      code: 'cart_completed',
      details: { order_id: placed.body.id },
    });
  });

  it('the stored line-tax record (cart_line_item / order_line_item metadata.tax, #221) never appears in a Store API cart or order response', async () => {
    const cart = await readyCart({ note: 'gift' });
    await json('post', `/store/carts/${cart.id}/payment-session`).send({ provider: 'manual' });
    // the record exists on the row …
    const stored = await owner.query<{ metadata: { tax?: Record<string, unknown> } }>(
      `SELECT metadata FROM cart_line_item WHERE cart_id = $1`,
      [cart.id],
    );
    expect(stored.rows[0]!.metadata.tax).toMatchObject({ mode: 'exclusive' });
    expect(stored.rows[0]!.metadata.tax).toHaveProperty('amount_minor');
    expect(stored.rows[0]!.metadata.tax).toHaveProperty('bp');

    // … and no response shows it: the cart's own metadata (#100) round-trips, line metadata stays internal
    const leaks = (body: {
      items: Record<string, unknown>[];
      metadata?: Record<string, unknown>;
    }) => {
      for (const item of body.items) expect(item).not.toHaveProperty('metadata');
      expect(body.metadata ?? {}).not.toHaveProperty('tax');
      const text = JSON.stringify(body);
      expect(text).not.toContain('"mode"');
      expect(text).not.toContain('"bp"');
    };
    const read = await asA(`/store/carts/${cart.id}`);
    expect(read.status).toBe(200);
    expect(read.body.metadata).toEqual({ note: 'gift' });
    leaks(read.body);

    const placed = await json('post', `/store/carts/${cart.id}/complete`)
      .set('Idempotency-Key', `idem-leak-${cart.id}`)
      .send();
    expect(placed.status).toBe(201);
    leaks(placed.body);
    const frozen = await owner.query<{ metadata: { tax?: Record<string, unknown> } }>(
      `SELECT metadata FROM order_line_item WHERE order_id = $1`,
      [placed.body.id],
    );
    expect(frozen.rows[0]!.metadata.tax).toMatchObject({ mode: 'exclusive' });
    const order = await asA(
      `/store/orders/${placed.body.id}?email=${encodeURIComponent(cart.email)}`,
    );
    expect(order.status).toBe(200);
    leaks(order.body);
  });

  it('complete refuses a cart that is not ready (400 with the missing fields)', async () => {
    const cart = (await request(app).post('/store/carts').set('X-Publishable-Key', KEY_A)).body;
    const res = await json('post', `/store/carts/${cart.id}/complete`)
      .set('Idempotency-Key', 'not-ready-12345')
      .send();
    expect(res.status).toBe(400);
    spec.assertSchema('Error', res.body);
    expect(Object.keys(res.body.details).sort()).toEqual([
      'billing_address',
      'email',
      'items',
      'payment_session',
      'shipping_address',
      'shipping_option_id',
    ]);
  });

  it('GET /store/orders/{orderId}: guest email (trimmed, case-insensitive) → 200, anything else → 404, no PII logged', async () => {
    const cart = await readyCart();
    await json('post', `/store/carts/${cart.id}/payment-session`).send({ provider: 'manual' });
    const placed = await json('post', `/store/carts/${cart.id}/complete`)
      .set('Idempotency-Key', `idem-orders-${cart.id}`)
      .send();
    expect(placed.status).toBe(201);
    const id = placed.body.id as string;

    const logged: string[] = [];
    const spies = (['info', 'warn', 'error', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }),
    );
    try {
      const ok = await asA(
        `/store/orders/${id}?email=${encodeURIComponent(`  ${cart.email.toUpperCase()} `)}`,
      );
      expect(ok.status).toBe(200);
      spec.assertSchema('Order', ok.body);
      expect(ok.body.id).toBe(id);

      const wrong = await asA(`/store/orders/${id}?email=someone.else%40example.com`);
      expect(wrong.status).toBe(404);
      spec.assertSchema('Error', wrong.body);
      const none = await asA(`/store/orders/${id}`);
      expect(none.status).toBe(404);
      const badToken = await request(app)
        .get(`/store/orders/${id}`)
        .set('X-Publishable-Key', KEY_A)
        .set('Authorization', 'Bearer not-a-jwt');
      expect(badToken.status).toBe(404);
      const foreign = await request(app)
        .get(`/store/orders/${id}?email=${encodeURIComponent(cart.email)}`)
        .set('X-Publishable-Key', KEY_B);
      expect(foreign.status).toBe(404);
      // malformed email or id: the same 404 (never a 400 that confirms the id exists — #165 review)
      const malformed = await asA(`/store/orders/${id}?email=nope`);
      expect(malformed.status).toBe(404);
      const notUuid = await asA(`/store/orders/not-a-uuid?email=${encodeURIComponent(cart.email)}`);
      expect(notUuid.status).toBe(404);
      spec.assertSchema('Error', notUuid.body);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = logged.join('\n').toLowerCase();
    expect(all).not.toContain(cart.email.toLowerCase());
    expect(all).not.toContain('email=');
    expect(all).not.toContain('?');
  });
});
