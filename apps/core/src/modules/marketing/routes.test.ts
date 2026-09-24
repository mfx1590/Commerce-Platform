// The marketing Admin API routes over a seeded throwaway database (issue #145). Same setup as
// `test/admin-api.test.ts`: the real middleware chain on a bare Express app, dev tokens for the seeded staff
// subjects, permissions read from `admin-api.yaml`, responses checked against the spec's components.
//
// This file is also what proves the router works before window 1 mounts it in `src/http` (the REQUEST): it
// mounts `marketingAdminRouter()` exactly where `adminRouter()` sits in the chain.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../http';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import { specValidator } from '../../../test/helpers/openapi';
import {
  FilesystemFeedStorage,
  marketingAdminRouter,
  resetFeedStorage,
  setFeedStorage,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const spec = specValidator('admin-api.yaml');
const base = `/admin/stores/${A}/marketing`;

let db: TestDatabase;
let app: express.Express;
let feedsDir: string;

const as = (subject: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer dev:${subject}`),
  post: (path: string, body?: unknown) =>
    request(app).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  patch: (path: string, body?: unknown) =>
    request(app).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer dev:${subject}`),
});
const owner = as('seed-owner');
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
  // cart_recovery / marketing_cursor come from migration 0170 (#244, contracts-v0.4.5).
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  feedsDir = await mkdtemp(join(tmpdir(), 'feed-routes-'));
  setFeedStorage(
    new FilesystemFeedStorage({ dir: feedsDir, baseUrl: 'https://feeds.example/feeds' }),
  );
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier());
  app.use(marketingAdminRouter());
  app.use(coreErrorHandler);
}, 180_000);

afterAll(async () => {
  resetFeedStorage();
  await rm(feedsDir, { recursive: true, force: true });
  await closePool();
  await db?.drop();
});

