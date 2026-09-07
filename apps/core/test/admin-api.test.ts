// Admin API routes (issue #7): the exact chain src/server.ts mounts on a bare Express app over a fully seeded
// throwaway database. Permissions come from admin-api.yaml `x-permission` (Phase 1 stub over role_assignment),
// bodies are validated against the spec, responses are checked against the spec's components.
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
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
  mountCoreMiddleware(app, new DevTokenVerifier());
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
