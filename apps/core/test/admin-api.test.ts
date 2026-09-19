// Admin API routes (issue #7): the exact chain src/server.ts mounts on a bare Express app over a fully seeded
// throwaway database. Permissions come from admin-api.yaml `x-permission` (Phase 1 stub over role_assignment),
// bodies are validated against the spec, responses are checked against the spec's components.
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  coreErrorHandler,
  DevTokenVerifier,
  hasPermission,
  loadSpec,
  requirePermission,
  resolveObject,
  resolveStaffPrincipal,
  moduleAdminRouters,
  moduleWebhookRouters,
} from '../src/http';
import { closePool, initDb, tenantClient } from '../src/lib/db';
import { addLineItem, createCart, updateCart } from '../src/modules/cart';
import { completeCart, createPaymentSession } from '../src/modules/checkout';
import {
  confirmOrder,
  markPaymentCaptured,
  markShipmentCreated,
  markShipped,
} from '../src/modules/orders';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const LE_A = SEED_IDS.legalEntities.brandA;
const spec = specValidator('admin-api.yaml');

let db: TestDatabase;
let app: express.Express;

const as = (subject: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer dev:${subject}`),
});
const owner = as('seed-owner');
const analyst = as('seed-analyst');
const support = as('seed-support');
const finance = as('seed-finance');
const storeAdmin = as('seed-store-admin');
const storeStaff = as('seed-store-staff');

beforeAll(async () => {
  db = await createTestDatabase('core_admin_api');
  await seed(db.owner, { productsPerStore: 12, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = SEED_IDS.organization;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    moduleRouters: moduleAdminRouters(),
    webhookRouters: moduleWebhookRouters(),
  });
  // The Admin API customers routes belong to window 13 and stay on the Prism mock in Phase 1; this probe
  // mounts the frozen `listCustomers` x-permission (support since contracts 0.2.1, issue #77) on our guard so
  // the PII gate is proven for everything window 1 owns.
  const customersPermission = loadSpec('admin-api.yaml').permission('listCustomers');
  app.get(
    '/admin/_probe/stores/:storeId/customers',
    requirePermission(customersPermission.relation, (req) =>
      resolveObject(customersPermission.object, { storeId: req.params.storeId }),
    ),
    (_req, res) => res.json({ items: [] }),
  );
  app.use(coreErrorHandler);
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('/admin/me', () => {
  it('returns the principal with stores[].relations (seeded store-admin sees brand-a and brand-b)', async () => {
    const res = await storeAdmin.get('/admin/me');
    expect(res.status).toBe(200);
    spec.assertSchema('Principal', res.body);
    expect(res.body.organization).toMatchObject({ id: SEED_IDS.organization, slug: 'hq' });
    expect(res.body.organization_relations).toEqual([]);
    expect(
      res.body.stores.map((s: { code: string; relations: string[] }) => [s.code, s.relations]),
    ).toEqual([
      ['brand-a', ['store_admin']],
      ['brand-b', ['store_admin']],
    ]);
    expect((await request(app).get('/admin/me')).status).toBe(401);
  });
});

describe('registry routes', () => {
  it('GET /admin/stores lists what the principal may see; POST needs owner', async () => {
    const staff = await storeStaff.get('/admin/stores');
    expect(staff.status).toBe(200);
    spec.assertPage('Store', staff.body);
    expect(staff.body.items.map((s: { code: string }) => s.code)).toEqual(['brand-a']);

    const all = await owner.get('/admin/stores?limit=2&page=2');
    expect(all.body).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(all.body.items).toHaveLength(1);

    // contracts 0.2.0: sort + order (order ignored without sort)
    const byCode = await owner.get('/admin/stores?sort=code&order=asc');
    expect(byCode.body.items.map((s: { code: string }) => s.code)).toEqual([
      'brand-a',
      'brand-b',
      'brand-c',
    ]);
    const byCodeDesc = await owner.get('/admin/stores?sort=code');
    expect(byCodeDesc.body.items.map((s: { code: string }) => s.code)).toEqual([
      'brand-c',
      'brand-b',
      'brand-a',
    ]);
    const byName = await owner.get('/admin/stores?sort=name&order=asc');
    expect(byName.body.items.map((s: { name: string }) => s.name)).toEqual([
      'Brand A',
      'Brand B',
      'Brand C',
    ]);
    const defaultOrder = await owner.get('/admin/stores');
    const orderOnly = await owner.get('/admin/stores?order=asc');
    expect(orderOnly.body.items.map((s: { id: string }) => s.id)).toEqual(
      defaultOrder.body.items.map((s: { id: string }) => s.id),
    );
    const badSort = await owner.get('/admin/stores?sort=colour&order=up');
    expect(badSort.status).toBe(400);
    expect(badSort.body).toMatchObject({
      code: 'validation_error',
      details: { sort: 'one of code, name, status, created_at', order: 'one of asc, desc' },
    });

    const denied = await storeStaff.post('/admin/stores', { code: 'brand-x' });
    expect(denied.status).toBe(403);
    spec.assertSchema('Error', denied.body);
    expect(denied.body).toEqual({
      code: 'forbidden',
      message: 'requires owner on organization:hq',
    });
  });

  it('POST /admin/stores validates the body against StoreInput (400 details) and creates with audit + event', async () => {
    const bad = await owner.post('/admin/stores', {
      legal_entity_id: 'nope',
      code: 'Brand X',
      default_currency: 'eur',
    });
    expect(bad.status).toBe(400);
    spec.assertSchema('Error', bad.body);
    expect(bad.body.code).toBe('validation_error');
    expect(Object.keys(bad.body.details).sort()).toEqual([
      'code',
      'default_currency',
      'legal_entity_id',
    ]);

    const created = await owner.post('/admin/stores', {
      legal_entity_id: LE_A,
      code: 'brand-x',
      name: 'Brand X',
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
      currencies: ['EUR', 'USD'],
    });
    expect(created.status).toBe(201);
    spec.assertSchema('Store', created.body);
    const storeX = created.body.id as string;

    const fetched = await owner.get(`/admin/stores/${storeX}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.code).toBe('brand-x');
    const patched = await owner.patch(`/admin/stores/${storeX}`, {
      name: 'Brand X!',
      status: 'active',
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: 'Brand X!', status: 'active' });

    const events = await db.owner.query(
      `SELECT topic FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
      [storeX],
    );
    expect(events.rows.map((r) => r.topic)).toEqual(['store.created', 'store.updated']);
    const audit = await db.owner.query(
      `SELECT actor_id, action FROM audit_log WHERE entity_id = $1 ORDER BY created_at`,
      [storeX],
    );
    expect(audit.rows).toEqual([
      { actor_id: SEED_IDS.users.owner, action: 'store.create' },
      { actor_id: SEED_IDS.users.owner, action: 'store.update' },
    ]);

    expect((await owner.get('/admin/stores/not-a-uuid')).status).toBe(400);
    expect((await owner.get('/admin/stores/00000000-0000-4000-8000-0000000000ff')).status).toBe(
      404,
    );
  });

  it('domains (owner), sales channels and api keys (store_admin), warehouses and legal entities (HQ roles)', async () => {
    const domain = await owner.post(`/admin/stores/${A}/domains`, {
      hostname: 'shop.brand-a.example',
    });
    expect(domain.status).toBe(201);
    spec.assertSchema('Domain', domain.body);
    expect(
      (await storeAdmin.post(`/admin/stores/${A}/domains`, { hostname: 'x.example' })).status,
    ).toBe(403);
    const domains = await storeAdmin.get(`/admin/stores/${A}/domains`);
    spec.assertSchema('DomainList', domains.body);
    expect(domains.body.items.map((d: { hostname: string }) => d.hostname)).toContain(
      'shop.brand-a.example',
    );

    const channel = await storeAdmin.post(`/admin/stores/${A}/sales-channels`, {
      code: 'app',
      name: 'Mobile app',
      type: 'app',
    });
    expect(channel.status).toBe(201);
    spec.assertSchema('SalesChannel', channel.body);
    expect(
      (
        await storeStaff.post(`/admin/stores/${A}/sales-channels`, {
          code: 'pos-1',
          name: 'POS',
          type: 'pos',
        })
      ).status,
    ).toBe(403);
    const channels = await storeStaff.get(`/admin/stores/${A}/sales-channels`);
    expect(channels.body.items.map((c: { code: string }) => c.code)).toEqual(['app', 'web']);

    const key = await storeAdmin.post(`/admin/stores/${A}/api-keys`, {
      name: 'storefront 2',
      type: 'publishable',
      sales_channel_id: channel.body.id,
    });
    expect(key.status).toBe(201);
    spec.assertSchema('ApiKey', key.body);
    expect(key.body.key).toMatch(/^pk_brand-a_[0-9a-f]{40}$/);
    expect((await finance.get(`/admin/stores/${A}/api-keys`)).status).toBe(403);
    const keys = await storeAdmin.get(`/admin/stores/${A}/api-keys`);
    expect(keys.body.items).toHaveLength(2);
    expect(JSON.stringify(keys.body)).not.toContain(key.body.key);

    const warehouses = await finance.get('/admin/warehouses');
    expect(warehouses.status).toBe(200);
    spec.assertItems('Warehouse', warehouses.body);
    expect(warehouses.body.items.map((w: { code: string }) => w.code)).toEqual(['wh-eu', 'wh-us']);
    expect((await storeAdmin.get('/admin/warehouses')).status).toBe(403);

    const les = await finance.get('/admin/legal-entities');
    expect(les.status).toBe(200);
    spec.assertItems('LegalEntity', les.body);
    expect((await storeAdmin.get('/admin/legal-entities')).status).toBe(403);
    expect((await owner.get('/admin/legal-entities')).status).toBe(200);
  });
});

describe('catalog routes', () => {
  it('finance gets 403 on product create; store-staff gets 201 in brand-a and 403 in brand-b', async () => {
    const body = {
      handle: 'admin-api-tee',
      title: 'Admin API Tee',
      options: [{ name: 'Size', values: ['S', 'M'] }],
    };
    const denied = await finance.post(`/admin/stores/${A}/products`, body);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      code: 'forbidden',
      message: `requires store_staff on store:${A}`,
    });

    const outside = await storeStaff.post(`/admin/stores/${B}/products`, body);
    expect(outside.status).toBe(403);
    expect((await storeStaff.get(`/admin/stores/${B}/products`)).status).toBe(403);

    const created = await storeStaff.post(`/admin/stores/${A}/products`, body);
    expect(created.status).toBe(201);
    spec.assertSchema('Product', created.body);
    expect(created.body).toMatchObject({ status: 'draft', handle: 'admin-api-tee' });
    const productId = created.body.id as string;

    const badBody = await storeStaff.post(`/admin/stores/${A}/products`, {
      handle: 'Bad Handle',
      title: 1,
    });
    expect(badBody.status).toBe(400);
    expect(badBody.body.code).toBe('validation_error');
    expect(Object.keys(badBody.body.details).sort()).toEqual(['handle', 'title']);

    const variant = await storeStaff.post(`/admin/stores/${A}/products/${productId}/variants`, {
      sku: 'ADMIN-API-S',
      title: 'S',
      options: { Size: 'S' },
      prices: [{ currency: 'EUR', amount_minor: 2500 }],
    });
    expect(variant.status).toBe(201);
    spec.assertSchema('Variant', variant.body);
    expect(variant.body.prices[0]).toMatchObject({ currency: 'EUR', amount_minor: 2500 });
    const patchedVariant = await storeStaff.patch(
      `/admin/stores/${A}/variants/${variant.body.id}`,
      {
        barcode: '1234567890123',
      },
    );
    expect(patchedVariant.status).toBe(200);
    expect(patchedVariant.body.barcode).toBe('1234567890123');

    const published = await storeStaff.post(`/admin/stores/${A}/products/${productId}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');

    const patched = await storeStaff.patch(`/admin/stores/${A}/products/${productId}`, {
      tags: ['x'],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.tags).toEqual(['x']);

    // archive needs store_admin
    expect((await storeStaff.delete(`/admin/stores/${A}/products/${productId}`)).status).toBe(403);
    const archived = await storeAdmin.delete(`/admin/stores/${A}/products/${productId}`);
    expect(archived.status).toBe(204);
    const after = await storeStaff.get(`/admin/stores/${A}/products/${productId}`);
    expect(after.body.status).toBe('archived');
    spec.assertSchema('Product', after.body);
  });

  it('lists products with filters and categories; unknown product → 404', async () => {
    const list = await storeStaff.get(`/admin/stores/${A}/products?status=published&limit=5`);
    expect(list.status).toBe(200);
    spec.assertPage('Product', list.body);
    expect(list.body.total).toBe(12);
    expect(list.body.items).toHaveLength(5);
    expect(list.body.items[0].variants[0].inventory.length).toBeGreaterThan(0);

    expect((await storeStaff.get(`/admin/stores/${A}/products?status=bogus`)).status).toBe(400);

    // contracts 0.2.0: sort + order on products
    const byTitle = await storeStaff.get(
      `/admin/stores/${A}/products?sort=title&order=asc&limit=100`,
    );
    const titles = byTitle.body.items.map((p: { title: string }) => p.title);
    expect(titles).toEqual([...titles].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    const byHandleDesc = await storeStaff.get(`/admin/stores/${A}/products?sort=handle&limit=100`);
    const handles = byHandleDesc.body.items.map((p: { handle: string }) => p.handle);
    expect(handles).toEqual([...handles].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0)));
    expect((await storeStaff.get(`/admin/stores/${A}/products?sort=price`)).status).toBe(400);
    spec.assertPage('Product', byTitle.body);
    expect(
      (await storeStaff.get(`/admin/stores/${A}/products/00000000-0000-4000-8000-0000000000ff`))
        .status,
    ).toBe(404);

    const cats = await storeStaff.get(`/admin/stores/${A}/categories`);
    spec.assertItems('Category', cats.body);
    const tops = cats.body.items.find((c: { handle: string }) => c.handle === 'tops');
    const created = await storeStaff.post(`/admin/stores/${A}/categories`, {
      handle: 'tank-tops',
      name: 'Tank tops',
      parent_id: tops.id,
    });
    expect(created.status).toBe(201);
    spec.assertSchema('Category', created.body);
    expect(
      (await storeStaff.post(`/admin/stores/${A}/categories`, { handle: 'tank-tops', name: 'dup' }))
        .status,
    ).toBe(409);
  });
});

