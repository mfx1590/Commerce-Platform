// Product media (task 2.3, #136) on a seeded throwaway database through the media router with dev-token
// principals: alt required, positions contiguous after add / move / delete, thumbnail follows position 0,
// audit + product.updated event on every change, signed upload params never expose the secret and answer 409
// without credentials (URL passthrough mode), product of another store → 404 (RLS).
import express from 'express';
import request from 'supertest';
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier } from '../../http';
import { closePool, initDb } from '../../lib/db';
import { mountCoreMiddleware } from '../../server';
import { signParams, mediaRouter, type ProductMedia } from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const SECRET = 'never-in-a-response-1234';
const creds = {
  cloudName: 'demo',
  apiKey: '123456789012345',
  apiSecret: SECRET,
  source: 'global' as const,
};

let db: TestDatabase;
let app: express.Express;
let noCreds: express.Express;
let a: ReturnType<typeof createTenantClient>;
let productA: string;
let variantA: string;
let productB: string;

const as = (subject: string, target: () => express.Express = () => app) => ({
  get: (path: string) => request(target()).get(path).set('Authorization', `Bearer dev:${subject}`),
  post: (path: string, body?: unknown) =>
    request(target()).post(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  patch: (path: string, body?: unknown) =>
    request(target()).patch(path).set('Authorization', `Bearer dev:${subject}`).send(body),
  delete: (path: string) =>
    request(target()).delete(path).set('Authorization', `Bearer dev:${subject}`),
});
const staff = as('seed-store-staff');
const analyst = as('seed-analyst');
const mediaPath = (product: string) => `/admin/stores/${A}/products/${product}/media`;
const cld = (name: string) =>
  `https://res.cloudinary.com/demo/image/upload/v1/products/brand-a/${name}.jpg`;

beforeAll(async () => {
  db = await createTestDatabase('core_media');
  await seed(db.owner, { productsPerStore: 6, log: () => {} });
  process.env.CORE_DEV_TOKENS = '1';
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });

  const fixedNow = () => new Date('2026-09-08T12:00:00Z');
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier());
  app.use(mediaRouter({ credentialsFor: () => creds, now: fixedNow }));
  app.use(coreErrorHandler);
  noCreds = express();
  mountCoreMiddleware(noCreds, new DevTokenVerifier());
  noCreds.use(mediaRouter({ credentialsFor: () => null }));
  noCreds.use(coreErrorHandler);

  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
  productA = (
    await a.query<{ id: string }>(
      `SELECT id FROM product WHERE store_id = $1 ORDER BY handle LIMIT 1`,
      [A],
    )
  ).rows[0]!.id;
  variantA = (
    await a.query<{ id: string }>(`SELECT id FROM product_variant WHERE product_id = $1 LIMIT 1`, [
      productA,
    ])
  ).rows[0]!.id;
  productB = (
    await b.query<{ id: string }>(`SELECT id FROM product WHERE store_id = $1 LIMIT 1`, [B])
  ).rows[0]!.id;
  // start from a clean slate for the product under test (the seed gives it one picsum image)
  await db.owner.query(`DELETE FROM product_media WHERE product_id = $1`, [productA]);
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

async function positions(product = productA): Promise<[string, number][]> {
  const r = await a.query<{ id: string; position: number }>(
    `SELECT id, position FROM product_media WHERE product_id = $1 ORDER BY position`,
    [product],
  );
  return r.rows.map((x) => [x.id, x.position]);
}

async function thumbnail(product = productA): Promise<string | null> {
  const r = await a.query<{ thumbnail_url: string | null }>(
    `SELECT thumbnail_url FROM product WHERE id = $1`,
    [product],
  );
  return r.rows[0]!.thumbnail_url;
}

describe('signed upload params', () => {
  it('returns signed params without the secret; 409 without credentials; 404 for a foreign product', async () => {
    const res = await staff.post(`/admin/stores/${A}/media/upload-params`, {
      product_id: productA,
      filename: 'Front View.png',
    });
    expect(res.status).toBe(200);
    expect(res.body.upload_url).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    expect(res.body.api_key).toBe(creds.apiKey);
    expect(res.body.params.folder).toBe('products/brand-a');
    expect(res.body.params.public_id).toMatch(/^[0-9a-f]{8}-front-view-[a-z0-9]+$/);
    expect(res.body.timestamp).toBe(Math.floor(Date.parse('2026-09-08T12:00:00Z') / 1000));
    expect(res.body.signature).toBe(signParams(res.body.params, SECRET));
    expect(JSON.stringify(res.body)).not.toContain(SECRET);

    const off = await as('seed-store-staff', () => noCreds).post(
      `/admin/stores/${A}/media/upload-params`,
      { product_id: productA },
    );
    expect(off.status).toBe(409);
    expect(off.body.details).toEqual({ store_code: 'brand-a' });

    const foreign = await staff.post(`/admin/stores/${A}/media/upload-params`, {
      product_id: productB,
    });
    expect(foreign.status).toBe(404);

    const bad = await staff.post(`/admin/stores/${A}/media/upload-params`, { product_id: 'nope' });
    expect(bad.status).toBe(400);
  });
});

