import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMedia,
  archiveProduct,
  createCategory,
  deleteMedia,
  updateMedia,
  createProduct,
  createVariant,
  getProduct,
  getStoreProduct,
  listCategories,
  listProducts,
  listStoreCategories,
  listStoreProducts,
  publishProduct,
  updateProduct,
  updateVariant,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: SEED_IDS.users.storeStaff, type: 'staff' as const, requestId: 'req-cat' };

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;

beforeAll(async () => {
  db = await createTestDatabase('core_catalog');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A], actorId: actor.id });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B] });
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

describe('store read model (seeded brand-a)', () => {
  it('lists 200 published products with EUR prices, 24 per page', async () => {
    const page = await listStoreProducts(a, A, 'EUR', { limit: 24 });
    expect(page.total).toBe(200);
    expect(page.items).toHaveLength(24);
    for (const item of page.items) {
      expect(item.price.currency).toBe('EUR');
      expect(item.price.amount_minor).toBeGreaterThan(0);
      expect(item.category_handle).toBeTruthy();
      expect(item.thumbnail_url).toMatch(/^https:\/\//);
    }
    const last = await listStoreProducts(a, A, 'EUR', { limit: 24, page: 9 });
    expect(last.items).toHaveLength(200 - 8 * 24);
  });

  it('sorts by price and filters by category (including children) and tag', async () => {
    const asc = await listStoreProducts(a, A, 'EUR', { sort: 'price_asc', limit: 5 });
    const desc = await listStoreProducts(a, A, 'EUR', { sort: 'price_desc', limit: 5 });
    expect(asc.items[0]!.price.amount_minor).toBeLessThanOrEqual(asc.items[4]!.price.amount_minor);
    expect(desc.items[0]!.price.amount_minor).toBeGreaterThanOrEqual(
      asc.items[0]!.price.amount_minor,
    );

    const tops = await listStoreProducts(a, A, 'EUR', { category: 'tops', limit: 1 });
    const tees = await listStoreProducts(a, A, 'EUR', { category: 't-shirts', limit: 1 });
    const hoodies = await listStoreProducts(a, A, 'EUR', { category: 'hoodies', limit: 1 });
    expect(tops.total).toBe(tees.total + hoodies.total);
    expect(tees.total).toBeGreaterThan(0);

    const tagged = await listStoreProducts(a, A, 'EUR', { tag: 'jeans', limit: 1 });
    expect(tagged.total).toBeGreaterThan(0);
    expect((await listStoreProducts(a, A, 'EUR', { category: 'nope' })).total).toBe(0);
  });

  it('returns a product by handle with variants, prices, options and media; nothing in a foreign currency', async () => {
    const first = (await listStoreProducts(a, A, 'EUR', { limit: 1 })).items[0]!;
    const product = await getStoreProduct(a, A, 'EUR', first.handle);
    expect(product.status).toBe('published');
    expect(product.category?.handle).toBe(first.category_handle);
    expect(product.options.map((o) => o.name)).toEqual(['Size', 'Color']);
    expect(product.variants.length).toBeGreaterThan(0);
    for (const v of product.variants) {
      expect(v.price).toEqual(first.price);
      expect(Object.keys(v.options).sort()).toEqual(['Color', 'Size']);
      expect(typeof v.in_stock).toBe('boolean');
    }
    expect(product.media[0]!.url).toBe(first.thumbnail_url);

    // not sold in USD → the same 404 as an unknown handle (#157 review nit, task 2.2)
    await expect(getStoreProduct(a, A, 'USD', first.handle)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await listStoreProducts(a, A, 'USD')).total).toBe(0);
  });

  it('a variant with 0 available is out of stock; an unmanaged variant is in stock with null quantity', async () => {
    const first = (await listStoreProducts(a, A, 'EUR', { limit: 1 })).items[0]!;
    const before = await getStoreProduct(a, A, 'EUR', first.handle);
    const target = before.variants[0]!;
    await owner.query(
      'UPDATE inventory_level SET on_hand = 0, reserved = 0 WHERE variant_id = $1',
      [target.id],
    );
    const after = await getStoreProduct(a, A, 'EUR', first.handle);
    const v = after.variants.find((x) => x.id === target.id)!;
    expect(v).toMatchObject({ in_stock: false, available_quantity: 0, allow_backorder: false });

    await updateVariant(a, A, target.id, { manage_inventory: false }, actor);
    const unmanaged = (await getStoreProduct(a, A, 'EUR', first.handle)).variants.find(
      (x) => x.id === target.id,
    )!;
    expect(unmanaged).toMatchObject({ in_stock: true, available_quantity: null });
  });

  it('brand-b cannot read brand-a products; store categories are active and flat', async () => {
    const first = (await listStoreProducts(a, A, 'EUR', { limit: 1 })).items[0]!;
    await expect(getStoreProduct(b, A, 'EUR', first.handle)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await listStoreProducts(b, A, 'GBP')).total).toBe(0);
    expect((await listStoreProducts(b, B, 'GBP')).total).toBe(200);

    const cats = await listStoreCategories(a, A);
    expect(cats.map((c) => c.handle)).toContain('t-shirts');
    expect(cats.find((c) => c.handle === 't-shirts')!.parent_id).toBe(
      cats.find((c) => c.handle === 'tops')!.id,
    );
  });
});

