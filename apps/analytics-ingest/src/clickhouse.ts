// ClickHouse access: the client, the raw_events sink and the migration runner (`pnpm ch:migrate`).
//
// Migrations are versioned SQL under data/clickhouse/migrations/ (and, from #601, models under
// data/clickhouse/models/), applied in file-name order, each once. `_migrations` records the name and a sha256
// of every applied file; a second run applies nothing, and a recorded file whose text changed is refused (write
// a new file instead, as with packages/db).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@clickhouse/client';
import type { RowSink } from './batcher.js';
import type { ClickHouseConfig } from './config.js';
import type { RawEventRow } from './rows.js';

/** The slice of @clickhouse/client the ingest uses (a fake implements it in the tests). */
export interface ChClient {
  command(p: { query: string }): Promise<unknown>;
  query(p: { query: string; format: 'JSONEachRow' }): Promise<{ json<T>(): Promise<T[]> }>;
  insert(p: { table: string; values: readonly unknown[]; format: 'JSONEachRow' }): Promise<unknown>;
  close(): Promise<void>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function assertIdentifier(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid ClickHouse identifier "${name}"`);
  return name;
}

/** The WRITER (ingest, migrator): pins the insert settings the offset commit relies on. */
export function createChClient(cfg: ClickHouseConfig, database = cfg.database): ChClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: assertIdentifier(database),
    request_timeout: 30_000,
    // the insert's response is the acknowledgement the offset commit waits for: no async insert
    clickhouse_settings: { async_insert: 0, date_time_input_format: 'best_effort' },
  }) as unknown as ChClient;
}

/**
 * A READER (`analytics_ro`, readonly = 1): sends no per-query settings, because a readonly user is refused any
 * ("Cannot modify … in readonly mode"). Reads only; the metrics API (#603) builds on it.
 */
export function createChReader(
  cfg: Pick<ClickHouseConfig, 'url' | 'database'> & { username: string; password: string },
): ChClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: assertIdentifier(cfg.database),
    request_timeout: 30_000,
  }) as unknown as ChClient;
}

export function createRawEventsSink(client: ChClient, table = 'raw_events'): RowSink<RawEventRow> {
  assertIdentifier(table);
  return {
    async insert(rows) {
      await client.insert({ table, values: rows, format: 'JSONEachRow' });
    },
  };
}

// ---- migrations --------------------------------------------------------------------------------------------

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
export const DEFAULT_SQL_DIRS = [join(REPO_ROOT, 'data/clickhouse/migrations')];

export interface SqlFile {
  name: string;
  sql: string;
  checksum: string;
}

export function readSqlFiles(dirs: readonly string[] = DEFAULT_SQL_DIRS): SqlFile[] {
  const files: SqlFile[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      // line endings do not change a checksum: a Windows checkout and CI agree
      const sql = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
      files.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
    }
  }
  return files;
}

/** Statements of a file: `--` comments dropped, split on a `;` that ends a line. */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface MigrateResult {
  database: string;
  applied: string[];
  skipped: string[];
}

export class MigrationChangedError extends Error {
  constructor(name: string) {
    super(
      `migration ${name} was applied with different text; add a new file instead of editing it`,
    );
    this.name = 'MigrationChangedError';
  }
}

/**
 * `admin` is a client on any existing database (it creates `database`); `db` is a client on `database`.
 * Idempotent: every statement of a file runs only if the file is not recorded yet.
 */
export async function migrate(
  admin: ChClient,
  db: ChClient,
  database: string,
  files: readonly SqlFile[] = readSqlFiles(),
): Promise<MigrateResult> {
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${assertIdentifier(database)}` });
  await db.command({
    query: `CREATE TABLE IF NOT EXISTS _migrations (name String, checksum String, applied_at DateTime64(3, 'UTC') DEFAULT now64(3)) ENGINE = ReplacingMergeTree(applied_at) ORDER BY name`,
  });
  const done = new Map(
    (
      await (
        await db.query({
          query: 'SELECT name, checksum FROM _migrations FINAL',
          format: 'JSONEachRow',
        })
      ).json<{ name: string; checksum: string }>()
    ).map((r) => [r.name, r.checksum]),
  );
  const result: MigrateResult = { database, applied: [], skipped: [] };
  for (const f of files) {
    const recorded = done.get(f.name);
    if (recorded !== undefined) {
      if (recorded !== f.checksum) throw new MigrationChangedError(f.name);
      result.skipped.push(f.name);
      continue;
    }
    for (const statement of splitStatements(f.sql)) await db.command({ query: statement });
    await db.insert({
      table: '_migrations',
      values: [{ name: f.name, checksum: f.checksum }],
      format: 'JSONEachRow',
    });
    result.applied.push(f.name);
  }
  return result;
}
