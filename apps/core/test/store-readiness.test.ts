// getStoreReadiness and the payment_method prerequisite (#839, Admin API 0.4.29), through the chain src/server.ts
// mounts, over a seeded throwaway database: `missing` is exactly what activateStore's 409 carries; payment methods
// follow the Store API's rule; `purchasable_products` counts what a cart can buy now (published, priced for one unit
// on the active default list in the store currency, stock available); an active store is never deactivated.
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier, moduleAdminRouters, moduleWebhookRouters } from '../src/http';
import { closePool, initDb, organizationClient } from '../src/lib/db';
import { getStoreReadiness, inMemoryStoreRegistrar } from '../src/modules/registry';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const A = SEED_IDS.stores.brandA;
const C = SEED_IDS.stores.brandC;
const D = SEED_IDS.stores.brandD;
const spec = specValidator('admin-api.yaml');

let db: TestDatabase;
let app: express.Express;
// the seeded stores are registered in OpenFGA by fga:seed; here, by the fake
const registrar = inMemoryStoreRegistrar(Object.values(SEED_IDS.stores));
const savedStripe: Record<string, string | undefined> = {};

const as = (subject: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
});
const owner = as('seed-owner');
const storeStaff = as('seed-store-staff');

/** The independent count: every published product of the store with one buyable variant, computed row by row. */
async function buyableByHand(storeId: string, currency: string): Promise<number> {
  const products = await db.owner.query<{ id: string }>(
    `SELECT id FROM product WHERE store_id = $1 AND status = 'published'`,
    [storeId],
  );
  let n = 0;
  for (const p of products.rows) {
    const variants = await db.owner.query<{ id: string; stock_item_id: string }>(
      `SELECT id, stock_item_id FROM product_variant WHERE product_id = $1`,
      [p.id],
    );
    let buyable = false;
    for (const v of variants.rows) {
      const price = await db.owner.query(
        `SELECT 1 FROM price pr JOIN price_list pl ON pl.id = pr.price_list_id
         WHERE pr.variant_id = $1 AND pr.currency = $2 AND pr.min_quantity = 1
           AND pl.type = 'default' AND pl.status = 'active' AND pl.currency = $2`,
        [v.id, currency],
      );
      const stock = await db.owner.query<{ a: number }>(
        `SELECT coalesce(max(on_hand - reserved), 0)::int AS a FROM inventory_level WHERE stock_item_id = $1`,
        [v.stock_item_id],
      );
      if (price.rows.length > 0 && stock.rows[0]!.a > 0) buyable = true;
    }
    if (buyable) n += 1;
  }
  return n;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env).filter((k) => k.startsWith('STRIPE_SECRET_KEY'))) {
    savedStripe[k] = process.env[k];
    delete process.env[k]; // payment methods must come from settings alone here
  }
  db = await createTestDatabase('core_store_readiness');
  await seed(db.owner, { productsPerStore: 12, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = SEED_IDS.organization;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    storeRegistrar: registrar,
    moduleRouters: moduleAdminRouters(),
    webhookRouters: moduleWebhookRouters(),
  });
});

afterAll(async () => {
  await closePool();
  await db?.drop();
  for (const [k, v] of Object.entries(savedStripe)) if (v !== undefined) process.env[k] = v;
});