describe('admin catalog: products, variants, events', () => {
  it('create → publish yields exactly product.updated then product.published', async () => {
    const created = await createProduct(
      a,
      A,
      {
        handle: 'test-crew-tee',
        title: 'Test Crew Tee',
        options: [{ name: 'Size', values: ['S', 'M'] }],
        media: [{ url: 'https://example.com/tee.jpg', alt: 'Tee' }],
        tags: ['test'],
      },
      actor,
    );
    expect(created).toMatchObject({
      status: 'draft',
      published_at: null,
      thumbnail_url: 'https://example.com/tee.jpg',
    });
    expect(created.options[0]).toMatchObject({ name: 'Size', values: ['S', 'M'], position: 0 });

    const published = await publishProduct(a, A, created.id, actor);
    expect(published.status).toBe('published');
    expect(published.published_at).toMatch(/^\d{4}-/);

    const events = await a.query<{
      topic: string;
      version: number;
      store_id: string;
      published_at: Date | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT topic, version, store_id, published_at, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
      [created.id],
    );
    expect(events.rows.map((e) => e.topic)).toEqual(['product.updated', 'product.published']);
    for (const e of events.rows) {
      expect(e.version).toBe(1);
      expect(e.store_id).toBe(A);
      expect(e.published_at).toBeNull();
    }
    expect(events.rows[0]!.payload).toMatchObject({
      handle: 'test-crew-tee',
      status: 'draft',
      variants: [],
    });
    expect(events.rows[1]!.payload).toMatchObject({
      handle: 'test-crew-tee',
      title: 'Test Crew Tee',
    });

    // idempotent second publish: no new event
    await publishProduct(a, A, created.id, actor);
    const again = await a.query(`SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1`, [
      created.id,
    ]);
    expect(again.rows[0]!.n).toBe(2);

    const audit = await a.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at`,
      [created.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['product.create', 'product.publish']);
  });

  it('variants: options must match, prices land on the default list, sku is unique, product.updated emitted', async () => {
    const product = (await listProducts(a, A, { q: 'test-crew-tee' })).items[0]!;
    await expect(
      createVariant(a, A, product.id, { sku: 'TEST-XL', title: 'XL', options: { Size: 'XL' } }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      createVariant(a, A, product.id, {
        sku: 'TEST-S',
        title: 'S',
        prices: [{ currency: 'USD', amount_minor: 100 }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error', details: { currency: 'USD' } });

    const s = await createVariant(
      a,
      A,
      product.id,
      {
        sku: 'TEST-S',
        title: 'S',
        options: { Size: 'S' },
        prices: [{ currency: 'EUR', amount_minor: 1999, compare_at_minor: 2499 }],
      },
      actor,
    );
    expect(s.prices).toEqual([
      expect.objectContaining({
        currency: 'EUR',
        amount_minor: 1999,
        compare_at_minor: 2499,
        min_quantity: 1,
      }),
    ]);
    expect(s.inventory).toEqual([]);
    await expect(
      createVariant(a, A, product.id, { sku: 'TEST-S', title: 'dup' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });

    const updated = await updateVariant(
      a,
      A,
      s.id,
      { prices: [{ currency: 'EUR', amount_minor: 1499 }] },
      actor,
    );
    expect(updated.prices[0]).toMatchObject({ amount_minor: 1499, compare_at_minor: null });

    const store = await getStoreProduct(a, A, 'EUR', 'test-crew-tee');
    expect(store.variants).toEqual([
      expect.objectContaining({
        sku: 'TEST-S',
        price: { amount_minor: 1499, currency: 'EUR' },
        compare_at_price: null,
        in_stock: false,
        available_quantity: 0,
      }),
    ]);

    const topics = await a.query<{ topic: string; payload: { changed_fields: string[] } }>(
      `SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
      [product.id],
    );
    expect(topics.rows.slice(2).map((e) => e.topic)).toEqual([
      'product.updated',
      'product.updated',
    ]);
    expect(topics.rows[2]!.payload.changed_fields).toEqual(['variants']);
  });

  it('update emits changed fields, archive emits product.archived, duplicate handle → 409', async () => {
    const product = (await listProducts(a, A, { q: 'test-crew-tee' })).items[0]!;
    const same = await updateProduct(a, A, product.id, { title: 'Test Crew Tee' }, actor);
    expect(same.title).toBe('Test Crew Tee');
    const changed = await updateProduct(
      a,
      A,
      product.id,
      { title: 'Test Crew Tee v2', tags: ['test', 'v2'] },
      actor,
    );
    expect(changed).toMatchObject({ title: 'Test Crew Tee v2', tags: ['test', 'v2'] });

    const archived = await archiveProduct(a, A, product.id, actor);
    expect(archived.status).toBe('archived');
    await expect(publishProduct(a, A, product.id)).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(getStoreProduct(a, A, 'EUR', 'test-crew-tee')).rejects.toMatchObject({
      code: 'not_found',
    });

    const events = await a.query<{ topic: string; payload: Record<string, unknown> }>(
      `SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
      [product.id],
    );
    const tail = events.rows.slice(-2);
    expect(tail.map((e) => e.topic)).toEqual(['product.updated', 'product.archived']);
    expect(tail[0]!.payload.changed_fields).toEqual(['tags', 'title']);
    expect(tail[1]!.payload).toMatchObject({ handle: 'test-crew-tee' });
    expect(String(tail[1]!.payload.archived_at)).toMatch(/^\d{4}-/);

    await expect(
      createProduct(a, A, { handle: 'test-crew-tee', title: 'Dup' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await listProducts(a, A, { status: 'archived' })).total).toBe(1);
    expect((await listProducts(a, A)).total).toBe(201);
  });

  it('categories: tree via parent_id, unique handle per store, admin list and get respect scope', async () => {
    const cats = await listCategories(a, A);
    const tops = cats.find((c) => c.handle === 'tops')!;
    const child = await createCategory(
      a,
      A,
      { handle: 'tank-tops', name: 'Tank tops', parent_id: tops.id },
      actor,
    );
    expect(child).toMatchObject({ handle: 'tank-tops', parent_id: tops.id, is_active: true });
    await expect(createCategory(a, A, { handle: 'tank-tops', name: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      createCategory(a, A, { handle: 'orphan', name: 'x', parent_id: B }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });

    const productA = (await listProducts(a, A, { status: 'published', limit: 1 })).items[0]!;
    await expect(getProduct(b, A, productA.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listProducts(b, A)).total).toBe(0);
    const full = await getProduct(a, A, productA.id);
    expect(full.variants[0]!.inventory.length).toBeGreaterThan(0);
    expect(full.variants[0]!.prices[0]!.currency).toBe('EUR');
  });
});

describe('media public functions (#179 part 1, task 2.6)', () => {
  it('add / move / retarget / delete keep positions contiguous, the thumbnail on position 0, one product.updated ["media"] each', async () => {
    const list = await listStoreProducts(a, A, 'EUR', { limit: 1, sort: 'price_desc' });
    const productId = list.items[0]!.id;
    const before = await getProduct(a, A, productId);
    const n0 = before.media.length;
    const events = async () =>
      (
        await owner.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM outbox WHERE topic = 'product.updated' AND aggregate_id::text = $1::text ORDER BY occurred_at, id`,
          [productId],
        )
      ).rows.map((r) => r.payload.changed_fields);
    const e0 = (await events()).length;

    const added = await addMedia(
      a,
      A,
      productId,
      { url: 'https://picsum.photos/seed/new/600', alt: 'new' },
      actor,
    );
    expect(added.media).toHaveLength(n0 + 1);
    expect(added.media.map((m) => m.position)).toEqual([...Array(n0 + 1).keys()]);
    expect(added.media.at(-1)).toMatchObject({
      url: 'https://picsum.photos/seed/new/600',
      alt: 'new',
      position: n0,
    });
    expect(added.thumbnail_url).toBe(before.thumbnail_url); // appended → thumbnail unchanged

    const first = await addMedia(
      a,
      A,
      productId,
      { url: 'https://picsum.photos/seed/first/600', position: 0 },
      actor,
    );
    expect(first.media[0]).toMatchObject({
      url: 'https://picsum.photos/seed/first/600',
      position: 0,
    });
    expect(first.thumbnail_url).toBe('https://picsum.photos/seed/first/600');
    expect(first.media.map((m) => m.position)).toEqual([...Array(n0 + 2).keys()]);

    const newId = added.media.at(-1)!.id;
    const variant = before.variants[0]!;
    const moved = await updateMedia(
      a,
      A,
      productId,
      newId,
      { position: 0, alt: 'moved', variant_id: variant.id },
      actor,
    );
    expect(moved.media[0]).toMatchObject({
      id: newId,
      position: 0,
      alt: 'moved',
      variant_id: variant.id,
    });
    expect(moved.thumbnail_url).toBe('https://picsum.photos/seed/new/600');
    expect(moved.media.map((m) => m.position)).toEqual([...Array(n0 + 2).keys()]);

    const removed = await deleteMedia(a, A, productId, newId, actor);
    expect(removed.media.some((m) => m.id === newId)).toBe(false);
    expect(removed.media.map((m) => m.position)).toEqual([...Array(n0 + 1).keys()]);
    expect(removed.thumbnail_url).toBe(removed.media[0]!.url);

    const all = await events();
    expect(all.length).toBe(e0 + 4);
    for (const changed of all.slice(e0)) expect(changed).toEqual(['media']);
    await expect(deleteMedia(a, A, productId, newId, actor)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      updateMedia(
        a,
        A,
        productId,
        removed.media[0]!.id,
        { variant_id: '00000000-0000-4000-8000-00000000dead' },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    // RLS: store B cannot touch A's product media
    await expect(
      addMedia(b, A, productId, { url: 'https://x/y.jpg' }, actor),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
