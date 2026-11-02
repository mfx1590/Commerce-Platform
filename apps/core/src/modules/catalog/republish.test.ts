// The catalogue re-publish (#634) on a seeded throwaway database: the seed inserts the catalogue directly, so no
// seeded product ever went through the bus — exactly the dev stack's state.
import { createValidator } from '@platform/events';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProduct, publishProduct, republishCatalogue } from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;

let db: TestDatabase;
let hq: ReturnType<typeof createOrganizationClient>;
let owner: ReturnType<typeof createOrganizationClient>;

const publishedEvents = async (storeId?: string) =>
  (
    await owner.query<{
      aggregate_id: string;
      store_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT aggregate_id::text AS aggregate_id, store_id::text AS store_id, payload FROM outbox
       WHERE topic = 'product.published' AND ($1::uuid IS NULL OR store_id = $1::uuid)`,
      [storeId ?? null],
    )
  ).rows;
const publishedCount = async (storeId: string) =>
  Number(
    (
      await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM product WHERE store_id = $1 AND status = 'published'`,
        [storeId],
      )
    ).rows[0]!.n,
  );

beforeAll(async () => {
  db = await createTestDatabase('core_catalog_republish');
  await seed(db.owner, { productsPerStore: 6, log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

describe('republishCatalogue (#634)', () => {
  it('a dry run counts and writes nothing; a store-scoped client is refused', async () => {
    expect(await publishedEvents()).toHaveLength(0); // the seed never went through the bus
    const dry = await republishCatalogue(hq, { dryRun: true });
    expect(dry.dry_run).toBe(true);
    const a = dry.stores.find((s) => s.store_id === A)!;
    expect(a).toEqual({ store_id: A, published: await publishedCount(A), skipped: 0 });
    expect(await publishedEvents()).toHaveLength(0);
    const store = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
    await expect(republishCatalogue(store)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('one store first: one valid product.published per published product, current state, the store’s envelope', async () => {
    const res = await republishCatalogue(hq, { storeIds: [A], batch: 2 }); // small batches: several transactions
    const expected = await publishedCount(A);
    expect(res.stores).toEqual([{ store_id: A, published: expected, skipped: 0 }]);
    const events = await publishedEvents();
    expect(events).toHaveLength(expected);
    expect(events.every((e) => e.store_id === A)).toBe(true); // brand B untouched
    const validator = createValidator();
    for (const e of events) {
      expect(validator.validatePayload('product.published', 1, e.payload).ok).toBe(true);
      expect(e.payload.product_id).toBe(e.aggregate_id);
      // the payload is the product's current state: its variants as they are in the database
      const variants = await owner.query<{ id: string }>(
        `SELECT id FROM product_variant WHERE product_id = $1 ORDER BY id`,
        [e.aggregate_id],
      );
      expect(
        (e.payload.variants as { variant_id: string }[]).map((v) => v.variant_id).sort(),
      ).toEqual(variants.rows.map((v) => v.id));
    }
  });

  it('the rest, then a second run writes nothing; draft products never; a product published since is skipped', async () => {
    const before = (await publishedEvents()).length;
    const res = await republishCatalogue(hq);
    const b = res.stores.find((s) => s.store_id === B)!;
    expect(b).toEqual({ store_id: B, published: await publishedCount(B), skipped: 0 });
    expect(res.stores.find((s) => s.store_id === A)).toEqual({
      store_id: A,
      published: 0,
      skipped: await publishedCount(A),
    });
    const after = (await publishedEvents()).length;
    expect(after - before).toBe(res.stores.reduce((n, s) => n + s.published, 0));

    // a draft product is never announced; once published through publishProduct it has its own event
    const store = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
    const draft = await createProduct(store, A, { handle: 'republish-draft', title: 'Draft only' });
    let again = await republishCatalogue(hq);
    expect(again.stores.every((s) => s.published === 0)).toBe(true);
    await publishProduct(store, A, draft.id);
    const own = (await publishedEvents(A)).filter((e) => e.aggregate_id === draft.id);
    expect(own).toHaveLength(1);
    again = await republishCatalogue(hq);
    expect(again.stores.every((s) => s.published === 0)).toBe(true); // idempotent: nothing twice
    expect((await publishedEvents(A)).filter((e) => e.aggregate_id === draft.id)).toHaveLength(1);
  });

  it('force re-announces every published product of the stores in scope', async () => {
    const before = (await publishedEvents(B)).length;
    const res = await republishCatalogue(hq, { storeIds: [B], force: true });
    expect(res.stores).toEqual([{ store_id: B, published: await publishedCount(B), skipped: 0 }]);
    expect((await publishedEvents(B)).length - before).toBe(await publishedCount(B));
  });
});
