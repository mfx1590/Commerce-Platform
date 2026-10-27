import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganizationClient, createTenantClient } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

// 0204 product_recommendation (CONTRACT CHANGE #607): the guarantees the migration itself makes, before any job uses it.
const ORG = '40000000-0000-4000-8000-000000000101';
const LE = '40000000-0000-4000-8000-000000000111';
const STORE_A = '40000000-0000-4000-8000-000000000131';
const STORE_B = '40000000-0000-4000-8000-000000000132';
const A1 = '40000000-0000-4000-8000-000000000141';
const A2 = '40000000-0000-4000-8000-000000000142';
const B1 = '40000000-0000-4000-8000-000000000151';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('platform_recommendation_test');
  const hq = createOrganizationClient(db.owner, { organizationId: ORG });
  await hq.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq-rec', 'HQ')`, [ORG]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le', 'LE', 'NL', 'EUR')`,
      [LE, ORG],
    );
    for (const [id, code] of [
      [STORE_A, 'brand-a'],
      [STORE_B, 'brand-b'],
    ] as const) {
      await tx.query(
        `INSERT INTO store (id, organization_id, legal_entity_id, code, name, default_currency, default_locale, default_country)
         VALUES ($1, $2, $3, $4, $4, 'EUR', 'en-GB', 'NL')`,
        [id, ORG, LE, code],
      );
    }
    for (const [id, store, handle] of [
      [A1, STORE_A, 'a-one'],
      [A2, STORE_A, 'a-two'],
      [B1, STORE_B, 'b-one'],
    ] as const) {
      await tx.query(
        `INSERT INTO product (id, organization_id, store_id, handle, title, status) VALUES ($1, $2, $3, $4, $4, 'published')`,
        [id, ORG, store, handle],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const insert = `INSERT INTO product_recommendation
  (organization_id, store_id, product_id, related_product_id, kind, window_days, score, computed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, now())`;

async function asOwner(sql: string, params: unknown[]) {
  return createOrganizationClient(db.owner, { organizationId: ORG }).transaction((tx) =>
    tx.query(sql, params),
  );
}

describe('product_recommendation (0204, #607)', () => {
  it('accepts a same-store pair and a store-wide popular row', async () => {
    await asOwner(insert, [ORG, STORE_A, A1, A2, 'bought_together', 0, 1.8]);
    await asOwner(insert, [ORG, STORE_A, null, A1, 'popular', 7, 12]);
  });

  it('refuses a recommendation that points at another store’s product (composite keys)', async () => {
    await expect(asOwner(insert, [ORG, STORE_A, A1, B1, 'bought_together', 0, 2])).rejects.toThrow(
      /foreign key/i,
    );
    await expect(asOwner(insert, [ORG, STORE_A, B1, A1, 'bought_together', 0, 2])).rejects.toThrow(
      /foreign key/i,
    );
  });

  it('refuses a second identical store-wide popular row (UNIQUE NULLS NOT DISTINCT)', async () => {
    await expect(asOwner(insert, [ORG, STORE_A, null, A1, 'popular', 7, 13])).rejects.toThrow(
      /duplicate key|unique/i,
    );
    // The other window is a different list.
    await asOwner(insert, [ORG, STORE_A, null, A1, 'popular', 30, 40]);
  });

  it('keeps kind, anchor and window consistent, and never recommends the product itself', async () => {
    for (const row of [
      [ORG, STORE_A, null, A2, 'bought_together', 0, 1], // pair without an anchor
      [ORG, STORE_A, A1, A2, 'popular', 7, 1], // popular with an anchor
      [ORG, STORE_A, A2, A1, 'bought_together', 7, 1], // pair with a window
      [ORG, STORE_A, A1, A1, 'bought_together', 0, 1], // itself
      [ORG, STORE_A, A2, A1, 'bought_together', 0, 0], // score must be > 0
    ]) {
      await expect(asOwner(insert, row)).rejects.toThrow(/check constraint/i);
    }
  });

  it('the app role sees only its store and may not UPDATE (rows are rewritten, never updated)', async () => {
    const storeB = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
    const seen = await storeB.transaction((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM product_recommendation`),
    );
    expect(seen.rows[0].n).toBe(0);

    const storeA = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const mine = await storeA.transaction((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM product_recommendation`),
    );
    expect(mine.rows[0].n).toBe(3);
    await expect(
      storeA.transaction((tx) => tx.query(`UPDATE product_recommendation SET score = 9`)),
    ).rejects.toThrow(/permission denied/i);
  });
});
