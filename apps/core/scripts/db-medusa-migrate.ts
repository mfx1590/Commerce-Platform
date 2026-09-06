// Medusa's OWN tables (its built-in modules, links, migrations bookkeeping) live in Postgres schema `medusa`,
// in the same database as ours. Ours come from packages/db (`pnpm db:migrate`, owner role) and are never
// re-declared by Medusa.
//
// Why a dedicated role: several Medusa module migrations probe `information_schema.tables` for tables named
// `product`, `order`, … in schema `public` (a Medusa-v1 upgrade check) and, finding OURS, take a legacy branch
// that fails. `information_schema` only lists tables the current role has privileges on, so Medusa migrates as
// `medusa_owner`, a role that owns schema `medusa` and has no rights on our tables. The application itself always
// connects as `platform_app` (DATABASE_URL_APP), which is granted on Medusa's tables via default privileges.
//
// Steps, in order:
//   1. as the owner role (DATABASE_URL): create role `medusa_owner` (dev password, rotated from Vault elsewhere),
//      schema `medusa` owned by it, USAGE for platform_app, the two extensions Medusa's search index wants;
//   2. as `medusa_owner`: default privileges so every table Medusa creates is usable by platform_app;
//   3. as `medusa_owner`: Medusa's migrate command in-process (the `medusa` CLI would need ts-node for a TS
//      config; this project runs TypeScript through tsx only);
//   4. as `medusa_owner`: catch-up grants on what now exists.
import path from 'node:path';
import type { Logger } from '@medusajs/framework/types';
import { connectionStringFromEnv, createPool, loadDotenv } from '@platform/db';

const directory = path.resolve(__dirname, '..');
const APP_ROLE = 'platform_app';
const MEDUSA_ROLE = 'medusa_owner';

function assertIdentifier(value: string, what: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw new Error(`${what} "${value}" is not a plain identifier`);
}

/** Connection string for `medusa_owner`: DATABASE_URL_MEDUSA_OWNER if set, else DATABASE_URL with swapped credentials. */
function medusaOwnerUrl(ownerUrl: string, password: string): string {
  const explicit = process.env.DATABASE_URL_MEDUSA_OWNER;
  if (explicit) return explicit;
  const u = new URL(ownerUrl);
  u.username = MEDUSA_ROLE;
  u.password = password;
  return u.toString();
}

async function runSql(url: string, statements: string[]): Promise<void> {
  const pool = createPool(url, 1);
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

async function runMedusaMigrations(schema: string, medusaUrl: string): Promise<void> {
  process.env.MEDUSA_DB_ROLE = 'owner';
  process.env.DATABASE_URL_MEDUSA_OWNER = medusaUrl;
  process.env.MEDUSA_DB_SCHEMA = schema;
  process.env.MEDUSA_WORKER_MODE = 'server';
  // Imported lazily so the env above is set before medusa-config.ts is evaluated.
  const { initializeContainer } = await import('@medusajs/medusa/loaders/index');
  const { migrate } = await import('@medusajs/medusa/commands/db/migrate');
  const { ContainerRegistrationKeys } = await import('@medusajs/framework/utils');

  const container = await initializeContainer(directory);
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const ok = await migrate({
    directory,
    skipLinks: false,
    // Medusa data-migration scripts fork its CLI (needs ts-node for a TS config) and only patch data from older
    // Medusa versions; a fresh schema has nothing to patch.
    skipScripts: true,
    skipSearch: false,
    executeAllLinks: false,
    executeSafeLinks: true,
    logger,
    container,
  });
  if (!ok) throw new Error('medusa db:migrate reported a failure');
}

async function main(): Promise<void> {
  loadDotenv(directory);

  const schema = process.env.MEDUSA_DB_SCHEMA ?? 'medusa';
  assertIdentifier(schema, 'MEDUSA_DB_SCHEMA');
  // Local default only (mirrors platform_app in packages/db migration 0001); staging/production rotate it via
  // ALTER ROLE from Vault and set DATABASE_URL_MEDUSA_OWNER.
  const medusaPassword = process.env.MEDUSA_DB_OWNER_PASSWORD ?? MEDUSA_ROLE;
  const ownerUrl = connectionStringFromEnv('owner');
  const medusaUrl = medusaOwnerUrl(ownerUrl, medusaPassword);

  const dbName = decodeURIComponent(new URL(ownerUrl).pathname.replace(/^\//, ''));
  assertIdentifier(dbName, 'database name');

  console.info(`core: [owner] role ${MEDUSA_ROLE}, schema "${schema}", extensions…`);
  await runSql(ownerUrl, [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MEDUSA_ROLE}') THEN
         CREATE ROLE ${MEDUSA_ROLE} LOGIN PASSWORD '${medusaPassword.replace(/'/g, "''")}' NOBYPASSRLS;
       END IF;
     END $$`,
    `CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${MEDUSA_ROLE}`,
    `ALTER SCHEMA ${schema} OWNER TO ${MEDUSA_ROLE}`,
    // MikroORM's generated DDL for link tables starts with `create schema if not exists "<schema>"`, which
    // Postgres checks against the CREATE privilege on the database even when the schema already exists.
    `GRANT CREATE ON DATABASE ${dbName} TO ${MEDUSA_ROLE}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${APP_ROLE}`,
    // Medusa's search index wants these; created here so the migration's CREATE EXTENSION IF NOT EXISTS is a no-op
    // and the extension objects live in Medusa's schema, not in public.
    `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${schema}`,
    `CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA ${schema}`,
  ]);

  console.info(`core: [${MEDUSA_ROLE}] default privileges for ${APP_ROLE}…`);
  await runSql(medusaUrl, [
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE}`,
  ]);

  if (!process.argv.includes('--grants-only')) {
    console.info(`core: [${MEDUSA_ROLE}] running Medusa migrations (schema "${schema}")…`);
    await runMedusaMigrations(schema, medusaUrl);
  }

  console.info(`core: [${MEDUSA_ROLE}] catch-up grants for ${APP_ROLE} on existing objects…`);
  await runSql(medusaUrl, [
    `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ${schema} TO ${APP_ROLE}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${APP_ROLE}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${APP_ROLE}`,
  ]);
  console.info('core: Medusa schema ready.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
