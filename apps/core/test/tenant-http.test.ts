// RLS proven THROUGH THE HTTP LAYER (issue #3): the exact middleware chain src/server.ts mounts, on a bare
// Express app with two minimal probe handlers under /store/_probe (the contract routes live in the same
// chain, see test/store-api.test.ts), against a seeded throwaway database (packages/db `seed()`, 3 stores).
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DevTokenVerifier,
  handle,
  requirePrincipal,
  requireTenant,
  storeClientFor,
} from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { notFound } from '../src/lib/errors';
import { createApiKey, revokeApiKey } from '../src/modules/registry';
import { mountCoreMiddleware } from '../src/server';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const KEY_A = SEED_IDS.publishableKeys.brandA;
const KEY_B = SEED_IDS.publishableKeys.brandB;

let db: TestDatabase;
let app: express.Express;
let productA: { id: string; handle: string };

beforeAll(async () => {
  db = await createTestDatabase('core_tenant');
  await seed(db.owner, { productsPerStore: 5, log: () => {} });
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });

  const hq = createOrganizationClient(db.owner, { organizationId: ORG });
  const r = await hq.query<{ id: string; handle: string }>(
    'SELECT id, handle FROM product WHERE store_id = $1 ORDER BY handle LIMIT 1',
    [A],
  );
  productA = r.rows[0]!;

  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier());
  app.get(
    '/store/_probe/products',
    handle(async (req, res) => {
      const { client } = requireTenant(req);
      const rows = await client.query<{ id: string; store_id: string }>(
        'SELECT id, store_id FROM product ORDER BY handle',
      );
      res.json({ items: rows.rows });
    }),
  );
  app.get(
    '/store/_probe/products/:id',
    handle(async (req, res) => {
      const { client } = requireTenant(req);
      const rows = await client.query<{ id: string }>('SELECT id FROM product WHERE id = $1', [
        req.params.id,
      ]);
      if (!rows.rows[0]) throw notFound('product', req.params.id);
      res.json(rows.rows[0]);
    }),
  );
  app.get(
    '/admin/stores/:storeId/ping',
    handle(async (req, res) => {
      const client = storeClientFor(requirePrincipal(req), req.params.storeId!);
      const stores = await client.query<{ code: string }>('SELECT code FROM store');
      res.json({ stores: stores.rows.map((s) => s.code) });
    }),
  );
  app.get(
    '/admin/_probe/me',
    handle(async (req, res) => {
      const p = requirePrincipal(req);
      res.json({
        email: p.user.email,
        organization_relations: p.organizationRelations,
        stores: p.stores.map((s) => ({ code: s.code, relations: s.relations })),
      });
    }),
  );
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

describe('Store API tenant context (X-Publishable-Key)', () => {
  it('brand-a key lists only brand-a products', async () => {
    const res = await request(app).get('/store/_probe/products').set('X-Publishable-Key', KEY_A);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(new Set(res.body.items.map((p: { store_id: string }) => p.store_id))).toEqual(
      new Set([A]),
    );
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('brand-b key cannot fetch a brand-a product by id (404), brand-a key can', async () => {
    const asB = await request(app)
      .get(`/store/_probe/products/${productA.id}`)
      .set('X-Publishable-Key', KEY_B);
    expect(asB.status).toBe(404);
    expect(asB.body).toEqual({ code: 'not_found', message: `product ${productA.id} not found` });

    const asA = await request(app)
      .get(`/store/_probe/products/${productA.id}`)
      .set('X-Publishable-Key', KEY_A);
    expect(asA.status).toBe(200);
    expect(asA.body.id).toBe(productA.id);
  });

  it('missing, unknown and revoked keys are refused with 401 { code: unauthorized }', async () => {
    const missing = await request(app).get('/store/_probe/products');
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('unauthorized');

    const unknown = await request(app)
      .get('/store/_probe/products')
      .set('X-Publishable-Key', 'pk_nope');
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('unauthorized');

    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const created = await createApiKey(hq, A, { name: 'temp', type: 'publishable' });
    const before = await request(app)
      .get('/store/_probe/products')
      .set('X-Publishable-Key', created.key);
    expect(before.status).toBe(200);
    await revokeApiKey(hq, A, created.id);
    const after = await request(app)
      .get('/store/_probe/products')
      .set('X-Publishable-Key', created.key);
    expect(after.status).toBe(401);
  });

  it('echoes a client-supplied X-Request-Id', async () => {
    const res = await request(app)
      .get('/store/_probe/products')
      .set('X-Publishable-Key', KEY_A)
      .set('X-Request-Id', 'req-42');
    expect(res.headers['x-request-id']).toBe('req-42');
  });
});

describe('Admin API staff principal (Phase 1 dev tokens → role_assignment)', () => {
  it('401 without a token, with a non-dev token, and for an unknown subject', async () => {
    expect((await request(app).get('/admin/_probe/me')).status).toBe(401);
    expect(
      (
        await request(app)
          .get('/admin/_probe/me')
          .set('Authorization', 'Bearer eyJhbGciOiJSUzI1NiJ9.x.y')
      ).status,
    ).toBe(401);
    const unknown = await request(app)
      .get('/admin/_probe/me')
      .set('Authorization', 'Bearer dev:nobody');
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('unauthorized');
  });

  it('resolves the seeded store-admin with brand-a and brand-b relations', async () => {
    const res = await request(app)
      .get('/admin/_probe/me')
      .set('Authorization', 'Bearer dev:seed-store-admin');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('store-admin@example.com');
    expect(res.body.organization_relations).toEqual([]);
    expect(res.body.stores).toEqual([
      { code: 'brand-a', relations: ['store_admin'] },
      { code: 'brand-b', relations: ['store_admin'] },
    ]);
  });

  it('store-staff (brand-a only) gets 200 on brand-a and 403 on brand-b; owner sees both', async () => {
    const ok = await request(app)
      .get(`/admin/stores/${A}/ping`)
      .set('Authorization', 'Bearer dev:seed-store-staff');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ stores: ['brand-a'] });

    const denied = await request(app)
      .get(`/admin/stores/${B}/ping`)
      .set('Authorization', 'Bearer dev:seed-store-staff');
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ code: 'forbidden', message: 'store is outside your scope' });

    const owner = await request(app)
      .get(`/admin/stores/${B}/ping`)
      .set('Authorization', 'Bearer dev:seed-owner');
    expect(owner.status).toBe(200);
    expect(owner.body).toEqual({ stores: ['brand-b'] });
  });

  it('dev tokens are refused in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(new DevTokenVerifier().verify('dev:seed-owner')).rejects.toMatchObject({
        code: 'unauthorized',
      });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
