// Product feeds against a seeded throwaway database (#146): definition CRUD, the rows built from the catalogue,
// and the publish job — including the idempotency-per-content-hash rule that #146 asks for.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFeedItems,
  createFeed,
  deleteFeed,
  FilesystemFeedStorage,
  getFeed,
  listFeedItems,
  listFeeds,
  publishFeed,
  resetFeedStorage,
  setFeedStorage,
  updateFeed,
  type ProductFeedInput,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-feeds' };

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let dir: string;

const input = (over: Partial<ProductFeedInput> = {}): ProductFeedInput => ({
  name: 'Google Shopping NL',
  channel: 'google_merchant',
  locale: 'en-GB',
  currency: 'EUR',
  ...over,
});

async function outbox(aggregateId: string) {
  const res = await db.owner.query<{ topic: string; payload: Record<string, unknown> }>(
    `SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY occurred_at, id`,
    [aggregateId],
  );
  return res.rows;
}

beforeAll(async () => {
  db = await createTestDatabase('core_feeds');
  await seed(db.owner, { productsPerStore: 6, log: () => {} });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A], actorId: actor.id });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B], actorId: actor.id });
  dir = await mkdtemp(join(tmpdir(), 'feeds-'));
  setFeedStorage(new FilesystemFeedStorage({ dir, baseUrl: 'https://feeds.example/feeds' }));
}, 180_000);

afterAll(async () => {
  resetFeedStorage();
  await rm(dir, { recursive: true, force: true });
  await db?.drop();
});

beforeEach(async () => {
  await db.owner.query('DELETE FROM product_feed');
  await db.owner.query('DELETE FROM outbox');
});

