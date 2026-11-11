// #809 (CONTRACT CHANGE #811): the Admin API shipping options and the activation guard, on a seeded throwaway
// database — permissions and tenancy over HTTP (dev tokens), validation, the update guard of an ACTIVE store, the
// outbox + audit in the same transaction, and money in the currency's minor unit end to end: ¥1,980 = 1980 minor
// units (JPY, 0 decimals) through the option, the cart total and the order.
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier, moduleAdminRouters } from '../src/http';
import { closePool, initDb, organizationClient, tenantClient } from '../src/lib/db';
import { addLineItem, createCart, getCart, updateCart } from '../src/modules/cart';
import { completeCart, createPaymentSession, listShippingOptions } from '../src/modules/checkout';
import {
  addCurrency,
  createShippingOption,
  createStore,
  inMemoryStoreRegistrar,
  storeReadiness,
} from '../src/modules/registry';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const C = SEED_IDS.stores.brandC;
const actor = { id: null, type: 'customer' as const, requestId: 'req-shipping-options' };
const staff = { id: null, type: 'system' as const, requestId: 'req-shipping-options-admin' };

let db: TestDatabase;
let app: express.Express;
const spec = specValidator('admin-api.yaml');

const as = (subject: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
});
const owner = as('seed-owner');
const storeAdmin = as('seed-store-admin'); // store_admin of brand-a and brand-b, nothing on brand-c
const storeStaff = as('seed-store-staff');

const optionsOf = (storeId: string) => `/admin/stores/${storeId}/shipping-options`;

