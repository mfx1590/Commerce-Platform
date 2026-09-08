// Sync logic against a seeded throwaway database and the in-memory index client (issue #134): full reindex,
// idempotent upserts, delete on archive, store isolation through the tenant client, cursor semantics.
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveProduct,
  createProduct,
  createVariant,
  publishProduct,
  updateProduct,
} from '../catalog';
import {
  buildRecord,
  DESCRIPTION_MAX_CHARS,
  FakeIndexClient,
  fullReindex,
  indexNameFor,
  readCursor,
  replicaNameFor,
  syncFromOutbox,
  syncUntilCaughtUp,
  type StoreIndexTarget,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-search' };

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let org: ReturnType<typeof createOrganizationClient>;
let storeA: StoreIndexTarget;
let storeB: StoreIndexTarget;

async function storeTarget(id: string): Promise<StoreIndexTarget> {
  const r = await org.query<StoreIndexTarget>(
    'SELECT id, code, default_currency, search_index FROM store WHERE id = $1',
    [id],
  );
  return r.rows[0]!;
}

beforeAll(async () => {
  db = await createTestDatabase('core_search');
  await seed(db.owner, { log: () => {} });
  org = createOrganizationClient(db.app, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A], actorId: actor.id });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B], actorId: actor.id });
  storeA = await storeTarget(A);
  storeB = await storeTarget(B);
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

describe('full reindex (seeded brand-a)', () => {
  it('indexes every published, sellable product with prices per currency, settings and replicas', async () => {
    const index = new FakeIndexClient();
    const r = await fullReindex(a, storeA, index, { batchSize: 64 });
    const name = indexNameFor(storeA);
    expect(r.indexName).toBe(name);
    expect(r.indexed).toBe(200);
    expect(r.removed).toBe(0);
    expect(r.cursor).toBeGreaterThanOrEqual(0);

    const records = index.records(name);
    expect(records).toHaveLength(200);
    for (const rec of records) {
      expect(rec.store_id).toBe(A);
      expect(rec.currencies).toContain(storeA.default_currency.trim());
      expect(rec.price_minor[storeA.default_currency.trim()]).toBeGreaterThan(0);
      expect(rec.price_max_minor[storeA.default_currency.trim()]).toBeGreaterThanOrEqual(
        rec.price_minor[storeA.default_currency.trim()]!,
      );
      expect(rec.category_path.length).toBeGreaterThan(0);
      expect(rec.category_handle).toBe(rec.category_path[rec.category_path.length - 1]);
      expect(rec.variants.length).toBeGreaterThan(0);
      expect(rec.published_at_ts).toBeGreaterThan(0);
      expect(typeof rec.in_stock).toBe('boolean');
    }
    // batches of 64 → 4 save calls (64+64+64+8)
    expect(index.calls.filter((c) => c.op === 'saveObjects' && c.indexName === name)).toHaveLength(
      4,
    );

    const settings = index.settings(name);
    expect(settings.replicas).toEqual([
      replicaNameFor(name, 'price_asc'),
      replicaNameFor(name, 'price_desc'),
      replicaNameFor(name, 'newest'),
    ]);
    expect(settings.searchableAttributes?.[0]).toBe('title');
    expect(settings.unretrievableAttributes).toContain('store_id');
    const cur = storeA.default_currency.trim().toUpperCase();
    expect(index.settings(replicaNameFor(name, 'price_asc')).ranking?.[0]).toBe(
      `asc(price_minor.${cur})`,
    );
    expect(index.settings(replicaNameFor(name, 'price_desc')).ranking?.[0]).toBe(
      `desc(price_minor.${cur})`,
    );
    expect(index.settings(replicaNameFor(name, 'newest')).ranking?.[0]).toBe(
      'desc(published_at_ts)',
    );
    expect(await readCursor(index, name)).toBe(r.cursor);
  });

  it('is idempotent: a second full reindex upserts the same 200 records and removes nothing', async () => {
    const index = new FakeIndexClient();
    await fullReindex(a, storeA, index);
    const before = index
      .records(indexNameFor(storeA))
      .map((x) => x.objectID)
      .sort();
    const again = await fullReindex(a, storeA, index);
    expect(again.indexed).toBe(200);
    expect(again.removed).toBe(0);
    expect(
      index
        .records(indexNameFor(storeA))
        .map((x) => x.objectID)
        .sort(),
    ).toEqual(before);
  });

  it('removes records that are no longer published (stale objects from an older build)', async () => {
    const index = new FakeIndexClient();
    await fullReindex(a, storeA, index);
    const name = indexNameFor(storeA);
    const victim = index.records(name)[0]!;
    await archiveProduct(a, A, victim.objectID, actor);
    const r = await fullReindex(a, storeA, index);
    expect(r.indexed).toBe(199);
    expect(r.removed).toBe(1);
    expect(index.record(name, victim.objectID)).toBeUndefined();
  });
});