describe('customer PII gate (contracts 0.2.1, issue #77)', () => {
  const customersPath = `/admin/_probe/stores/${A}/customers`;

  it('the frozen spec gates the customer reads with `support`, not `viewer`', () => {
    const spec = loadSpec('admin-api.yaml');
    for (const op of ['listCustomers', 'getCustomer', 'updateCustomer']) {
      expect(spec.permission(op)).toEqual({ relation: 'support', object: 'store:{storeId}' });
    }
    expect(spec.permission('listProducts').relation).toBe('viewer');
  });

  it('analyst gets 403 on the customers routes but keeps the viewer-gated aggregates', async () => {
    const denied = await analyst.get(customersPath);
    expect(denied.status).toBe(403);
    spec.assertSchema('Error', denied.body);
    expect(denied.body).toEqual({ code: 'forbidden', message: `requires support on store:${A}` });

    // …while the same analyst is a viewer on every store: aggregates stay readable (ADR 0002 data minimisation).
    const products = await analyst.get(`/admin/stores/${A}/products?limit=1`);
    expect(products.status).toBe(200);
    spec.assertPage('Product', products.body);
  });

  it('support, store_admin and owner may read customers; finance may not', async () => {
    expect((await support.get(customersPath)).status).toBe(200);
    expect((await storeAdmin.get(customersPath)).status).toBe(200);
    expect((await owner.get(customersPath)).status).toBe(200);
    expect((await finance.get(customersPath)).status).toBe(403);
  });

  it('the permission stub itself denies analyst `support` on every store', async () => {
    const principal = await resolveStaffPrincipal(
      'Bearer dev:seed-analyst',
      new DevTokenVerifier(),
      'test',
    );
    expect(principal.organizationRelations).toEqual(['analyst']);
    expect(hasPermission(principal, 'viewer', `store:${A}`)).toBe(true);
    expect(hasPermission(principal, 'support', `store:${A}`)).toBe(false);
    expect(hasPermission(principal, 'support', `store:${B}`)).toBe(false);
    expect(hasPermission(principal, 'support', 'store:*')).toBe(false);
  });
});

