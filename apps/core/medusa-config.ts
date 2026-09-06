import { defineConfig } from '@medusajs/framework/utils';

// Settings come from process.env only. The repo-root .env is loaded by whoever boots Medusa before this file is
// evaluated (src/server.ts and scripts/db-medusa-migrate.ts call loadDotenv() from @platform/db first), so the
// `medusa` CLI — which reads this file on its own — sees the same values when its process env is prepared.

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Medusa connects as the application role (DATABASE_URL_APP, RLS-subject). Only `scripts/db-medusa-migrate.ts`
 * sets MEDUSA_DB_ROLE=owner so Medusa's own migrations run as `medusa_owner`, the role that owns schema
 * `medusa` and nothing else (why: see that script).
 */
const dbEnvKey =
  process.env.MEDUSA_DB_ROLE === 'owner' ? 'DATABASE_URL_MEDUSA_OWNER' : 'DATABASE_URL_APP';
const baseDatabaseUrl = process.env[dbEnvKey];
if (!baseDatabaseUrl) throw new Error(`${dbEnvKey} is not set (see .env.example at the repo root)`);

const databaseSchema = process.env.MEDUSA_DB_SCHEMA ?? 'medusa';
if (!/^[a-z_][a-z0-9_]*$/.test(databaseSchema)) {
  throw new Error(`MEDUSA_DB_SCHEMA "${databaseSchema}" is not a plain identifier`);
}

const databaseUrl = baseDatabaseUrl;

/**
 * `databaseSchema` alone is NOT enough to keep Medusa out of `public`: Medusa's module migrations are raw SQL
 * with unqualified table names, and only the shared runtime knex connection sets `search_path` to the schema.
 * The per-module MikroORM connections (used by `db:migrate`) parse the URL into host/user/db and drop query
 * params, so the fix has to travel through `databaseDriverOptions`, which Medusa merges into every MikroORM
 * knex config: `searchPath` for knex, `connection.options` as the libpq startup parameter for node-postgres.
 * Verified on 2026-09-04: without this, 24 Medusa tables landed in `public` next to ours.
 */
const isLocalDatabase = /localhost|127\.0\.0\.1|sslmode=disable/i.test(databaseUrl);
const databaseDriverOptions = {
  searchPath: databaseSchema,
  connection: {
    // Same default Medusa applies when no driver options are given (plain TCP locally, TLS elsewhere).
    ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
    // node-postgres startup parameter. Medusa's type only spells out `ssl`, hence the widening cast.
    options: `-c search_path=${databaseSchema}`,
  } as { ssl?: boolean | { rejectUnauthorized: boolean } },
};

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set (see .env.example at the repo root)');

/** Secrets come from the environment. Local development falls back to obvious placeholders; production never does. */
function secret(name: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) throw new Error(`${name} must be set in production`);
  return `dev-only-${name.toLowerCase()}`;
}

export default defineConfig({
  projectConfig: {
    databaseUrl,
    // Medusa's built-in modules declare tables named product, store, sales_channel, cart, "order", …: the same
    // names as our frozen schema in `public` (packages/db). Keeping Medusa's tables in their own schema is what
    // lets both live in one database without re-declaring anything (together with `databaseDriverOptions`).
    databaseSchema,
    databaseDriverOptions,
    redisUrl,
    workerMode:
      (process.env.MEDUSA_WORKER_MODE as 'shared' | 'server' | 'worker' | undefined) ?? 'shared',
    http: {
      storeCors: process.env.STORE_CORS ?? 'http://localhost:3000,http://localhost:3001',
      adminCors: process.env.ADMIN_CORS ?? 'http://localhost:3100',
      authCors:
        process.env.AUTH_CORS ??
        'http://localhost:3000,http://localhost:3001,http://localhost:3100',
      jwtSecret: secret('JWT_SECRET'),
      cookieSecret: secret('COOKIE_SECRET'),
    },
  },
  // The admin UI is window 4's Next.js app (apps/admin) against packages/contracts; Medusa's dashboard stays off.
  admin: { disable: true },
  modules: [
    { resolve: '@medusajs/medusa/cache-redis', options: { redisUrl } },
    { resolve: '@medusajs/medusa/event-bus-redis', options: { redisUrl } },
  ],
});
