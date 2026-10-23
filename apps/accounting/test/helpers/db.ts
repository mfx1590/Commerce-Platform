// A seeded throwaway database for the ledger tests: packages/db's migrations (0203 landed as db 0.3.17, CONTRACT CHANGE
// #558) through @platform/db/testing, the seed, and an organization-scoped client over the app role — what the service
// runs with. Owner URL for the migrations and fixtures, platform_app (RLS) for everything the service does.
import { createOrganizationClient, seed, SEED_IDS, type ScopedClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';

export interface AccountingTestDatabase {
  db: TestDatabase;
  /** Organization-scoped client over the app role: what the service runs with. */
  hq: ScopedClient;
  drop(): Promise<void>;
}

export async function createAccountingTestDatabase(): Promise<AccountingTestDatabase> {
  const db = await createTestDatabase('accounting_test');
  try {
    await seed(db.owner, { productsPerStore: 2, log: () => {} });
    const hq = createOrganizationClient(db.app, {
      organizationId: SEED_IDS.organization,
      actorId: null,
    });
    return { db, hq, drop: () => db.drop() };
  } catch (err) {
    await db.drop();
    throw err;
  }
}
