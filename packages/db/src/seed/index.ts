import type { Pool } from 'pg';

/**
 * Fixed ids used by `pnpm db:seed` and by every window's tests/mocks. Frozen with contracts-v0.1.
 * Filled in Phase 0 step 10 (seed data); the ids are declared here so contracts/mocks can reference them now.
 */
export const SEED_IDS = {
  organization: '00000000-0000-4000-8000-000000000001',
  legalEntities: {
    brandA: '00000000-0000-4000-8000-000000000011',
    brandB: '00000000-0000-4000-8000-000000000012',
    brandC: '00000000-0000-4000-8000-000000000013',
  },
  warehouses: {
    eu: '00000000-0000-4000-8000-000000000021',
    us: '00000000-0000-4000-8000-000000000022',
  },
  stores: {
    brandA: '00000000-0000-4000-8000-000000000031',
    brandB: '00000000-0000-4000-8000-000000000032',
    brandC: '00000000-0000-4000-8000-000000000033',
  },
  users: {
    owner: '00000000-0000-4000-8000-000000000041',
    finance: '00000000-0000-4000-8000-000000000042',
    operations: '00000000-0000-4000-8000-000000000043',
    storeAdmin: '00000000-0000-4000-8000-000000000044',
    storeStaff: '00000000-0000-4000-8000-000000000045',
    support: '00000000-0000-4000-8000-000000000046',
    analyst: '00000000-0000-4000-8000-000000000047',
  },
} as const;

export interface SeedOptions {
  productsPerStore?: number;
}

/** Placeholder until Phase 0 step 10. */
export async function seed(_pool: Pool, _opts: SeedOptions = {}): Promise<void> {
  throw new Error('seed: not implemented yet (Phase 0 step 10)');
}
