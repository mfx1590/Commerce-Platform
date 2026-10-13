// A seeded throwaway database for the stock-pool tests. Both steps of the pool (0190, 0191) are real migrations
// in packages/db, so `createTestDatabase` runs them and the seed (which maps one shared item for brands A and B,
// `SEED_IDS.sharedStock`) runs on the pool's schema. Cycle counts (#436) are still a PROPOSED migration
// (proposed/0192, CONTRACT CHANGE #458): `'0192'` applies it on top; that option goes when 0192 lands.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';

const PROPOSED = join(__dirname, '..', 'proposed');

export const POOL_MIGRATIONS = ['0192_cycle_count.sql'] as const;

export async function applyProposed(
  db: TestDatabase,
  file: (typeof POOL_MIGRATIONS)[number],
): Promise<void> {
  await db.owner.query(readFileSync(join(PROPOSED, file), 'utf8'));
}

export async function createPoolDatabase(upTo: 'main' | '0192' = 'main'): Promise<TestDatabase> {
  const db = await createTestDatabase('hq_warehouse');
  try {
    await seed(db.owner);
    if (upTo === '0192') await applyProposed(db, '0192_cycle_count.sql');
  } catch (err) {
    await db.drop();
    throw err;
  }
  return db;
}
