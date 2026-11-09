// Issue #497: the data backfills in migrations must work when the migration role is what a managed Postgres (RDS,
// Neon) gives you — the owner of every schema object, but neither superuser nor BYPASSRLS. Under FORCE ROW LEVEL
// SECURITY such an owner is subject to the tenant policies like everyone else, and a migration sets no tenant
// context, so a backfill that simply reads and writes the tables sees zero rows. Locally and in CI the migration
// role is the docker superuser, which bypasses RLS, so every other suite passes either way.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/index.js';

const ORG_1 = '49700000-0000-4000-8000-000000000001';
const ORG_2 = '49700000-0000-4000-8000-000000000002';

/** Stores seeded before 0190: two in ORG_1 sharing a sku (the backfill's store-code rule), one in ORG_2. */
const STORES = [
  { org: ORG_1, n: 1, code: 'brand-a', sku: 'TEE-1' },
  { org: ORG_1, n: 2, code: 'brand-b', sku: 'TEE-1' },
  { org: ORG_2, n: 3, code: 'brand-c', sku: 'MUG-1' },
] as const;

const uid = (kind: number, n: number) =>
  `49700000-0000-4000-8000-${String(kind).padStart(4, '0')}${String(n).padStart(8, '0')}`;

function withDatabase(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

const suffix = Math.random().toString(36).slice(2, 10);
/** Test-only role: its password is its own name (a throwaway database on the local server). */
const MIGRATOR = `platform_migrator_${suffix}`;
const DB = `platform_test_managed_${suffix}`;

let admin: pg.Client; // the local superuser, on the base database: creates and drops the role and the database
let superDb: pg.Pool; // the local superuser, on the test database: seeds fixtures and inspects (bypasses RLS)
let migrator: pg.Pool; // the managed-Postgres-shaped migration role, on the test database

beforeAll(async () => {
  const base = process.env.DATABASE_URL!;
  admin = new pg.Client({ connectionString: base });
  await admin.connect();
  // What RDS / Neon give the master user: LOGIN, CREATEDB, CREATEROLE — never SUPERUSER, never BYPASSRLS.
  await admin.query(
    `CREATE ROLE ${MIGRATOR} LOGIN PASSWORD '${MIGRATOR}' NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE`,
  );
  // It owns the database, hence (Postgres 15+) the public schema, and so every object its migrations create.
  await admin.query(`CREATE DATABASE ${DB} OWNER ${MIGRATOR}`);
  superDb = new pg.Pool({ connectionString: withDatabase(base, DB), max: 2 });
  migrator = new pg.Pool({
    connectionString: withDatabase(base, DB, MIGRATOR, MIGRATOR),
    max: 2,
  });
  superDb.on('error', () => {});
  migrator.on('error', () => {});
  // 0001 creates the cluster-wide roles check-then-create; serialise with the other suites (see testing.ts).
  await admin.query(`SELECT pg_advisory_lock(hashtext('platform-test-database-migrate'))`);
}, 60_000);

afterAll(async () => {
  await admin?.query(`SELECT pg_advisory_unlock(hashtext('platform-test-database-migrate'))`);
  await migrator?.end();
  await superDb?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRATOR}`);
  await admin?.end();
});

/** Fixtures as of just before 0190: per store a product + variant, a level, a movement, a reservation, customers. */
async function seedBefore0190() {
  const q = (sql: string, params: unknown[]) => superDb.query(sql, params);
  for (const org of [ORG_1, ORG_2]) {
    await q(`INSERT INTO organization (id, slug, name) VALUES ($1, $2, $2)`, [
      org,
      `org-${org.slice(-1)}`,
    ]);
    await q(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le', 'LE', 'NL', 'EUR')`,
      [uid(11, Number(org.slice(-1))), org],
    );
    await q(
      `INSERT INTO warehouse (id, organization_id, code, name, country) VALUES ($1, $2, 'wh', 'WH', 'NL')`,
      [uid(21, Number(org.slice(-1))), org],
    );
  }
  for (const s of STORES) {
    const le = uid(11, Number(s.org.slice(-1)));
    const wh = uid(21, Number(s.org.slice(-1)));
    const store = uid(31, s.n);
    await q(
      `INSERT INTO store (id, organization_id, legal_entity_id, code, name, default_currency, default_locale, default_country)
       VALUES ($1, $2, $3, $4, $4, 'EUR', 'en-GB', 'NL')`,
      [store, s.org, le, s.code],
    );
    await q(
      `INSERT INTO product (id, organization_id, store_id, handle, title) VALUES ($1, $2, $3, 'p', $4)`,
      [uid(41, s.n), s.org, store, `Product ${s.code}`],
    );
    await q(
      `INSERT INTO product_variant (id, organization_id, store_id, product_id, sku, title) VALUES ($1, $2, $3, $4, $5, 'Default')`,
      [uid(42, s.n), s.org, store, uid(41, s.n), s.sku],
    );
    await q(
      `INSERT INTO inventory_level (organization_id, store_id, variant_id, warehouse_id, on_hand, reserved) VALUES ($1, $2, $3, $4, 10, 1)`,
      [s.org, store, uid(42, s.n), wh],
    );
    await q(
      `INSERT INTO stock_movement (organization_id, store_id, variant_id, warehouse_id, delta, reason) VALUES ($1, $2, $3, $4, 10, 'receipt')`,
      [s.org, store, uid(42, s.n), wh],
    );
    await q(
      `INSERT INTO sales_channel (id, organization_id, store_id, code, name, type) VALUES ($1, $2, $3, 'web', 'Web', 'web')`,
      [uid(51, s.n), s.org, store],
    );
    await q(
      `INSERT INTO cart (id, organization_id, store_id, sales_channel_id, currency, locale, country) VALUES ($1, $2, $3, $4, 'EUR', 'en-GB', 'NL')`,
      [uid(52, s.n), s.org, store, uid(51, s.n)],
    );
    await q(
      `INSERT INTO reservation (organization_id, store_id, variant_id, warehouse_id, cart_id, quantity) VALUES ($1, $2, $3, $4, $5, 1)`,
      [s.org, store, uid(42, s.n), wh, uid(52, s.n)],
    );
    // one customer with a consent projection (backfilled by 0194), one never asked (not backfilled)
    await q(
      `INSERT INTO customer (organization_id, store_id, email, status, consent) VALUES ($1, $2, $3, 'registered', $4::jsonb)`,
      [
        s.org,
        store,
        `asked@${s.code}.example.test`,
        JSON.stringify({
          marketing_email: { granted: true, at: '2026-09-01T08:00:00Z', source: 'storefront' },
        }),
      ],
    );
    await q(
      `INSERT INTO customer (organization_id, store_id, email, status) VALUES ($1, $2, $3, 'registered')`,
      [s.org, store, `never@${s.code}.example.test`],
    );
  }
}

