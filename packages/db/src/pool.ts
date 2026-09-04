import pg from 'pg';

const { Pool } = pg;

/**
 * DATABASE_URL     = owner role (migrations, seeds, tests bootstrap). Bypasses nothing: FORCE RLS still applies.
 * DATABASE_URL_APP = platform_app role (NOBYPASSRLS) — what every application process must use.
 */
export function connectionStringFromEnv(kind: 'owner' | 'app' = 'app'): string {
  const key = kind === 'owner' ? 'DATABASE_URL' : 'DATABASE_URL_APP';
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set (see .env.example)`);
  return value;
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new Pool({ connectionString, max, application_name: 'platform' });
}