beforeEach(async () => {
  await db.owner.query('DELETE FROM attribution');
  await db.owner.query('DELETE FROM "order"');
  await db.owner.query('DELETE FROM campaign');
  await db.owner.query('DELETE FROM product_feed');
  await db.owner.query('DELETE FROM segment_member');
  await db.owner.query('DELETE FROM segment');
  await db.owner.query('DELETE FROM customer');
  await db.owner.query('DELETE FROM cart_recovery');
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

describe('feed routes', () => {
  const feedPayload = {
    name: 'Google Shopping NL',
    channel: 'google_merchant',
    locale: 'en-GB',
    currency: 'EUR',
    filters: { in_stock_only: true },
    mapping: { brand: 'Brand A' },
  };

  async function createFeedViaApi(over: Record<string, unknown> = {}): Promise<string> {
    const res = await storeAdmin.post(`${base}/feeds`, { ...feedPayload, ...over });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('creates, reads, lists and updates in the contract shape', async () => {
    const created = await storeAdmin.post(`${base}/feeds`, feedPayload);
    expect(created.status).toBe(201);
    spec.assertSchema('ProductFeed', created.body);
    expect(created.body).toMatchObject({ store_id: A, status: 'draft', url: null, item_count: 0 });

    const read = await storeStaff.get(`${base}/feeds/${created.body.id}`);
    expect(read.status).toBe(200);
    spec.assertSchema('ProductFeed', read.body);

    const list = await storeStaff.get(`${base}/feeds?channel=google_merchant&status=draft`);
    expect(list.status).toBe(200);
    spec.assertPage('ProductFeed', list.body);
    expect(list.body.items).toHaveLength(1);

    const patched = await storeAdmin.patch(`${base}/feeds/${created.body.id}`, {
      ...feedPayload,
      name: 'Google Shopping NL v2',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('Google Shopping NL v2');

    expect((await storeAdmin.delete(`${base}/feeds/${created.body.id}`)).status).toBe(204);
    expect((await storeStaff.get(`${base}/feeds/${created.body.id}`)).status).toBe(404);
  });

  it('publishes and lists the computed items', async () => {
    const id = await createFeedViaApi();

    const published = await storeAdmin.post(`${base}/feeds/${id}/publish`);
    expect(published.status).toBe(200);
    spec.assertSchema('ProductFeed', published.body);
    expect(published.body).toMatchObject({ status: 'active' });
    expect(published.body.item_count).toBeGreaterThan(0);
    expect(published.body.url).toBe(`https://feeds.example/feeds/brand-a/${id}.xml`);

    const items = await storeStaff.get(`${base}/feeds/${id}/items?limit=3`);
    expect(items.status).toBe(200);
    spec.assertPage('FeedItem', items.body);
    expect(items.body.items).toHaveLength(3);
  });

  it('reports a broken feed as status error (a schema-valid ProductFeed since 0.4.1, #194)', async () => {
    await db.owner.query(`DELETE FROM store_domain WHERE store_id = $1`, [A]);
    try {
      const id = await createFeedViaApi();
      const published = await storeAdmin.post(`${base}/feeds/${id}/publish`);
      expect(published.status).toBe(200);
      expect(published.body.status).toBe('error');
      expect(published.body.item_count).toBe(0);
      spec.assertSchema('ProductFeed', published.body);
    } finally {
      await db.owner.query(
        `INSERT INTO store_domain (organization_id, store_id, hostname, is_primary)
         VALUES ($1, $2, 'shop.brand-a.local', true)
         ON CONFLICT (hostname) DO NOTHING`,
        [ORG, A],
      );
    }
  });

  it('validates the body and the channel', async () => {
    expect((await storeAdmin.post(`${base}/feeds`, { name: 'No channel' })).status).toBe(400);
    const badCurrency = await storeAdmin.post(`${base}/feeds`, {
      ...feedPayload,
      currency: 'GBP',
    });
    expect(badCurrency.status).toBe(400);
    expect(badCurrency.body.details.currency).toContain('not sold by this store');

    // A channel with no renderer is a 409 on publish, not an empty file.
    const tiktok = await createFeedViaApi({ name: 'TikTok', channel: 'tiktok' });
    const refused = await storeAdmin.post(`${base}/feeds/${tiktok}/publish`);
    expect(refused.status).toBe(409);
    spec.assertSchema('Error', refused.body);
  });

  it('store_staff reads, store_admin writes and publishes', async () => {
    const id = await createFeedViaApi();

    expect((await storeStaff.get(`${base}/feeds`)).status).toBe(200);
    expect((await storeStaff.get(`${base}/feeds/${id}/items`)).status).toBe(200);

    for (const res of [
      await storeStaff.post(`${base}/feeds`, feedPayload),
      await storeStaff.patch(`${base}/feeds/${id}`, feedPayload),
      await storeStaff.post(`${base}/feeds/${id}/publish`),
      await storeStaff.delete(`${base}/feeds/${id}`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
    }
  });
});

describe('segment routes', () => {
  const vipRules = {
    v: 1,
    all: [{ any: [{ field: 'total_spent_minor', op: 'gte', value: 50_000 }] }],
  };

  async function createSegmentViaApi(payloadBody: Record<string, unknown>): Promise<string> {
    const res = await storeAdmin.post(`${base}/segments`, payloadBody);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('creates, reads, lists and updates in the contract shape', async () => {
    const created = await storeAdmin.post(`${base}/segments`, {
      name: 'vip-buyers',
      description: 'Spent 500+ and opted in',
      rules: vipRules,
    });
    expect(created.status).toBe(201);
    spec.assertSchema('Segment', created.body);
    expect(created.body).toMatchObject({
      store_id: A,
      name: 'vip-buyers',
      materialised_count: 0,
      last_materialised_at: null,
      template_id: null,
    });

    const read = await storeStaff.get(`${base}/segments/${created.body.id}`);
    expect(read.status).toBe(200);
    spec.assertSchema('Segment', read.body);

    const list = await storeStaff.get(`${base}/segments?sort=name&order=asc`);
    expect(list.status).toBe(200);
    spec.assertPage('Segment', list.body);
    expect(list.body.items).toHaveLength(1);

    const patched = await storeAdmin.patch(`${base}/segments/${created.body.id}`, {
      name: 'vip-buyers',
      rules: { v: 1, all: [] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.rules).toEqual({ v: 1, all: [] });

    expect((await storeAdmin.delete(`${base}/segments/${created.body.id}`)).status).toBe(204);
  });

  it('previews without writing and materialises with 202', async () => {
    await db.owner.query(
      `INSERT INTO customer (organization_id, store_id, email, status, consent)
       VALUES ($1, $2, 'ada@example.test', 'registered', '{"marketing_email": {"granted": true}}'::jsonb),
              ($1, $2, 'linus@example.test', 'registered', '{}'::jsonb)`,
      [ORG, A],
    );
    const id = await createSegmentViaApi({
      name: 'opted-in',
      rules: { v: 1, all: [{ any: [{ field: 'consent', op: 'granted', value: 'email' }] }] },
    });

    const preview = await storeStaff.post(`${base}/segments/${id}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ count: 1 });

    // Rules in the body override the saved ones, so a rule builder can count before saving.
    const whatIf = await storeStaff.post(`${base}/segments/${id}/preview`, {
      rules: { v: 1, all: [] },
    });
    expect(whatIf.body).toEqual({ count: 2 });

    const materialised = await storeAdmin.post(`${base}/segments/${id}/materialize`);
    expect(materialised.status).toBe(202);
    spec.assertSchema('Segment', materialised.body);
    expect(materialised.body.materialised_count).toBe(1);
  });

  it('400s on rules outside the frozen grammar, naming the path', async () => {
    const unknownPredicate = await storeAdmin.post(`${base}/segments`, {
      name: 'bad-rules',
      rules: { v: 1, all: [{ any: [{ field: 'moon_phase', op: 'eq', value: 1 }] }] },
    });
    expect(unknownPredicate.status).toBe(400);
    spec.assertSchema('Error', unknownPredicate.body);
    // Since contracts-v0.4.4 froze SegmentRules in the document, the spec layer (validateBody) rejects
    // out-of-grammar input BEFORE the module parser, with AJV's dotted paths (rules.all.0.any.0…). The
    // module's own parser still names bracketed paths for direct calls — segments.test.ts covers those.
    expect(
      Object.keys(unknownPredicate.body.details as Record<string, string>).some((k) =>
        k.startsWith('rules.all.0.any.0'),
      ),
    ).toBe(true);

    // The old flat shape is refused — that is what "frozen grammar" means (CONTRACT CHANGE #239, landed).
    const flatShape = await storeAdmin.post(`${base}/segments`, {
      name: 'old-shape',
      rules: { total_spent_minor: { gte: 50_000 } },
    });
    expect(flatShape.status).toBe(400);
  });

  it('store_staff reads and previews, store_admin writes and materialises', async () => {
    const id = await createSegmentViaApi({ name: 'vip-buyers', rules: vipRules });

    expect((await storeStaff.get(`${base}/segments`)).status).toBe(200);
    expect((await storeStaff.post(`${base}/segments/${id}/preview`)).status).toBe(200);

    for (const res of [
      await storeStaff.post(`${base}/segments`, { name: 'nope', rules: vipRules }),
      await storeStaff.patch(`${base}/segments/${id}`, { name: 'nope', rules: vipRules }),
      await storeStaff.delete(`${base}/segments/${id}`),
      await storeStaff.post(`${base}/segments/${id}/materialize`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
    }
  });
});

describe('segment template routes (organization scope)', () => {
  const templates = '/admin/marketing/segment-templates';
  const vipRules = {
    v: 1,
    all: [{ any: [{ field: 'total_spent_minor', op: 'gte', value: 50_000 }] }],
  };

  it('owner writes templates, analyst reads them', async () => {
    const created = await owner.post(templates, { name: 'vip-template', rules: vipRules });
    expect(created.status).toBe(201);
    spec.assertSchema('Segment', created.body);
    expect(created.body.store_id).toBeNull();

    const listed = await analyst.get(templates);
    expect(listed.status).toBe(200);
    spec.assertPage('Segment', listed.body);
    expect(listed.body.items.map((t: { name: string }) => t.name)).toEqual(['vip-template']);

    expect((await analyst.get(`${templates}/${created.body.id}`)).status).toBe(200);

    const patched = await owner.patch(`${templates}/${created.body.id}`, {
      name: 'vip-template',
      rules: { v: 1, all: [] },
    });
    expect(patched.status).toBe(200);
    expect((await owner.delete(`${templates}/${created.body.id}`)).status).toBe(204);
  });

  it('a store role cannot read or write templates at all', async () => {
    const created = await owner.post(templates, { name: 'vip-template', rules: vipRules });
    expect(created.status).toBe(201);

    // Organization scope is the only scope templates exist in: a store admin is refused on read and on write.
    expect((await storeAdmin.get(templates)).status).toBe(403);
    expect((await storeStaff.get(templates)).status).toBe(403);
    expect((await storeAdmin.post(templates, { name: 'nope', rules: vipRules })).status).toBe(403);

    // An analyst may read but must not write — template writes are `owner`.
    expect((await analyst.post(templates, { name: 'nope', rules: vipRules })).status).toBe(403);
    expect((await analyst.delete(`${templates}/${created.body.id}`)).status).toBe(403);
  });

  it('a store segment copies a template a store role cannot otherwise see', async () => {
    const template = await owner.post(templates, { name: 'vip-template', rules: vipRules });
    expect(template.status).toBe(201);

    const segment = await storeAdmin.post(`${base}/segments`, {
      name: 'vip-buyers',
      template_id: template.body.id,
    });
    expect(segment.status).toBe(201);
    expect(segment.body.rules).toEqual(vipRules);
    expect(segment.body.template_id).toBe(template.body.id);
  });
});

describe('abandoned-cart report route', () => {
  // The operation is CONTRACT CHANGE #245 and is not in Admin API 0.4.3 yet, so the route falls back to the
  // proposed `viewer` permission and the response is asserted by shape rather than against the document. When
  // #245 lands, `spec.assertSchema('AbandonedCartReport', …)` replaces this and the fallback goes away.
  const report = `${base}/reports/abandoned-carts?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`;

  it('answers the proposed shape and is readable by staff and the HQ analyst alike', async () => {
    for (const who of [storeStaff, analyst]) {
      const res = await who.get(report);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        currency: 'EUR',
        abandoned_count: 0,
        redeemed_count: 0,
        recovered_count: 0,
        recovery_rate: 0,
      });
      expect(res.body.abandoned_value).toEqual({ amount_minor: 0, currency: 'EUR' });
      expect(res.body.recovered_value).toEqual({ amount_minor: 0, currency: 'EUR' });
    }
  });

  it('400s on a missing window and 401s without a token', async () => {
    const missing = await storeStaff.get(`${base}/reports/abandoned-carts`);
    expect(missing.status).toBe(400);
    spec.assertSchema('Error', missing.body);
    expect((await request(app).get(report)).status).toBe(401);
  });

  it('is refused for a store outside the principal scope', async () => {
    const other = `/admin/stores/${B}/marketing/reports/abandoned-carts?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`;
    expect((await storeStaff.get(other)).status).toBe(403);
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