const count = async (sql: string) => Number((await superDb.query<{ n: string }>(sql)).rows[0]!.n);

describe('migrations on managed Postgres: the migration role owns the schema but is neither superuser nor BYPASSRLS (#497)', () => {
  it('the migration role is what a managed Postgres gives: not superuser, no BYPASSRLS, owner of the database', async () => {
    const r = await migrator.query<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>(
      `SELECT rolsuper, rolbypassrls,
              (SELECT datdba = r.oid FROM pg_database WHERE datname = current_database()) AS owns
         FROM pg_roles r WHERE rolname = current_user`,
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owns: true });
  });

  it('migrates up to 0190 and takes fixtures in three stores of two organizations', async () => {
    await migrate(migrator, undefined, { before: '0190' });
    await seedBefore0190();
    expect(await count('SELECT count(*) AS n FROM product_variant')).toBe(3);
  });

  it('0190 maps every existing variant 1:1 onto a stock item, in every store', async () => {
    const r = await migrate(migrator, undefined, { before: '0191' });
    expect(r.applied).toEqual(['0190_stock_pool.sql']);
    expect(
      await count('SELECT count(*) AS n FROM product_variant WHERE stock_item_id IS NULL'),
    ).toBe(0);
    const items = await superDb.query<{ store: string; sku: string; org: string }>(
      `SELECT s.code AS store, si.sku, si.organization_id AS org
         FROM product_variant v JOIN store s ON s.id = v.store_id JOIN stock_item si ON si.id = v.stock_item_id
        ORDER BY s.code`,
    );
    expect(items.rows).toEqual([
      { store: 'brand-a', sku: 'brand-a:TEE-1', org: ORG_1 },
      { store: 'brand-b', sku: 'brand-b:TEE-1', org: ORG_1 },
      { store: 'brand-c', sku: 'MUG-1', org: ORG_2 },
    ]);
  });

  it('0191 rekeys inventory_level, reservation and stock_movement onto the stock item, in every store', async () => {
    const r = await migrate(migrator, undefined, { before: '0192' });
    expect(r.applied).toEqual(['0191_stock_pool_rekey.sql']);
    for (const t of ['inventory_level', 'reservation', 'stock_movement']) {
      expect(await count(`SELECT count(*) AS n FROM ${t}`)).toBe(3);
    }
    // every row points at the item of the variant it was keyed by before 0191
    expect(
      await count(`SELECT count(*) AS n FROM reservation r JOIN product_variant v ON v.id = r.variant_id
                    WHERE r.stock_item_id = v.stock_item_id`),
    ).toBe(3);
    expect(
      await count(`SELECT count(*) AS n FROM stock_movement m JOIN product_variant v ON v.id = m.variant_id
                    WHERE m.stock_item_id = v.stock_item_id`),
    ).toBe(3);
    expect(
      await count(`SELECT count(DISTINCT il.stock_item_id) AS n FROM inventory_level il
                     JOIN product_variant v ON v.stock_item_id = il.stock_item_id`),
    ).toBe(3);
  });

  it('0194 writes one pre-ledger consent row per projection, in every store; the rest migrates', async () => {
    await migrate(migrator);
    const rows = await superDb.query<{ store: string; granted: boolean; policy_version: string }>(
      `SELECT s.code AS store, cc.granted, cc.policy_version
         FROM customer_consent cc JOIN store s ON s.id = cc.store_id ORDER BY s.code`,
    );
    expect(rows.rows).toEqual(
      STORES.map((s) => ({ store: s.code, granted: true, policy_version: 'pre-ledger' })),
    );
    expect(
      await count(`SELECT count(*) AS n FROM schema_migrations WHERE name LIKE '0206_%'`),
    ).toBe(1);
  });

  it('FORCE ROW LEVEL SECURITY is on again on every table that has row-level security', async () => {
    const r = await superDb.query<{ relname: string; force: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS force FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
        ORDER BY c.relname`,
    );
    const tables = r.rows.map((x) => x.relname);
    for (const t of [
      'store',
      'product',
      'product_variant',
      'stock_item',
      'inventory_level',
      'reservation',
      'stock_movement',
      'customer',
      'customer_consent',
    ]) {
      expect(tables).toContain(t);
    }
    expect(r.rows.filter((x) => !x.force)).toEqual([]);
    // and the migrator, an owner without BYPASSRLS, is back under the policies: no context, no rows
    expect((await migrator.query('SELECT 1 FROM product_variant')).rowCount).toBe(0);
  });

  it('the runner refuses to commit a migration that leaves row-level security enabled but not forced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'db-497-'));
    try {
      await writeFile(
        join(dir, '9999_unforced.sql'),
        `CREATE TABLE t497 (organization_id uuid NOT NULL);
         ALTER TABLE t497 ENABLE ROW LEVEL SECURITY;`,
      );
      await expect(migrate(migrator, [dir])).rejects.toThrow(
        /9999_unforced\.sql failed: row-level security is enabled but not forced on: t497/,
      );
      expect(await count(`SELECT count(*) AS n FROM pg_class WHERE relname = 't497'`)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no function elevates the scope with a SET clause (0207); the variant trigger still works for a store session', async () => {
    const withClause = await superDb.query(
      `SELECT p.proname FROM pg_proc p WHERE EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'app.%')`,
    );
    expect(withClause.rows).toEqual([]);

    // what the catalog does: a store-scoped platform_app session inserts an unmapped variant; the SECURITY DEFINER
    // trigger, owned here by the non-bypass migrator, creates its stock item in organization scope ...
    const app = new pg.Pool({
      connectionString: withDatabase(process.env.DATABASE_URL!, DB, 'platform_app', 'platform_app'),
      max: 1,
    });
    app.on('error', () => {});
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.organization_id', $1, true), set_config('app.scope', 'store', true),
                set_config('app.store_ids', $2, true)`,
        [ORG_1, uid(31, 1)],
      );
      const v = await c.query<{ stock_item_id: string | null }>(
        `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title)
         VALUES ($1, $2, $3, 'TEE-2', 'Second') RETURNING stock_item_id`,
        [ORG_1, uid(31, 1), uid(41, 1)],
      );
      expect(v.rows[0]?.stock_item_id).toBeTruthy();
      // ... and hands the session back in store scope
      const scope = await c.query<{ s: string }>(`SELECT current_setting('app.scope') AS s`);
      expect(scope.rows[0]?.s).toBe('store');
      await c.query('ROLLBACK');
    } finally {
      c.release();
      await app.end();
    }
  });
});