describe('feed definitions', () => {
  it('creates, reads, lists, filters and updates', async () => {
    const created = await createFeed(a, A, input(), actor);
    expect(created).toMatchObject({
      store_id: A,
      channel: 'google_merchant',
      status: 'draft',
      url: null,
      item_count: 0,
      errors: [],
      last_published_at: null,
    });

    expect(await getFeed(a, A, created.id)).toEqual(created);

    await createFeed(a, A, input({ name: 'Meta NL', channel: 'meta' }), actor);
    expect((await listFeeds(a, A)).total).toBe(2);
    expect((await listFeeds(a, A, { channel: 'meta' })).items.map((f) => f.name)).toEqual([
      'Meta NL',
    ]);
    expect((await listFeeds(a, A, { status: 'active' })).total).toBe(0);

    const updated = await updateFeed(
      a,
      A,
      created.id,
      input({ name: 'Google Shopping NL v2', status: 'paused' }),
      actor,
    );
    expect(updated).toMatchObject({ name: 'Google Shopping NL v2', status: 'paused' });
  });

  it('refuses a currency the store does not sell, and `error` as an input status', async () => {
    // Brand A sells EUR; GBP belongs to brand B.
    await expect(createFeed(a, A, input({ currency: 'GBP' }), actor)).rejects.toMatchObject({
      code: 'validation_error',
      details: { currency: expect.stringContaining('not sold by this store') },
    });

    await expect(
      createFeed(a, A, input({ status: 'error' as never }), actor),
    ).rejects.toMatchObject({ code: 'validation_error', details: { status: expect.any(String) } });
  });

  it('is isolated per store', async () => {
    const mine = await createFeed(a, A, input(), actor);
    await createFeed(b, B, input({ currency: 'GBP', name: 'Google Shopping UK' }), actor);

    expect((await listFeeds(a, A)).items.map((f) => f.id)).toEqual([mine.id]);
    await expect(getFeed(b, B, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(publishFeed(b, A, mine.id, actor)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('building the rows', () => {
  it('builds one row per priced variant, with link, image, brand and availability', async () => {
    const { items, errors } = await buildFeedItems(a, A, {
      currency: 'EUR',
      filters: {},
      mapping: {},
    });
    expect(errors).toEqual([]);
    expect(items.length).toBeGreaterThan(0);

    const first = items[0]!;
    expect(first.link).toMatch(/^https:\/\/shop\.brand-a\.local\/products\/.+\?variant=/);
    expect(first.price.currency).toBe('EUR');
    expect(first.price.amount_minor).toBeGreaterThan(0);
    expect(first.brand).not.toBeNull();
    expect(['in_stock', 'out_of_stock', 'backorder', 'preorder']).toContain(first.availability);
    // The seed sets no barcode, so GTIN is genuinely absent — the advisory path, not a fabricated null.
    expect(first.gtin).toBeNull();
    expect(first.item_group_id).not.toBeNull();

    // Rows are stable between builds, which is what makes the content hash meaningful.
    const again = await buildFeedItems(a, A, { currency: 'EUR', filters: {}, mapping: {} });
    expect(again.items.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('applies mapping overrides and the in_stock_only filter', async () => {
    const overridden = await buildFeedItems(a, A, {
      currency: 'EUR',
      filters: {},
      mapping: { brand: 'Override Brand' },
    });
    expect(overridden.items.every((i) => i.brand === 'Override Brand')).toBe(true);

    const all = await buildFeedItems(a, A, { currency: 'EUR', filters: {}, mapping: {} });
    const inStock = await buildFeedItems(a, A, {
      currency: 'EUR',
      filters: { in_stock_only: true },
      mapping: {},
    });
    expect(inStock.items.every((i) => i.availability === 'in_stock')).toBe(true);
    expect(inStock.items.length).toBeLessThanOrEqual(all.items.length);
  });

  it('emits nothing for a currency the catalogue has no prices in', async () => {
    const { items } = await buildFeedItems(a, A, {
      currency: 'GBP',
      filters: {},
      mapping: {},
    });
    expect(items).toEqual([]);
  });

  it('reports the missing domain as a feed-level error rather than guessing a URL', async () => {
    await db.owner.query(`DELETE FROM store_domain WHERE store_id = $1`, [B]);
    const { items, errors } = await buildFeedItems(b, B, {
      currency: 'GBP',
      filters: {},
      mapping: {},
    });
    expect(errors).toEqual([
      {
        code: 'no_primary_domain',
        message: 'the store has no domain, so feed items cannot be linked',
        product_id: null,
      },
    ]);
    expect(items.every((i) => i.link === '')).toBe(true);
  });
});

describe('publish', () => {
  it('writes the file, counts the items, sets the url and emits feed.published', async () => {
    const feed = await createFeed(a, A, input(), actor);
    const published = await publishFeed(a, A, feed.id, actor);

    expect(published.status).toBe('active');
    expect(published.item_count).toBeGreaterThan(0);
    expect(published.last_published_at).not.toBeNull();
    expect(published.url).toBe(`https://feeds.example/feeds/brand-a/${feed.id}.xml`);

    const body = await readFile(join(dir, 'brand-a', `${feed.id}.xml`), 'utf8');
    expect(body).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect((body.match(/<item>/g) ?? []).length).toBe(published.item_count);

    const events = await outbox(feed.id);
    expect(events.map((e) => e.topic)).toEqual(['feed.published']);
    expect(events[0]!.payload).toMatchObject({
      feed_id: feed.id,
      channel: 'google_merchant',
      locale: 'en-GB',
      currency: 'EUR',
      item_count: published.item_count,
      url: published.url,
    });

    // The seed has no barcodes, so every row carries the GTIN advisory — surfaced, not swallowed.
    expect(published.errors.every((e) => e.code === 'missing_gtin')).toBe(true);
    expect(published.errors.length).toBe(published.item_count);
  });

  it('is idempotent per content hash: identical bytes write nothing and emit nothing', async () => {
    const feed = await createFeed(a, A, input(), actor);
    const first = await publishFeed(a, A, feed.id, actor);
    await db.owner.query('DELETE FROM outbox');

    const second = await publishFeed(a, A, feed.id, actor);
    expect(second.last_published_at).toBe(first.last_published_at);
    expect(second.item_count).toBe(first.item_count);
    expect(second.url).toBe(first.url);
    expect(await outbox(feed.id)).toEqual([]);

    // Change the catalogue, and the very next publish moves again.
    await db.owner.query(
      `UPDATE product SET title = title || ' (new)' WHERE store_id = $1 AND status = 'published'`,
      [A],
    );
    const third = await publishFeed(a, A, feed.id, actor);
    expect(third.last_published_at).not.toBe(first.last_published_at);
    expect((await outbox(feed.id)).map((e) => e.topic)).toEqual(['feed.published']);
  });

  it('renders Meta as CSV under the same key convention', async () => {
    const feed = await createFeed(a, A, input({ name: 'Meta NL', channel: 'meta' }), actor);
    const published = await publishFeed(a, A, feed.id, actor);
    expect(published.url.endsWith('.csv')).toBe(true);

    const body = await readFile(join(dir, 'brand-a', `${feed.id}.csv`), 'utf8');
    expect(body.split('\r\n')[0]).toContain('id,title,description,availability,condition,price');
    expect(body.trimEnd().split('\r\n')).toHaveLength(published.item_count + 1);
  });

  it('refuses a channel with no renderer yet instead of publishing an empty file', async () => {
    const feed = await createFeed(a, A, input({ name: 'TikTok', channel: 'tiktok' }), actor);
    await expect(publishFeed(a, A, feed.id, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { channel: 'tiktok' },
    });
  });

  it('lands in status error when the store has no domain to link to', async () => {
    await db.owner.query(`DELETE FROM store_domain WHERE store_id = $1`, [A]);
    const feed = await createFeed(a, A, input(), actor);
    const published = await publishFeed(a, A, feed.id, actor);

    expect(published.status).toBe('error');
    expect(published.item_count).toBe(0);
    expect(published.errors.some((e) => e.code === 'no_primary_domain')).toBe(true);
    // Every row also failed its link requirement, and each is named with its product.
    expect(published.errors.some((e) => e.code === 'missing_link' && e.product_id !== null)).toBe(
      true,
    );

    await db.owner.query(
      `INSERT INTO store_domain (organization_id, store_id, hostname, is_primary)
       VALUES ($1, $2, 'shop.brand-a.local', true)`,
      [ORG, A],
    );
  });

  it('deleting a feed removes the artifact it was serving', async () => {
    const feed = await createFeed(a, A, input(), actor);
    await publishFeed(a, A, feed.id, actor);
    await expect(readFile(join(dir, 'brand-a', `${feed.id}.xml`), 'utf8')).resolves.toContain(
      '<rss',
    );

    await deleteFeed(a, A, feed.id, actor);
    await expect(readFile(join(dir, 'brand-a', `${feed.id}.xml`), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('feed items endpoint', () => {
  it('returns the computed rows with their errors, paged', async () => {
    const feed = await createFeed(a, A, input(), actor);
    const page1 = await listFeedItems(a, A, feed.id, { page: 1, limit: 2 });
    expect(page1).toMatchObject({ page: 1, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBeGreaterThan(2);
    // The GTIN advisory rides on the item, so the admin screen can show it per row.
    expect(page1.items[0]!.errors).toEqual(['missing_gtin']);
  });
});
