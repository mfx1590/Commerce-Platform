// The marketing Admin API routes over a seeded throwaway database (issue #145). Same setup as
// `test/admin-api.test.ts`: the real middleware chain on a bare Express app, dev tokens for the seeded staff
// subjects, permissions read from `admin-api.yaml`, responses checked against the spec's components.
//
// This file is also what proves the router works before window 1 mounts it in `src/http` (the REQUEST): it
// mounts `marketingAdminRouter()` exactly where `adminRouter()` sits in the chain.
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../http';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import { specValidator } from '../../../test/helpers/openapi';
import { marketingAdminRouter } from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const spec = specValidator('admin-api.yaml');
const base = `/admin/stores/${A}/marketing`;

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
const storeAdmin = as('seed-store-admin');
const storeStaff = as('seed-store-staff');
const analyst = as('seed-analyst');

const payload = {
  name: 'Autumn launch',
  type: 'paid_social',
  utm_source: 'meta',
  utm_medium: 'paid_social',
  utm_campaign: 'autumn-2026',
  budget: { amount_minor: 250_000, currency: 'EUR' },
};

async function createDraft(): Promise<string> {
  const res = await storeAdmin.post(`${base}/campaigns`, payload);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  db = await createTestDatabase('core_marketing_routes');
  await seed(db.owner, { productsPerStore: 4, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier());
  app.use(marketingAdminRouter());
  app.use(coreErrorHandler);
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

beforeEach(async () => {
  await db.owner.query('DELETE FROM attribution');
  await db.owner.query('DELETE FROM "order"');
  await db.owner.query('DELETE FROM campaign');
});

describe('campaign routes', () => {
  it('POST creates a draft and GET returns it in the contract shape', async () => {
    const created = await storeAdmin.post(`${base}/campaigns`, payload);
    expect(created.status).toBe(201);
    spec.assertSchema('Campaign', created.body);
    expect(created.body).toMatchObject({ store_id: A, status: 'draft' });

    const read = await storeStaff.get(`${base}/campaigns/${created.body.id}`);
    expect(read.status).toBe(200);
    spec.assertSchema('Campaign', read.body);

    const list = await storeStaff.get(`${base}/campaigns?status=draft&type=paid_social`);
    expect(list.status).toBe(200);
    spec.assertPage('Campaign', list.body);
    expect(list.body.items).toHaveLength(1);
  });

  it('PATCH updates, DELETE removes a draft, launch and end move the status', async () => {
    const id = await createDraft();

    const patched = await storeAdmin.patch(`${base}/campaigns/${id}`, {
      ...payload,
      name: 'Autumn launch v2',
    });
    expect(patched.status).toBe(200);
    spec.assertSchema('Campaign', patched.body);
    expect(patched.body.name).toBe('Autumn launch v2');

    const launched = await storeAdmin.post(`${base}/campaigns/${id}/launch`);
    expect(launched.status).toBe(200);
    spec.assertSchema('Campaign', launched.body);
    expect(launched.body.status).toBe('active');

    // Launched, so DELETE is a 409 with the contract error body — the contract says "end it instead".
    const refused = await storeAdmin.delete(`${base}/campaigns/${id}`);
    expect(refused.status).toBe(409);
    spec.assertSchema('Error', refused.body);
    expect(refused.body.code).toBe('conflict');

    const ended = await storeAdmin.post(`${base}/campaigns/${id}/end`);
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('ended');

    const draft = await createDraft();
    expect((await storeAdmin.delete(`${base}/campaigns/${draft}`)).status).toBe(204);
  });

  it('validates the body against the spec and the path parameters', async () => {
    const bad = await storeAdmin.post(`${base}/campaigns`, { name: 'No type' });
    expect(bad.status).toBe(400);
    spec.assertSchema('Error', bad.body);
    expect(bad.body.code).toBe('validation_error');

    const badEnum = await storeAdmin.post(`${base}/campaigns`, {
      ...payload,
      type: 'carrier-pigeon',
    });
    expect(badEnum.status).toBe(400);

    // Rules the OpenAPI schema cannot express, enforced by the service and rendered as 400, not 500.
    const badWindow = await storeAdmin.post(`${base}/campaigns`, {
      ...payload,
      starts_at: '2026-10-01T00:00:00Z',
      ends_at: '2026-09-01T00:00:00Z',
    });
    expect(badWindow.status).toBe(400);
    expect(badWindow.body.details).toMatchObject({ ends_at: 'must not be before starts_at' });

    expect((await storeStaff.get(`${base}/campaigns/not-a-uuid`)).status).toBe(400);
    expect(
      (await storeStaff.get(`${base}/campaigns/70000000-0000-4000-8000-000000000999`)).status,
    ).toBe(404);
    expect((await storeStaff.get(`${base}/campaigns?limit=0`)).status).toBe(400);
    expect((await storeStaff.get(`${base}/campaigns?status=nonsense`)).status).toBe(400);
  });
});

describe('permissions (x-permission from admin-api.yaml)', () => {
  it('store_staff reads but does not write; store_admin writes', async () => {
    const id = await createDraft();

    expect((await storeStaff.get(`${base}/campaigns`)).status).toBe(200);

    for (const res of [
      await storeStaff.post(`${base}/campaigns`, payload),
      await storeStaff.patch(`${base}/campaigns/${id}`, payload),
      await storeStaff.delete(`${base}/campaigns/${id}`),
      await storeStaff.post(`${base}/campaigns/${id}/launch`),
      await storeStaff.post(`${base}/campaigns/${id}/end`),
    ]) {
      expect(res.status).toBe(403);
      spec.assertSchema('Error', res.body);
      expect(res.body.code).toBe('forbidden');
    }
  });

  it('reports are viewer: the HQ analyst reads them, and campaigns stay closed to it', async () => {
    const report = await analyst.get(
      `${base}/reports/attribution?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
    );
    expect(report.status).toBe(200);
    spec.assertSchema('AttributionReport', report.body);

    // `viewer` on the store is not `store_staff`: the analyst may read the numbers, not the campaign rows.
    expect((await analyst.post(`${base}/campaigns`, payload)).status).toBe(403);
  });

  it('rejects an unauthenticated request and a store outside the principal scope', async () => {
    expect((await request(app).get(`${base}/campaigns`)).status).toBe(401);

    // The seeded store-staff user is scoped to brand A only.
    const other = await storeStaff.get(`/admin/stores/${B}/marketing/campaigns`);
    expect(other.status).toBe(403);
  });
});

describe('attribution report route', () => {
  it('answers the contract shape and defaults touch to last', async () => {
    const channel = await db.owner.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
      [A],
    );
    const address = JSON.stringify({
      first_name: 'Test',
      last_name: 'Buyer',
      line1: '1 Test Street',
      city: 'Amsterdam',
      postal_code: '1011AA',
      country: 'NL',
    });
    const order = await db.owner.query<{ id: string }>(
      `INSERT INTO "order" (organization_id, store_id, sales_channel_id, email, currency, locale, status,
                            shipping_address, billing_address, subtotal_minor, total_minor, placed_at)
       VALUES ($1, $2, $3, 'buyer@example.com', 'EUR', 'en-GB', 'confirmed', $4, $4, 9900, 9900,
               '2026-09-15T10:00:00Z')
       RETURNING id`,
      [ORG, A, channel.rows[0]!.id, address],
    );
    await db.owner.query(
      `INSERT INTO attribution (organization_id, store_id, order_id, touch, utm_source, utm_medium, utm_campaign,
                                captured_at)
       VALUES ($1, $2, $3, 'last', 'meta', 'paid_social', 'autumn-2026', '2026-09-15T09:00:00Z')`,
      [ORG, A, order.rows[0]!.id],
    );
    await createDraft();

    const res = await storeStaff.get(
      `${base}/reports/attribution?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
    );
    expect(res.status).toBe(200);
    spec.assertSchema('AttributionReport', res.body);
    expect(res.body).toMatchObject({
      touch: 'last',
      currency: 'EUR',
      totals: { orders_count: 1, revenue: { amount_minor: 9900, currency: 'EUR' } },
    });
    expect(res.body.items[0]).toMatchObject({ utm_source: 'meta', orders_count: 1 });
    // The draft campaign carries the same utm_campaign, so the report links it without any pixel involved.
    expect(res.body.items[0].campaign_id).not.toBeNull();
  });

  it('400s on a missing window or an unknown touch', async () => {
    expect((await storeStaff.get(`${base}/reports/attribution`)).status).toBe(400);
    expect(
      (
        await storeStaff.get(
          `${base}/reports/attribution?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&touch=middle`,
        )
      ).status,
    ).toBe(400);
  });
});