describe('orders (task 2.3): listOrders, getOrder, cancelOrder', () => {
  const customer = { id: null, type: 'customer' as const, requestId: 'req-admin-orders' };
  let orderId: string;
  let displayId: number;

  beforeAll(async () => {
    // Place one brand-a order through the cart + checkout modules (the Admin API has no "create order").
    const client = tenantClient({ organizationId: SEED_IDS.organization, storeIds: [A] });
    const channel = await client.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
      [A],
    );
    const cart = await createCart(client, {
      organizationId: SEED_IDS.organization,
      storeId: A,
      salesChannelId: channel.rows[0]!.id,
    });
    const variant = await client.query<{ id: string }>(
      `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
       JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
       JOIN inventory_level il ON il.variant_id = v.id AND il.available >= 5
       WHERE v.store_id = $1 ORDER BY v.sku LIMIT 1`,
      [A],
    );
    await addLineItem(client, cart.id, { variant_id: variant.rows[0]!.id, quantity: 1 });
    const option = await client.query<{ id: string }>(
      `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
      [A],
    );
    const address = {
      first_name: 'Ada',
      last_name: 'Admin',
      line1: 'Dam 1',
      city: 'Amsterdam',
      postal_code: '1012 JS',
      country: 'NL',
    };
    await updateCart(client, cart.id, {
      email: 'ada.admin@example.com',
      shipping_address: address,
      billing_address: address,
      shipping_option_id: option.rows[0]!.id,
    });
    await createPaymentSession(client, cart.id, { provider: 'manual' });
    const { order } = await completeCart(client, {
      cartId: cart.id,
      idempotencyKey: `admin-api-${cart.id}`,
      actor: customer,
    });
    orderId = order.id;
    displayId = order.display_id;
  });

  it('GET /admin/stores/{storeId}/orders → Page<OrderSummary> (viewer); filters, q, sort/order; 400 on bad params', async () => {
    const res = await storeStaff.get(`/admin/stores/${A}/orders?sort=display_id&order=asc`);
    expect(res.status).toBe(200);
    spec.assertPage('OrderSummary', res.body);
    expect(res.body.items.map((o: { id: string }) => o.id)).toContain(orderId);
    const byId = await storeStaff.get(`/admin/stores/${A}/orders?q=${displayId}`);
    expect(byId.body.items.map((o: { id: string }) => o.id)).toEqual([orderId]);
    const filtered = await storeStaff.get(`/admin/stores/${A}/orders?status=cancelled`);
    expect(filtered.body.items.map((o: { id: string }) => o.id)).not.toContain(orderId);
    const bad = await storeStaff.get(
      `/admin/stores/${A}/orders?status=shipped&sort=email&placed_from=yesterday`,
    );
    expect(bad.status).toBe(400);
    spec.assertSchema('Error', bad.body);
    expect(Object.keys(bad.body.details).sort()).toEqual(['placed_from', 'sort', 'status']);
    // another store's admin scope → 403 from the permission stub (brand-c is outside store-staff's stores)
    const foreign = await storeStaff.get(`/admin/stores/${SEED_IDS.stores.brandC}/orders`);
    expect(foreign.status).toBe(403);
  });

  it('GET /admin/stores/{storeId}/orders/{orderId} → Order; 404 through another store; 400 non-uuid', async () => {
    const res = await storeStaff.get(`/admin/stores/${A}/orders/${orderId}`);
    expect(res.status).toBe(200);
    spec.assertSchema('Order', res.body);
    expect(res.body).toMatchObject({
      id: orderId,
      display_id: displayId,
      status: 'pending',
      payment_status: 'authorized',
      payments: [{ provider: 'manual', status: 'authorized' }],
      shipments: [],
      returns: [],
      refunds: [],
    });
    const viaB = await storeAdmin.get(`/admin/stores/${B}/orders/${orderId}`);
    expect(viaB.status).toBe(404);
    const notUuid = await storeStaff.get(`/admin/stores/${A}/orders/not-a-uuid`);
    expect(notUuid.status).toBe(400);
  });

  it('POST /admin/stores/{storeId}/orders/{orderId}/cancel: store_admin only; body validated; 200 Order cancelled; idempotent', async () => {
    const forbidden = await storeStaff.post(`/admin/stores/${A}/orders/${orderId}/cancel`, {
      reason: 'x',
    });
    expect(forbidden.status).toBe(403);
    const noReason = await storeAdmin.post(`/admin/stores/${A}/orders/${orderId}/cancel`, {});
    expect(noReason.status).toBe(400);
    const res = await storeAdmin.post(`/admin/stores/${A}/orders/${orderId}/cancel`, {
      reason: 'customer request',
    });
    expect(res.status).toBe(200);
    spec.assertSchema('Order', res.body);
    expect(res.body).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'customer request',
      payments: [{ status: 'cancelled' }],
    });
    const again = await storeAdmin.post(`/admin/stores/${A}/orders/${orderId}/cancel`, {
      reason: 'again',
    });
    expect(again.status).toBe(200);
    expect(again.body.cancel_reason).toBe('customer request');
    const list = await storeStaff.get(`/admin/stores/${A}/orders?status=cancelled`);
    expect(list.body.items.map((o: { id: string }) => o.id)).toContain(orderId);
  });
});

describe('inventory (task 2.4): listInventoryLevels, createStockMovement', () => {
  const operations = as('seed-operations');

  it('GET /admin/inventory/levels: with store_id → that store (viewer); without → visible stores; sort/filters; 403 for a foreign store', async () => {
    const res = await storeStaff.get(
      `/admin/inventory/levels?store_id=${A}&sort=available&order=asc&limit=5`,
    );
    expect(res.status).toBe(200);
    spec.assertPage('InventoryLevel', res.body);
    expect(res.body.items).toHaveLength(5);
    for (const i of res.body.items) expect(i.store_id).toBe(A);
    const avail = res.body.items.map((i: { available: number }) => i.available);
    expect([...avail].sort((x, y) => x - y)).toEqual(avail);

    // no store_id: store:* → the caller's visible stores only (store-staff = brand-a and brand-b)
    const mine = await storeStaff.get(
      '/admin/inventory/levels?limit=100&warehouse_id=' + SEED_IDS.warehouses.eu,
    );
    expect(mine.status).toBe(200);
    const stores = new Set(mine.body.items.map((i: { store_id: string }) => i.store_id));
    expect(stores.has(SEED_IDS.stores.brandC)).toBe(false);
    // HQ operations sees every store
    const all = await operations.get(
      '/admin/inventory/levels?limit=100&warehouse_id=' + SEED_IDS.warehouses.eu,
    );
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThan(mine.body.total);

    const foreign = await storeStaff.get(
      `/admin/inventory/levels?store_id=${SEED_IDS.stores.brandC}`,
    );
    expect(foreign.status).toBe(403);
    const badStore = await storeStaff.get(`/admin/inventory/levels?store_id=nope`);
    expect(badStore.status).toBe(400);
    expect(badStore.body.details).toEqual({ store_id: 'uuid' });
    const bad = await storeStaff.get(
      `/admin/inventory/levels?store_id=${A}&sort=price&below_available=x`,
    );
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.details).sort()).toEqual(['below_available', 'sort']);
  });

  it('POST /admin/inventory/movements: operations only; body validated; 201 InventoryLevel; stock.moved written', async () => {
    const levels = await operations.get(
      `/admin/inventory/levels?store_id=${A}&limit=1&sort=sku&order=asc`,
    );
    const lvl = levels.body.items[0] as {
      variant_id: string;
      warehouse_id: string;
      on_hand: number;
      sku: string;
    };
    const forbidden = await storeAdmin.post('/admin/inventory/movements', {
      variant_id: lvl.variant_id,
      warehouse_id: lvl.warehouse_id,
      delta: 1,
      reason: 'receipt',
    });
    expect(forbidden.status).toBe(403);
    const badReason = await operations.post('/admin/inventory/movements', {
      variant_id: lvl.variant_id,
      warehouse_id: lvl.warehouse_id,
      delta: 1,
      reason: 'sale',
    });
    expect(badReason.status).toBe(400);
    const res = await operations.post('/admin/inventory/movements', {
      variant_id: lvl.variant_id,
      warehouse_id: lvl.warehouse_id,
      delta: 5,
      reason: 'receipt',
      note: 'PO-42',
    });
    expect(res.status).toBe(201);
    spec.assertSchema('InventoryLevel', res.body);
    expect(res.body).toMatchObject({
      variant_id: lvl.variant_id,
      sku: lvl.sku,
      on_hand: lvl.on_hand + 5,
    });
    const negative = await operations.post('/admin/inventory/movements', {
      variant_id: lvl.variant_id,
      warehouse_id: lvl.warehouse_id,
      delta: -(lvl.on_hand + 100),
      reason: 'adjustment',
    });
    expect(negative.status).toBe(409);
    spec.assertSchema('Error', negative.body);
  });
});

describe('module routers mounted by the server (wiring batch #162 / #181)', () => {
  it('moduleAdminRouters() carries the merchandising and marketing routers and both answer behind our staff auth', async () => {
    expect(moduleAdminRouters()).toHaveLength(5);
    const rules = await storeStaff.get(`/admin/stores/${A}/merchandising/rules`);
    expect(rules.status).toBe(200); // window 9: store_staff read
    expect(rules.body).toHaveProperty('items');
    const campaigns = await storeStaff.get(`/admin/stores/${A}/marketing/campaigns`);
    expect(campaigns.status).toBe(200); // window 17: viewer read
    expect(campaigns.body).toHaveProperty('items');
    const anonymous = await request(app).get(`/admin/stores/${A}/marketing/campaigns`);
    expect(anonymous.status).toBe(401); // our middleware still fronts them
  });

  it('quiet-state batch (#179): media, price-list and promotion routers answer behind our staff auth, never 404', async () => {
    const lists = await storeAdmin.get(`/admin/stores/${A}/price-lists`);
    expect(lists.status).toBe(200); // window 9: pricingRouter
    expect(lists.body).toHaveProperty('items');
    const promotions = await storeAdmin.get(`/admin/stores/${A}/promotions`);
    expect(promotions.status).toBe(200); // window 9: promotionsRouter
    expect(promotions.body).toHaveProperty('items');
    // window 9: mediaRouter — the route exists (validation / configuration answers, not the Medusa fall-through)
    const media = await storeAdmin.post(`/admin/stores/${A}/media/upload-params`, {});
    expect(media.status).not.toBe(404);
    expect([200, 201, 400, 409]).toContain(media.status); // 409 = no Cloudinary credentials for the store
    expect(
      (await request(app).post(`/admin/stores/${A}/media/upload-params`).send({})).status,
    ).toBe(401);
    for (const path of ['price-lists', 'promotions']) {
      const anonymous = await request(app).get(`/admin/stores/${A}/${path}`);
      expect(anonymous.status).toBe(401);
    }
  });

  it('moduleWebhookRouters() (#176 part 3): the Stripe webhook answers outside /store and /admin, on the raw body', async () => {
    expect(moduleWebhookRouters()).toHaveLength(1);
    const previous = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = 'words-only-test-secret';
    try {
      // no staff token, no publishable key: the signature is the authentication — a stale one is a 400, not a 401
      const stale = await request(app)
        .post('/webhooks/stripe/brand-a')
        .set('Stripe-Signature', 't=1,v1=00')
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(stale.status).toBe(400);
      expect(stale.body).toMatchObject({
        code: 'validation_error',
        details: { reason: 'timestamp_out_of_tolerance' },
      });
      const unknown = await request(app)
        .post('/webhooks/stripe/no-such-store')
        .set('Stripe-Signature', 't=1,v1=00')
        .send('{}');
      expect(unknown.status).toBe(404);
      spec.assertSchema('Error', unknown.body);
    } finally {
      if (previous === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = previous;
    }
  });
});

describe('returns (task 2.5): createReturn, receiveReturn', () => {
  const customer = { id: null, type: 'customer' as const, requestId: 'req-admin-returns' };
  const system = { id: null, type: 'system' as const, requestId: 'req-admin-returns' };
  const operations = as('seed-operations');
  let orderId: string;
  let lineId: string;

  beforeAll(async () => {
    const client = tenantClient({ organizationId: SEED_IDS.organization, storeIds: [A] });
    const channel = await client.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 AND code = 'web'`,
      [A],
    );
    const cart = await createCart(client, {
      organizationId: SEED_IDS.organization,
      storeId: A,
      salesChannelId: channel.rows[0]!.id,
    });
    const variant = await client.query<{ id: string }>(
      `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
       JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
       JOIN inventory_level il ON il.variant_id = v.id AND il.available >= 5
       WHERE v.store_id = $1 ORDER BY v.sku DESC LIMIT 1`,
      [A],
    );
    await addLineItem(client, cart.id, { variant_id: variant.rows[0]!.id, quantity: 2 });
    const option = await client.query<{ id: string }>(
      `SELECT id FROM shipping_option WHERE store_id = $1 AND code = 'standard'`,
      [A],
    );
    const address = {
      first_name: 'Ret',
      last_name: 'Urn',
      line1: 'Dam 1',
      city: 'Amsterdam',
      postal_code: '1012 JS',
      country: 'NL',
    };
    await updateCart(client, cart.id, {
      email: 'ret.urn@example.com',
      shipping_address: address,
      billing_address: address,
      shipping_option_id: option.rows[0]!.id,
    });
    await createPaymentSession(client, cart.id, { provider: 'manual' });
    const { order } = await completeCart(client, {
      cartId: cart.id,
      idempotencyKey: `admin-returns-${cart.id}`,
      actor: customer,
    });
    orderId = order.id;
    lineId = order.items[0]!.id;
    await confirmOrder(client, orderId, system);
    await markPaymentCaptured(client, orderId, system);
    await db.owner.query(
      `UPDATE payment SET status = 'captured', captured_at = now() WHERE order_id = $1`,
      [orderId],
    );
    await markShipmentCreated(client, orderId, system);
    await markShipped(client, orderId, [{ lineItemId: lineId, quantity: 2 }], system);
  });

  it('POST …/orders/{orderId}/returns: support; body validated; 201 Return; over the shipped quantity → 409', async () => {
    const forbidden = await analyst.post(`/admin/stores/${A}/orders/${orderId}/returns`, {
      items: [{ order_line_item_id: lineId, quantity: 1 }],
    });
    expect(forbidden.status).toBe(403);
    const bad = await support.post(`/admin/stores/${A}/orders/${orderId}/returns`, { items: [] });
    expect(bad.status).toBe(400);
    const over = await support.post(`/admin/stores/${A}/orders/${orderId}/returns`, {
      items: [{ order_line_item_id: lineId, quantity: 5 }],
    });
    expect(over.status).toBe(409);
    spec.assertSchema('Error', over.body);
    const res = await support.post(`/admin/stores/${A}/orders/${orderId}/returns`, {
      items: [{ order_line_item_id: lineId, quantity: 1 }],
      reason: 'wrong size',
    });
    expect(res.status).toBe(201);
    spec.assertSchema('Return', res.body);
    expect(res.body).toMatchObject({
      order_id: orderId,
      status: 'requested',
      reason: 'wrong size',
      items: [{ order_line_item_id: lineId, quantity: 1, condition: null }],
    });
    const viaB = await support.post(`/admin/stores/${B}/orders/${orderId}/returns`, {
      items: [{ order_line_item_id: lineId, quantity: 1 }],
    });
    expect(viaB.status).toBe(404);
  });

  it('POST …/returns/{returnId}/receive: operations only; store path must match; 200 Return refunded (manual)', async () => {
    const created = await support.post(`/admin/stores/${A}/orders/${orderId}/returns`, {
      items: [{ order_line_item_id: lineId, quantity: 1 }],
    });
    expect(created.status).toBe(201);
    const returnId = created.body.id as string;
    const forbidden = await storeAdmin.post(`/admin/stores/${A}/returns/${returnId}/receive`, {
      warehouse_id: SEED_IDS.warehouses.eu,
      items: [{ order_line_item_id: lineId, quantity: 1, condition: 'resellable' }],
    });
    expect(forbidden.status).toBe(403);
    const wrongStore = await operations.post(`/admin/stores/${B}/returns/${returnId}/receive`, {
      warehouse_id: SEED_IDS.warehouses.eu,
      items: [{ order_line_item_id: lineId, quantity: 1, condition: 'resellable' }],
    });
    expect(wrongStore.status).toBe(404);
    const badBody = await operations.post(`/admin/stores/${A}/returns/${returnId}/receive`, {
      warehouse_id: SEED_IDS.warehouses.eu,
      items: [{ order_line_item_id: lineId, quantity: 1, condition: 'meh' }],
    });
    expect(badBody.status).toBe(400);
    const res = await operations.post(`/admin/stores/${A}/returns/${returnId}/receive`, {
      warehouse_id: SEED_IDS.warehouses.eu,
      items: [{ order_line_item_id: lineId, quantity: 1, condition: 'resellable' }],
    });
    expect(res.status).toBe(200);
    spec.assertSchema('Return', res.body);
    expect(res.body).toMatchObject({
      status: 'refunded',
      warehouse_id: SEED_IDS.warehouses.eu,
      items: [{ order_line_item_id: lineId, quantity: 1, condition: 'resellable' }],
    });
    const order = await storeStaff.get(`/admin/stores/${A}/orders/${orderId}`);
    expect(order.body.returns.map((r: { id: string }) => r.id)).toContain(returnId);
    expect(order.body.items[0].returned_quantity).toBe(1);
  });
});