describe('GET /admin/stores/{storeId}/readiness (#839)', () => {
  it('a seeded store (viewer): active, nothing missing, invoice, the purchasable count exact — A to D', async () => {
    for (const [id, currency] of [
      [A, 'EUR'],
      [SEED_IDS.stores.brandB, 'GBP'],
      [C, 'USD'],
      [D, 'JPY'],
    ] as const) {
      const r = await owner.get(`/admin/stores/${id}/readiness`);
      expect(r.status).toBe(200);
      spec.assertSchema('StoreReadiness', r.body);
      const n = await buyableByHand(id, currency);
      expect(n).toBeGreaterThan(0);
      expect(r.body).toEqual({
        status: 'active',
        missing: [],
        missing_tax_countries: [],
        missing_shipping_countries: [],
        payment_methods: ['invoice'],
        purchasable_products: n,
        warnings: [],
      });
    }
    // viewer is enough (store_staff of brand A); a store outside the principal's stores is 403; unknown is 404
    expect((await storeStaff.get(`/admin/stores/${A}/readiness`)).status).toBe(200);
    expect((await storeStaff.get(`/admin/stores/${C}/readiness`)).status).toBe(403);
    const unknown = await owner.get('/admin/stores/00000000-0000-4000-8000-00000000839f/readiness');
    expect(unknown.status).toBe(404);
    spec.assertSchema('Error', unknown.body);
  });

  it('purchasable: archived product, no stock, everything reserved, wrong currency, sale-list-only price — each one less', async () => {
    const count = async () =>
      (await owner.get(`/admin/stores/${A}/readiness`)).body.purchasable_products as number;
    const start = await count();
    // five products a cart can buy now; each mutation hits every variant of one of them
    const products = await db.owner.query<{ id: string }>(
      `SELECT p.id FROM product p WHERE p.store_id = $1 AND p.status = 'published' ORDER BY p.handle`,
      [A],
    );
    const ids = products.rows.map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    const [p1, p2, p3, p4, p5] = ids;
    const variantsOf = async (productId: string) =>
      (
        await db.owner.query<{ stock_item_id: string; id: string }>(
          `SELECT stock_item_id, id FROM product_variant WHERE product_id = $1`,
          [productId],
        )
      ).rows;
    const steps: [string, () => Promise<void>][] = [
      [
        'archived',
        async () => {
          await db.owner.query(`UPDATE product SET status = 'archived' WHERE id = $1`, [p1]);
        },
      ],
      [
        'no stock anywhere',
        async () => {
          for (const v of await variantsOf(p2!)) {
            await db.owner.query(
              `UPDATE inventory_level SET on_hand = 0, reserved = 0 WHERE stock_item_id = $1`,
              [v.stock_item_id],
            );
          }
        },
      ],
      [
        'everything on hand reserved',
        async () => {
          for (const v of await variantsOf(p3!)) {
            await db.owner.query(
              `UPDATE inventory_level SET reserved = on_hand WHERE stock_item_id = $1`,
              [v.stock_item_id],
            );
          }
        },
      ],
      [
        'EUR price only on a sale list',
        async () => {
          const sale = await db.owner.query<{ id: string }>(
            `INSERT INTO price_list (organization_id, store_id, code, name, type, currency)
             VALUES ($1, $2, 'sale-839', 'Sale 839', 'sale', 'EUR') RETURNING id`,
            [SEED_IDS.organization, A],
          );
          for (const v of await variantsOf(p4!)) {
            await db.owner.query(
              `UPDATE price SET price_list_id = $2 WHERE variant_id = $1 AND currency = 'EUR'`,
              [v.id, sale.rows[0]!.id],
            );
          }
        },
      ],
      [
        'default price for 2+ units only',
        async () => {
          for (const v of await variantsOf(p5!)) {
            await db.owner.query(
              `UPDATE price SET min_quantity = 2 WHERE variant_id = $1 AND currency = 'EUR'`,
              [v.id],
            );
          }
        },
      ],
    ];
    let previous = start;
    for (const [what, mutate] of steps) {
      await mutate();
      const now = await count();
      expect(now, what).toBeLessThan(previous); // each rule removes the product (a shared stock item may take more)
      expect(now, what).toBe(await buyableByHand(A, 'EUR'));
      previous = now;
    }
    expect(previous).toBeLessThanOrEqual(start - 5);
  });

  it('a just-onboarded store without a payment method: missing equals activate’s 409, payment_method included; no product → warning', async () => {
    const onboarded = await owner.post('/admin/onboarding/stores', {
      legal_entity: { code: 'brand-r-bv', name: 'Brand R B.V.', country: 'NL', currency: 'EUR' },
      code: 'brand-r',
      name: 'Brand R',
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
      domain: { hostname: 'brand-r.localhost' },
    });
    expect(onboarded.status).toBe(201);
    const id = onboarded.body.store.id as string;
    const readiness = await owner.get(`/admin/stores/${id}/readiness`);
    expect(readiness.status).toBe(200);
    spec.assertSchema('StoreReadiness', readiness.body);
    expect(readiness.body).toEqual({
      status: 'draft',
      missing: ['tax_rates', 'shipping_options', 'payment_method'],
      missing_tax_countries: ['NL'],
      missing_shipping_countries: ['NL'],
      payment_methods: [],
      purchasable_products: 0,
      warnings: ['no_purchasable_product'],
    });
    const refused = await owner.post(`/admin/stores/${id}/activate`);
    expect(refused.status).toBe(409);
    expect(refused.body.details).toEqual({
      missing: readiness.body.missing,
      missing_tax_countries: readiness.body.missing_tax_countries,
      missing_shipping_countries: readiness.body.missing_shipping_countries,
    });
    // tax + shipping done: payment_method is the one thing left, on both
    expect(
      (
        await owner.post(`/admin/stores/${id}/tax-rates`, {
          country: 'NL',
          name: 'VAT 21%',
          rate_bp: 2100,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await owner.post(`/admin/stores/${id}/shipping-options`, {
          code: 'nl-standard',
          name: 'Standard',
          price_minor: 495,
          currency: 'EUR',
          countries: ['NL'],
        })
      ).status,
    ).toBe(201);
    expect((await owner.get(`/admin/stores/${id}/readiness`)).body.missing).toEqual([
      'payment_method',
    ]);
    const onlyPayment = await owner.post(`/admin/stores/${id}/activate`);
    expect(onlyPayment.status).toBe(409);
    expect(onlyPayment.body.details).toEqual({ missing: ['payment_method'] });
    // invoice allowed → activates; nothing purchasable is a warning, never a block
    expect(
      (
        await owner.patch(`/admin/stores/${id}`, {
          settings: { payment: { invoice_allowed: true } },
        })
      ).status,
    ).toBe(200);
    expect((await owner.post(`/admin/stores/${id}/activate`)).status).toBe(200);
    expect((await owner.get(`/admin/stores/${id}/readiness`)).body).toMatchObject({
      status: 'active',
      missing: [],
      payment_methods: ['invoice'],
      purchasable_products: 0,
      warnings: ['no_purchasable_product'],
    });
  });

  it('an ACTIVE store that loses its payment method stays active: readiness reports it, nothing deactivates it', async () => {
    const before = await owner.get(`/admin/stores/${D}`);
    expect(before.body.status).toBe('active');
    const off = await owner.patch(`/admin/stores/${D}`, {
      settings: { ...before.body.settings, payment: { invoice_allowed: false } },
    });
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('active');
    const r = await owner.get(`/admin/stores/${D}/readiness`);
    expect(r.body).toMatchObject({
      status: 'active',
      missing: ['payment_method'],
      payment_methods: [],
    });
    // other patches of the active store still pass, and a no-op activate answers active
    expect((await owner.patch(`/admin/stores/${D}`, { name: 'Brand D!' })).body.status).toBe(
      'active',
    );
    expect((await owner.post(`/admin/stores/${D}/activate`)).body.status).toBe('active');
    expect((await owner.get(`/admin/stores/${D}`)).body.status).toBe('active');
    await owner.patch(`/admin/stores/${D}`, { settings: before.body.settings, name: 'Brand D' });
  });

  it('card counts as a payment method when the store has its Stripe key (the Store API rule)', async () => {
    const hq = organizationClient({ organizationId: SEED_IDS.organization });
    const env = { STRIPE_SECRET_KEY_BRAND_C: 'fixture-not-a-key' };
    expect((await getStoreReadiness(hq, C, registrar, env)).payment_methods).toEqual([
      'card',
      'invoice',
    ]);
    expect((await getStoreReadiness(hq, C, registrar, {})).payment_methods).toEqual(['invoice']);
  });

  it('p95 of the readiness read on a seeded store (informational)', async () => {
    const ms: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t = performance.now();
      const r = await owner.get(`/admin/stores/${A}/readiness`);
      ms.push(performance.now() - t);
      expect(r.status).toBe(200);
    }
    ms.sort((x, y) => x - y);
    const p95 = ms[94]!;
    console.info(
      `[store-readiness] GET readiness ×100 on brand A: p50 ${ms[49]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`,
    );
    expect(p95).toBeLessThan(1000);
  });
});
