// A seeded throwaway database with the PROPOSED stock-pool migrations applied (proposed/0190 + 0191, CONTRACT
// CHANGE for #435). Test-only: the day both land in packages/db this file shrinks to createTestDatabase + seed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';

const PROPOSED = join(__dirname, '..', 'proposed');

export const POOL_MIGRATIONS = ['0190_stock_pool.sql', '0191_stock_pool_rekey.sql'] as const;

export async function applyProposed(
  db: TestDatabase,
  file: (typeof POOL_MIGRATIONS)[number],
): Promise<void> {
  await db.owner.query(readFileSync(join(PROPOSED, file), 'utf8'));
}

/** Migrated to main's head and seeded; `upTo` chooses how far the proposed migrations go (default: both). */
export async function createPoolDatabase(
  upTo: 'seeded' | '0190' | '0191' = '0191',
): Promise<TestDatabase> {
  const db = await createTestDatabase('hq_warehouse');
  try {
    await seed(db.owner);
    if (upTo !== 'seeded') await applyProposed(db, '0190_stock_pool.sql');
    if (upTo === '0191') await applyProposed(db, '0191_stock_pool_rekey.sql');
  } catch (err) {
    await db.drop();
    throw err;
  }
  return db;
}
