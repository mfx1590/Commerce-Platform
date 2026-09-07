import { createOrganizationClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initDb } from '../lib/db';
import { formatReport, verifyBootstrap } from './index';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('core_bootstrap');
  process.env.CORE_ORGANIZATION_ID = SEED_IDS.organization;
  process.env.MEDUSA_DB_SCHEMA = 'medusa';
  await initDb({ connectionString: db.app.options.connectionString! });
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

const byCheck = (r: Awaited<ReturnType<typeof verifyBootstrap>>) =>
  [...new Set(r.findings.map((f) => f.check))].sort();

describe('bootstrap verifier', () => {
  it('a migrated but unseeded database reports the missing organization (and nothing else)', async () => {
    const r = await verifyBootstrap();
    expect(r.ok).toBe(false);
    expect(byCheck(r)).toEqual(['organization']);
    expect(r.findings[0]!.fix).toContain('pnpm db:seed');
    expect(formatReport(r)).toMatch(/ERROR \[organization\][\s\S]*bootstrap: NOT ready/);
  });

  it('a seeded database is ready except for the Medusa schema (not migrated in this test database)', async () => {
    await seed(db.owner, { productsPerStore: 3, log: () => {} });
    const r = await verifyBootstrap();
    expect(byCheck(r)).toEqual(['medusa_schema']);
    expect(r.findings[0]!.fix).toContain('db:medusa:migrate');
    expect(r.stores.map((s) => [s.code, s.default_currency])).toEqual([
      ['brand-a', 'EUR'],
      ['brand-b', 'GBP'],
      ['brand-c', 'USD'],
    ]);
    expect(r.stores[0]!.key_prefix).toBe('pk_brand');
  });

  it('with a (fake) Medusa schema in place the database is ready; a revoked seed key breaks it', async () => {
    // Stand in for `db:medusa:migrate`: the verifier only looks for tables + synced links.
    await db.owner
      .query(`CREATE SCHEMA medusa; CREATE TABLE medusa.link_module_migrations (id serial PRIMARY KEY, table_name text);
      INSERT INTO medusa.link_module_migrations (table_name) VALUES ('order_cart'); GRANT USAGE ON SCHEMA medusa TO platform_app;
      GRANT SELECT ON ALL TABLES IN SCHEMA medusa TO platform_app`);
    const ready = await verifyBootstrap();
    expect(ready.ok).toBe(true);
    expect(ready.findings).toEqual([]);
    expect(formatReport(ready)).toMatch(/ok {4}store brand-a \(EUR\)[\s\S]*bootstrap: ready/);

    const hq = createOrganizationClient(db.owner, { organizationId: SEED_IDS.organization });
    await hq.query(`UPDATE store_api_key SET revoked_at = now() WHERE store_id = $1`, [
      SEED_IDS.stores.brandA,
    ]);
    const broken = await verifyBootstrap();
    expect(broken.ok).toBe(false);
    expect(byCheck(broken)).toEqual(['seed_keys', 'store_api_key']);
    expect(broken.stores.map((s) => s.code)).toEqual(['brand-b', 'brand-c']);
    const seedFinding = broken.findings.find((f) => f.check === 'seed_keys')!;
    expect(seedFinding.message).toMatch(/does not resolve: invalid or revoked publishable key/);
    expect(seedFinding.fix).toContain('pnpm db:seed');

    // never writes: the same call twice yields the same result
    expect(await verifyBootstrap()).toEqual(broken);
  });
});