describe('store isolation', () => {
  it('a store-scoped client cannot index another store; an index never holds foreign products', async () => {
    const index = new FakeIndexClient();
    await expect(fullReindex(a, storeB, index)).rejects.toMatchObject({ code: 'forbidden' });
    expect(index.indexNames()).toEqual([]);

    await fullReindex(a, storeA, index);
    await fullReindex(b, storeB, index);
    const idsA = new Set(index.records(indexNameFor(storeA)).map((r) => r.objectID));
    const idsB = new Set(index.records(indexNameFor(storeB)).map((r) => r.objectID));
    expect(indexNameFor(storeA)).not.toBe(indexNameFor(storeB));
    expect(idsB.size).toBe(200);
    for (const id of idsA) expect(idsB.has(id)).toBe(false);
    for (const rec of index.records(indexNameFor(storeB))) expect(rec.store_id).toBe(B);

    // the organization client may index any store, and still only that store's rows land in its index
    const viaOrg = new FakeIndexClient();
    await fullReindex(org, storeB, viaOrg);
    const orgIds = new Set(viaOrg.records(indexNameFor(storeB)).map((r) => r.objectID));
    expect(orgIds).toEqual(idsB);
  });

  it('incremental sync of store A ignores store B events (tenant client sees only its outbox rows)', async () => {
    const index = new FakeIndexClient();
    await fullReindex(a, storeA, index);
    await fullReindex(b, storeB, index);
    const victimB = index.records(indexNameFor(storeB))[0]!;
    await archiveProduct(b, B, victimB.objectID, actor);
    const rA = await syncFromOutbox(a, storeA, index);
    expect(rA.processed).toBe(0);
    expect(index.record(indexNameFor(storeB), victimB.objectID)).toBeDefined();
    const rB = await syncFromOutbox(b, storeB, index);
    expect(rB.processed).toBe(1);
    expect(rB.deleted).toBe(1);
    expect(index.record(indexNameFor(storeB), victimB.objectID)).toBeUndefined();
  });
});

