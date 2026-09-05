// The single database entry point of apps/core. Every module and every route gets its data access from here:
// a scoped client from @platform/db (RLS-enforced, context set per transaction). Nothing else in this app may
// open a pg connection (see README.md "How a module gets a tenant client").
//
// @platform/db is ESM-only and this app is CommonJS (Medusa), so the package is loaded once with a dynamic
// import() in `initDb()` (called by src/server.ts before Medusa boots, and by tests in beforeAll). Static
// imports return once the packages export a `default` condition (GitHub REQUEST issue from task 1.1).
import type * as PlatformDb from '@platform/db';
import type { OrganizationContext, ScopedClient, TenantContext } from '@platform/db';

type DbModule = typeof PlatformDb;
type Pool = ReturnType<DbModule['createPool']>;

let db: DbModule | undefined;
let pool: Pool | undefined;

/**
 * Loads @platform/db, the repo-root .env, and opens the process-wide pool on DATABASE_URL_APP (role
 * platform_app, NOBYPASSRLS). Idempotent. Raw `pool.query` returns zero rows by design — always go through
 * `tenantClient` / `organizationClient`.
 */
export async function initDb(startDir?: string): Promise<void> {
  if (pool) return;
  db ??= await import('@platform/db');
  db.loadDotenv(startDir);
  pool = db.createPool(db.connectionStringFromEnv('app'), Number(process.env.DB_POOL_MAX ?? 10));
}

function ready(): { db: DbModule; pool: Pool } {
  if (!db || !pool)
    throw new Error('database not initialised: call `await initDb()` first (src/lib/db.ts)');
  return { db, pool };
}

export function getPool(): Pool {
  return ready().pool;
}

/** Store scope: rows of the given store(s). What every Store API and store-scoped Admin API request uses. */
export function tenantClient(ctx: TenantContext): ScopedClient {
  const r = ready();
  return r.db.createTenantClient(r.pool, ctx);
}

/** Organization (HQ) scope: every store. Only after an organization-level permission check. */
export function organizationClient(ctx: OrganizationContext): ScopedClient {
  const r = ready();
  return r.db.createOrganizationClient(r.pool, ctx);
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
