// A seeded throwaway database with the PROPOSED migrations applied (proposed/0191, CONTRACT CHANGE #453, and
// proposed/0192, cycle counts, #436). Step 1 of
// the stock pool (0190) is on main since db 0.3.4, so `createTestDatabase` already runs it. Test-only: the day
// 0191 lands in packages/db this file shrinks to createTestDatabase + seed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';

const PROPOSED = join(__dirname, '..', 'proposed');

export const POOL_MIGRATIONS = ['0191_stock_pool_rekey.sql', '0192_cycle_count.sql'] as const;

export async function applyProposed(
  db: TestDatabase,
  file: (typeof POOL_MIGRATIONS)[number],
): Promise<void> {
  await db.owner.query(readFileSync(join(PROPOSED, file), 'utf8'));
}

/**
 * Migrated to main's head (0190 included) and seeded. The seed runs AFTER 0190, so with `'seeded'` no variant has
 * a stock item yet; `'0191'` (default) applies the proposed rekey, whose first statement is the backfill;
 * `'0192'` adds the proposed cycle counts (#436) on top.
 */
export async function createPoolDatabase(
  upTo: 'seeded' | '0191' | '0192' = '0191',
): Promise<TestDatabase> {
  const db = await createTestDatabase('hq_warehouse');
  try {
    await seed(db.owner);
    if (upTo !== 'seeded') await applyProposed(db, '0191_stock_pool_rekey.sql');
    if (upTo === '0192') await applyProposed(db, '0192_cycle_count.sql');
  } catch (err) {
    await db.drop();
    throw err;
  }
  return db;
}
