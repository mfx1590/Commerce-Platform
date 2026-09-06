// The single database entry point of apps/core. Every module and every route gets its data access from here:
// a scoped client from @platform/db (RLS-enforced, context set per transaction). Nothing else in this app may
// open a pg connection (see README.md "How a module gets a tenant client"; enforced by eslint.config.mjs).
import {
  connectionStringFromEnv,
  createOrganizationClient,
  createPool,
  createTenantClient,
  loadDotenv,
} from '@platform/db';
import type { OrganizationContext, ScopedClient, TenantContext } from '@platform/db';

type Pool = ReturnType<typeof createPool>;

let pool: Pool | undefined;

export interface InitDbOptions {
  /** Where to start looking for the repo-root .env (default: cwd). */
  startDir?: string;
  /** Explicit connection string (tests point at a throwaway database); default DATABASE_URL_APP. */
  connectionString?: string;
}

/**
 * Loads the repo-root .env and opens the process-wide pool on DATABASE_URL_APP (role platform_app,
 * NOBYPASSRLS). Idempotent. Called by src/server.ts before Medusa boots and by tests in beforeAll. Raw
 * `pool.query` returns zero rows by design — always go through `tenantClient` / `organizationClient`.
 */
export async function initDb(opts: InitDbOptions = {}): Promise<void> {
  if (pool) return;
  loadDotenv(opts.startDir);
  pool = createPool(
    opts.connectionString ?? connectionStringFromEnv('app'),
    Number(process.env.DB_POOL_MAX ?? 10),
  );
}

function ready(): Pool {
  if (!pool)
    throw new Error('database not initialised: call `await initDb()` first (src/lib/db.ts)');
  return pool;
}

export function getPool(): Pool {
  return ready();
}

/** Store scope: rows of the given store(s). What every Store API and store-scoped Admin API request uses. */
export function tenantClient(ctx: TenantContext): ScopedClient {
  return createTenantClient(ready(), ctx);
}

/** Organization (HQ) scope: every store. Only after an organization-level permission check. */
export function organizationClient(ctx: OrganizationContext): ScopedClient {
  return createOrganizationClient(ready(), ctx);
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
