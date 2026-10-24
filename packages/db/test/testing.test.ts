import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../src/testing.js';

describe('createTestDatabase', () => {
  it('several test databases created at the same moment all migrate (migrations are serialised by a lock on the base database)', async () => {
    const dbs = await Promise.all(
      [1, 2, 3, 4].map((n) => createTestDatabase(`platform_parallel_${n}`)),
    );
    try {
      for (const db of dbs) {
        const r = await db.owner.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_roles WHERE rolname = 'platform_app'`,
        );
        expect(r.rows[0]?.n).toBe('1');
      }
      expect(new Set(dbs.map((d) => d.name)).size).toBe(4);
    } finally {
      await Promise.all(dbs.map((d) => d.drop()));
    }
  }, 120_000);
});
