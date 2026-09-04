import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

/**
 * Loads the nearest `.env` (walking up from cwd, max 5 levels) into process.env without overriding set vars.
 * Dependency-free replacement for dotenv, used by the CLI and by tests; apps may use their own loader.
 */
export function loadDotenv(startDir = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && m[1] && !(m[1] in process.env))
          process.env[m[1]] = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
      }
      return file;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

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
