import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

/** Migration directories, applied together and ordered by file name (NNNN_name.sql). */
export const DEFAULT_MIGRATION_DIRS = [
  resolve(here, '../migrations'),
  resolve(here, '../../events/migrations'), // outbox table (packages/events), files are numbered 01xx
];

export interface MigrationFile {
  name: string;
  path: string;
}

export async function listMigrations(dirs: string[] = DEFAULT_MIGRATION_DIRS): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // optional directory
    }
    for (const name of entries) {
      if (/^\d{4}_.+\.sql$/.test(name)) files.push({ name, path: join(dir, name) });
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.name)) throw new Error(`duplicate migration name: ${f.name}`);
    seen.add(f.name);
  }
  return files;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction, recording them in schema_migrations.
 * Must run as the database owner (DATABASE_URL), never as platform_app.
 */
export async function migrate(pool: Pool, dirs?: string[]): Promise<MigrateResult> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const result: MigrateResult = { applied: [], skipped: [] };
  for (const m of await listMigrations(dirs)) {
    if (done.has(m.name)) {
      result.skipped.push(m.name);
      continue;
    }
    const sql = await readFile(m.path, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
      await client.query('COMMIT');
      result.applied.push(m.name);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return result;
}