beforeAll(async () => {
  db = await createTestDatabase('core_shipping_options');
  await seed(db.owner, { productsPerStore: 6, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), { moduleRouters: moduleAdminRouters() });
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('Admin API shipping options (#809): permissions and tenancy', () => {
  it('a viewer lists; only a store admin creates; another store is 403; the contract shapes hold', async () => {
    const list = await storeStaff.get(optionsOf(A));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const o of list.body.items) spec.assertSchema('ShippingOption', o);

    const body = {
      code: 'pickup',
      name: 'Pick-up point',
      price_minor: 0,
      currency: 'EUR',
      countries: ['nl'],
    };
    expect((await storeStaff.post(optionsOf(A), body)).status).toBe(403); // staff is not store_admin
    expect((await storeAdmin.post(optionsOf(C), body)).status).toBe(403); // no role on brand-c
    expect((await storeAdmin.get(optionsOf(C))).status).toBe(403);

    const created = await storeAdmin.post(optionsOf(A), body);
    expect(created.status).toBe(201);
    spec.assertSchema('ShippingOption', created.body);
    expect(created.body).toMatchObject({
      code: 'pickup',
      carrier: 'manual',
      service: null,
      price: { amount_minor: 0, currency: 'EUR' },
      countries: ['NL'], // upper-cased
      sales_channel_id: null,
      rules: {},
      is_active: true,
    });

    // an option of brand-b is not reachable through brand-a's path (the store filter): 404, nothing changed
    const bOption = (await owner.get(optionsOf(B))).body.items[0];
    const crossed = await storeAdmin.patch(`${optionsOf(A)}/${bOption.id}`, { price_minor: 1 });
    expect(crossed.status).toBe(404);
    expect((await owner.get(optionsOf(B))).body.items[0].price.amount_minor).toBe(
      bOption.price.amount_minor,
    );
  });

  it('writes the audit row and store.updated (changed_fields: shipping_options) in the same transaction', async () => {
    const created = await storeAdmin.post(optionsOf(A), {
      code: 'courier',
      name: 'Courier',
      price_minor: 1490,
      currency: 'EUR',
      countries: ['NL', 'BE'],
    });
    expect(created.status).toBe(201);
    const audit = await db.owner.query<{ action: string; store_id: string }>(
      `SELECT action, store_id FROM audit_log WHERE entity_id = $1`,
      [created.body.id],
    );
    expect(audit.rows).toEqual([{ action: 'shipping_option.create', store_id: A }]);
    const events = await db.owner.query<{ payload: { changed_fields: string[] } }>(
      `SELECT payload FROM outbox WHERE aggregate_id = $1 AND topic = 'store.updated' ORDER BY seq DESC LIMIT 1`,
      [A],
    );
    expect(events.rows[0]!.payload.changed_fields).toEqual(['shipping_options']);
  });
});

describe('validation (#811)', () => {
  it('400 for a bad body, a currency the store does not have, a foreign sales channel; 409 for a taken code', async () => {
    const good = { code: 'v1', name: 'V', price_minor: 100, currency: 'EUR', countries: ['NL'] };
    const bad = async (patch: Record<string, unknown>) => {
      const res = await storeAdmin.post(optionsOf(A), { ...good, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      spec.assertSchema('Error', res.body);
      return res.body;
    };
    await bad({ price_minor: -1 });
    await bad({ price_minor: 19.9 }); // minor units are integers
    await bad({ countries: [] });
    await bad({ countries: ['Netherlands'] });
    expect((await bad({ currency: 'GBP' })).details).toEqual({
      currency: "one of the store's currencies: EUR",
    });
    const bChannel = await organizationClient({ organizationId: ORG }).query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 LIMIT 1`,
      [B],
    );
    expect((await bad({ sales_channel_id: bChannel.rows[0]!.id })).details).toEqual({
      sales_channel_id: 'a sales channel of this store',
    });

    const first = await storeAdmin.post(optionsOf(A), good);
    expect(first.status).toBe(201);
    const taken = await storeAdmin.post(optionsOf(A), good);
    expect(taken.status).toBe(409);
    expect(taken.body.details).toEqual({ shipping_option_id: first.body.id });
  });

  it('PATCH: code and currency are immutable; an empty body is 400; a valid change is 200', async () => {
    const o = (
      await storeAdmin.post(optionsOf(A), {
        code: 'v2',
        name: 'V2',
        price_minor: 100,
        currency: 'EUR',
        countries: ['DE'],
      })
    ).body;
    for (const patch of [{}, { code: 'other' }, { currency: 'GBP' }, { countries: [] }]) {
      expect(
        (await storeAdmin.patch(`${optionsOf(A)}/${o.id}`, patch)).status,
        JSON.stringify(patch),
      ).toBe(400);
    }
    const changed = await storeAdmin.patch(`${optionsOf(A)}/${o.id}`, {
      price_minor: 250,
      countries: ['de', 'FR'],
    });
    expect(changed.status).toBe(200);
    spec.assertSchema('ShippingOption', changed.body);
    expect(changed.body).toMatchObject({
      code: 'v2',
      price: { amount_minor: 250, currency: 'EUR' },
      countries: ['DE', 'FR'],
    });
  });
});

describe('the update guard of an ACTIVE store (#811)', () => {
  it('deactivating the last option that ships to the default country in the store currency is 409; the others pass', async () => {
    // brand-c (USD, US) is active and has its own seeded USD options
    const options = (await owner.get(optionsOf(C))).body.items as Array<{
      id: string;
      price: { currency: string };
      countries: string[];
      is_active: boolean;
    }>;
    const usd = options.filter(
      (o) => o.is_active && o.price.currency === 'USD' && o.countries.includes('US'),
    );
    expect(usd.length).toBeGreaterThan(0);
    for (const o of usd.slice(1)) {
      expect((await owner.patch(`${optionsOf(C)}/${o.id}`, { is_active: false })).status).toBe(200);
    }
    const last = usd[0]!;
    const refused = await owner.patch(`${optionsOf(C)}/${last.id}`, { is_active: false });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'conflict',
      details: { missing_shipping_countries: ['US'] },
    });
    // an unrelated change to the same option passes, and nothing was deactivated by the refused call
    const priced = await owner.patch(`${optionsOf(C)}/${last.id}`, { price_minor: 799 });
    expect(priced.status).toBe(200);
    expect(priced.body.is_active).toBe(true);
    for (const o of usd.slice(1)) {
      expect((await owner.patch(`${optionsOf(C)}/${o.id}`, { is_active: true })).status).toBe(200);
    }
  });
});

describe('activation readiness with shipping options (#809)', () => {
  it('a JPY store needs an active JPY option for its market countries; another currency does not count', async () => {
    const hq = organizationClient({ organizationId: ORG });
    const le = await hq.query<{ id: string }>(`SELECT id FROM legal_entity ORDER BY code LIMIT 1`);
    const jp = await createStore(
      hq,
      {
        legal_entity_id: le.rows[0]!.id,
        code: 'brand-jp',
        name: 'Brand JP',
        default_currency: 'JPY',
        default_locale: 'ja-JP',
        default_country: 'JP',
      },
      staff,
    );
    await addCurrency(hq, jp.id, 'USD', {}, staff);
    const registered = inMemoryStoreRegistrar();
    const readiness = () =>
      hq.transaction(async (tx) => {
        const s = await tx.query<{
          id: string;
          legal_entity_id: string;
          default_country: string;
          default_currency: string;
        }>(
          `SELECT id, legal_entity_id, default_country, default_currency FROM store WHERE id = $1`,
          [jp.id],
        );
        return storeReadiness(tx, s.rows[0]!, registered);
      });

    expect(await readiness()).toMatchObject({ missing_shipping_countries: ['JP'] });
    expect((await readiness()).missing).toContain('shipping_options');

    // a USD option to JP and KR: KR becomes a market country, and nothing in JPY ships anywhere yet
    await createShippingOption(
      hq,
      jp.id,
      {
        code: 'usd-air',
        name: 'Air (USD)',
        price_minor: 1500,
        currency: 'USD',
        countries: ['JP', 'KR'],
      },
      staff,
    );
    expect((await readiness()).missing_shipping_countries).toEqual(['JP', 'KR']);

    const yen = await createShippingOption(
      hq,
      jp.id,
      { code: 'yamato', name: 'Yamato', price_minor: 1980, currency: 'JPY', countries: ['JP'] },
      staff,
    );
    expect(yen.price).toEqual({ amount_minor: 1980, currency: 'JPY' }); // ¥1,980: 0 decimals, no ×100
    expect((await readiness()).missing_shipping_countries).toEqual(['KR']);
  });
});

describe('¥1,980 = 1980 minor units end to end (JPY, 0 decimals): option → cart total → order', () => {
  it('places a JPY order whose shipping and total carry the option price unconverted', async () => {
    const hq = organizationClient({ organizationId: ORG });
    // brand-c also sells in JPY: the currency, a JPY default price list, and the option through the new service
    await addCurrency(hq, C, 'JPY', {}, staff);
    const variant = await hq.query<{ id: string }>(
      `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
       WHERE v.store_id = $1
         AND (SELECT coalesce(sum(il.available), 0) FROM inventory_level il WHERE il.stock_item_id = v.stock_item_id) >= 2
       ORDER BY v.sku LIMIT 1`,
      [C],
    );
    const list = await db.owner.query<{ id: string }>(
      `INSERT INTO price_list (organization_id, store_id, code, name, type, currency)
       VALUES ($1, $2, 'default-jpy', 'Default JPY', 'default', 'JPY') RETURNING id`,
      [ORG, C],
    );
    await db.owner.query(
      `INSERT INTO price (organization_id, store_id, price_list_id, variant_id, currency, amount_minor, min_quantity)
       VALUES ($1, $2, $3, $4, 'JPY', 3500, 1)`,
      [ORG, C, list.rows[0]!.id, variant.rows[0]!.id],
    );
    const option = await createShippingOption(
      hq,
      C,
      {
        code: 'jp-yamato',
        name: 'Yamato (JPY)',
        price_minor: 1980,
        currency: 'JPY',
        countries: ['US'],
      },
      staff,
    );

    const c = tenantClient({ organizationId: ORG, storeIds: [C] });
    const channel = await c.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
      [C],
    );
    const cart = await createCart(
      c,
      { organizationId: ORG, storeId: C, salesChannelId: channel.rows[0]!.id },
      { currency: 'JPY' },
    );
    await addLineItem(c, cart.id, { variant_id: variant.rows[0]!.id, quantity: 2 });
    const address = {
      first_name: 'Hana',
      last_name: 'Sato',
      line1: '1 Main St',
      city: 'Austin',
      postal_code: '73301',
      country: 'US',
    };
    await updateCart(c, cart.id, {
      email: 'jpy.buyer@example.com',
      shipping_address: address,
      billing_address: address,
    });
    // checkout offers the JPY option at its exact minor amount, and no option of another currency
    const offered = await listShippingOptions(c, cart.id);
    expect(offered.map((o) => o.id)).toEqual([option.id]);
    expect(offered[0]!.price ?? offered[0]).toMatchObject({ amount_minor: 1980, currency: 'JPY' });

    await updateCart(c, cart.id, { shipping_option_id: option.id });
    const priced = await getCart(c, cart.id);
    expect(priced.currency).toBe('JPY');
    expect(priced.totals.shipping).toEqual({ amount_minor: 1980, currency: 'JPY' });
    expect(priced.totals.subtotal.amount_minor).toBe(7000); // 2 × ¥3,500
    const t = priced.totals;
    expect(t.total.amount_minor).toBe(
      t.subtotal.amount_minor - (t.discount?.amount_minor ?? 0) + 1980 + t.tax.amount_minor,
    );
    for (const m of [t.subtotal, t.shipping, t.tax, t.total]) {
      expect(Number.isInteger(m.amount_minor)).toBe(true);
      expect(m.currency).toBe('JPY');
    }

    await createPaymentSession(c, cart.id, { provider: 'manual' });
    const { order } = await completeCart(c, {
      cartId: cart.id,
      idempotencyKey: `key-jpy-${cart.id}`,
      actor,
    });
    expect(order.currency ?? order.totals.total.currency).toBe('JPY');
    expect(order.totals.shipping).toEqual({ amount_minor: 1980, currency: 'JPY' });
    expect(order.totals.total.amount_minor).toBe(t.total.amount_minor);
    const stored = await db.owner.query<{
      shipping_minor: string;
      total_minor: string;
      currency: string;
    }>(`SELECT shipping_minor::text, total_minor::text, currency FROM "order" WHERE id = $1`, [
      order.id,
    ]);
    expect(stored.rows[0]).toEqual({
      shipping_minor: '1980',
      total_minor: String(t.total.amount_minor),
      currency: 'JPY',
    });
  });
});