describe('incremental sync from the outbox', () => {
  it('refuses to sync an index that was never fully reindexed', async () => {
    const index = new FakeIndexClient();
    await expect(syncFromOutbox(a, storeA, index)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('archive → delete, update → upsert, publish → insert, re-run → no-op, cursor advances', async () => {
    const index = new FakeIndexClient();
    const name = indexNameFor(storeA);
    const start = await fullReindex(a, storeA, index);
    expect((await syncFromOutbox(a, storeA, index)).processed).toBe(0);

    const initial = index.records(name);
    const victim = initial[0]!;
    const renamed = initial[1]!;
    await archiveProduct(a, A, victim.objectID, actor);
    await updateProduct(a, A, renamed.objectID, { title: 'Renamed for search' }, actor);

    const draft = await createProduct(
      a,
      A,
      { handle: 'search-sync-new', title: 'Brand new for search', tags: ['sync'] },
      actor,
    );
    await createVariant(
      a,
      A,
      draft.id,
      {
        sku: 'SEARCH-SYNC-1',
        title: 'One size',
        options: {},
        manage_inventory: false,
        prices: [{ currency: storeA.default_currency.trim(), amount_minor: 1999 }],
      },
      actor,
    );
    const unsellable = await createProduct(
      a,
      A,
      { handle: 'search-sync-unsellable', title: 'No price, never indexed' },
      actor,
    );
    await publishProduct(a, A, draft.id, actor);
    await publishProduct(a, A, unsellable.id, actor);

    const r = await syncUntilCaughtUp(a, storeA, index, { batchSize: 2 });
    expect(r.processed).toBeGreaterThanOrEqual(4);
    expect(r.cursor).toBeGreaterThan(start.cursor);
    expect(index.record(name, victim.objectID)).toBeUndefined();
    expect(index.record(name, renamed.objectID)?.title).toBe('Renamed for search');
    const fresh = index.record(name, draft.id);
    expect(fresh?.handle).toBe('search-sync-new');
    expect(fresh?.price_minor[storeA.default_currency.trim().toUpperCase()]).toBe(1999);
    expect(fresh?.tags).toEqual(['sync']);
    expect(fresh?.in_stock).toBe(true);
    expect(index.record(name, unsellable.id)).toBeUndefined();
    expect(index.records(name)).toHaveLength(start.indexed); // - 1 archived + 1 new

    const again = await syncFromOutbox(a, storeA, index);
    expect(again).toEqual({ processed: 0, upserted: 0, deleted: 0, cursor: r.cursor });
    expect(await readCursor(index, name)).toBe(r.cursor);

    // replaying the same events (cursor rewound) yields the same index: upserts are idempotent
    await index.setSettings(name, { userData: { outbox_cursor: start.cursor } });
    const replay = await syncUntilCaughtUp(a, storeA, index);
    expect(replay.cursor).toBe(r.cursor);
    expect(index.records(name)).toHaveLength(start.indexed);
    expect(index.record(name, victim.objectID)).toBeUndefined();
  });
});

describe('buildRecord (pure)', () => {
  const product = {
    id: 'p1',
    store_id: A,
    handle: 'h',
    title: 'T',
    subtitle: null,
    description: 'x'.repeat(DESCRIPTION_MAX_CHARS + 50),
    category_id: 'c2',
    brand_name: null,
    tags: null,
    attributes: null,
    thumbnail_url: null,
    published_at: new Date('2026-01-02T00:00:00Z'),
    updated_at: new Date('2026-01-03T00:00:00Z'),
  };
  const categories = new Map([
    ['c1', { id: 'c1', handle: 'root', name: 'Root', parent_id: null }],
    ['c2', { id: 'c2', handle: 'leaf', name: 'Leaf', parent_id: 'c1' }],
  ]);
  const variants = [
    {
      id: 'v1',
      product_id: 'p1',
      sku: 'S1',
      title: 'A',
      options: null,
      manage_inventory: true,
      allow_backorder: false,
    },
    {
      id: 'v2',
      product_id: 'p1',
      sku: 'S2',
      title: 'B',
      options: { Size: 'M' },
      manage_inventory: true,
      allow_backorder: true,
    },
  ];

  it('returns null without a price in an enabled currency', () => {
    expect(buildRecord(product, variants, [], [], categories, ['EUR'])).toBeNull();
    expect(
      buildRecord(
        product,
        variants,
        [{ variant_id: 'v1', currency: 'USD', amount_minor: '100', compare_at_minor: null }],
        [],
        categories,
        ['EUR'],
      ),
    ).toBeNull();
  });

  it('aggregates prices per currency, availability, category path and truncates the description', () => {
    const rec = buildRecord(
      product,
      variants,
      [
        { variant_id: 'v1', currency: 'EUR', amount_minor: '500', compare_at_minor: '700' },
        { variant_id: 'v2', currency: 'EUR', amount_minor: '300', compare_at_minor: null },
        { variant_id: 'v2', currency: 'USD', amount_minor: '350', compare_at_minor: '400' },
      ],
      [
        { variant_id: 'v1', available: 0 },
        { variant_id: 'v2', available: -2 },
      ],
      categories,
      ['EUR', 'USD'],
    )!;
    expect(rec.price_minor).toEqual({ EUR: 300, USD: 350 });
    expect(rec.price_max_minor).toEqual({ EUR: 500, USD: 350 });
    expect(rec.compare_at_minor).toEqual({ USD: 400 }); // cheapest EUR variant has no compare-at
    expect(rec.currencies).toEqual(['EUR', 'USD']);
    expect(rec.category_path).toEqual(['root', 'leaf']);
    expect(rec.category_name).toBe('Leaf');
    expect(rec.description).toHaveLength(DESCRIPTION_MAX_CHARS);
    expect(rec.variants.map((v) => v.in_stock)).toEqual([false, true]); // v2 allows backorder
    expect(rec.in_stock).toBe(true);
    expect(rec.available_quantity).toBe(0);
    expect(rec.published_at_ts).toBe(Math.floor(Date.UTC(2026, 0, 2) / 1000));
    expect(rec.tags).toEqual([]);
  });
});
