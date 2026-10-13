// A seeded throwaway database for this module's tests. The stock pool (0190, 0191) and cycle counts (0192) are
// migrations in packages/db, so `createTestDatabase` runs them and the seed (which maps one shared item for
// brands A and B, `SEED_IDS.sharedStock`) runs on that schema.
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