describe('product media items', () => {
  const ids: string[] = [];

  it('requires alt text and a variant of the product; appends with contiguous positions; thumbnail = first', async () => {
    const noAlt = await staff.post(mediaPath(productA), { url: cld('front') });
    expect(noAlt.status).toBe(400);
    const blankAlt = await staff.post(mediaPath(productA), { url: cld('front'), alt: '   ' });
    expect(blankAlt.status).toBe(400);
    expect(blankAlt.body.details['/alt']).toMatch(/blank/);
    const badVariant = await staff.post(mediaPath(productA), {
      url: cld('front'),
      alt: 'x',
      variant_id: '00000000-0000-4000-8000-0000000000ff',
    });
    expect(badVariant.status).toBe(400);
    const readOnly = await analyst.post(mediaPath(productA), { url: cld('front'), alt: 'x' });
    expect(readOnly.status).toBe(403);

    for (const [name, alt] of [
      ['front', 'Front view'],
      ['back', 'Back view'],
      ['detail', 'Detail'],
    ] as const) {
      const res = await staff.post(mediaPath(productA), {
        url: cld(name),
        alt: ` ${alt} `,
        variant_id: name === 'detail' ? variantA : null,
      });
      expect(res.status).toBe(201);
      const m = res.body as ProductMedia;
      expect(m.alt).toBe(alt);
      expect(m.variants.thumb).toContain('/upload/c_fill,w_400,h_400,g_auto,q_auto,f_auto/');
      ids.push(m.id);
    }
    expect(await positions()).toEqual([
      [ids[0], 0],
      [ids[1], 1],
      [ids[2], 2],
    ]);
    expect(await thumbnail()).toBe(cld('front'));
    const list = await analyst.get(mediaPath(productA));
    expect(list.status).toBe(200);
    expect((list.body.items as ProductMedia[]).map((m) => m.position)).toEqual([0, 1, 2]);
    expect((list.body.items as ProductMedia[])[2]!.variant_id).toBe(variantA);
  });

  it('inserts at a position and moves items; the others shift, no gaps or duplicates', async () => {
    const inserted = await staff.post(mediaPath(productA), {
      url: cld('inserted'),
      alt: 'Inserted',
      position: 1,
    });
    expect(inserted.status).toBe(201);
    expect(await positions()).toEqual([
      [ids[0], 0],
      [inserted.body.id, 1],
      [ids[1], 2],
      [ids[2], 3],
    ]);

    const moved = await staff.patch(`${mediaPath(productA)}/${ids[2]}`, {
      position: 0,
      alt: 'Detail (hero)',
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ id: ids[2], position: 0, alt: 'Detail (hero)' });
    expect(await positions()).toEqual([
      [ids[2], 0],
      [ids[0], 1],
      [inserted.body.id, 2],
      [ids[1], 3],
    ]);
    expect(await thumbnail()).toBe(cld('detail'));

    // out-of-range position clamps to the end
    const last = await staff.patch(`${mediaPath(productA)}/${ids[2]}`, { position: 99 });
    expect(last.body.position).toBe(3);
    expect(await thumbnail()).toBe(cld('front'));

    const empty = await staff.patch(`${mediaPath(productA)}/${ids[2]}`, {});
    expect(empty.status).toBe(400);
    ids.splice(1, 0, inserted.body.id); // order now: front, inserted, back, detail
  });

  it('delete renumbers the rest in their existing order and moves the thumbnail', async () => {
    const del = await staff.delete(`${mediaPath(productA)}/${ids[0]}`); // front (position 0)
    expect(del.status).toBe(204);
    expect(await positions()).toEqual([
      [ids[1], 0],
      [ids[2], 1],
      [ids[3], 2],
    ]);
    expect(await thumbnail()).toBe(cld('inserted'));
    expect((await staff.delete(`${mediaPath(productA)}/${ids[0]}`)).status).toBe(404);

    // an append after a delete never reuses a number
    const again = await staff.post(mediaPath(productA), { url: cld('new'), alt: 'New' });
    expect(again.body.position).toBe(3);
    const pos = (await positions()).map(([, p]) => p);
    expect(pos).toEqual([0, 1, 2, 3]);
    expect(new Set(pos).size).toBe(pos.length);
  });

  it('writes audit rows and product.updated events (changed_fields: media) on the same transaction', async () => {
    const audit = await a.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_type = 'product_media' AND entity_id = $1 ORDER BY created_at`,
      [productA],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['product.media.add', 'product.media.update', 'product.media.delete']),
    );
    const events = await a.query<{ payload: { changed_fields: string[]; product_id: string } }>(
      `SELECT payload FROM outbox WHERE topic = 'product.updated' AND aggregate_id = $1`,
      [productA],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(audit.rows.length);
    for (const e of events.rows) expect(e.payload.changed_fields).toEqual(['media']);
  });

  it('a product of another store is not found through this store (RLS)', async () => {
    expect((await staff.get(mediaPath(productB))).status).toBe(404);
    expect((await staff.post(mediaPath(productB), { url: cld('x'), alt: 'x' })).status).toBe(404);
  });
});
