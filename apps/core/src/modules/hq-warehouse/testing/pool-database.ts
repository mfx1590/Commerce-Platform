// A seeded throwaway database for the stock-pool tests. Both steps of the pool (0190, 0191) are real migrations
// in packages/db, so `createTestDatabase` runs them and the seed (which maps one shared item for brands A and B,
// `SEED_IDS.sharedStock`) runs on the pool's schema.
import { seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';

export async function createPoolDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase('hq_warehouse');
  try {
    await seed(db.owner);
  } catch (err) {
    await db.drop();
    throw err;
  }
  return db;
}
