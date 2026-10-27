// The ClickHouse schema runner (`pnpm ch:migrate`).
//
// Two kinds of file, applied in this order:
//   * migrations (data/clickhouse/migrations/*.sql): tables, materialised views and their TO tables. Each file runs
//     once; editing an applied file is refused (add a new one, as with packages/db). Replacing a materialised view
//     without its TO table would drop its data, so MVs live here, never in models.
//   * models (data/clickhouse/models/*.sql): plain views only (CREATE OR REPLACE VIEW), re-applied whenever the
//     file's text changes, so a model is edited in place and reviewed as a diff.
// `_migrations` records a sha256 per file (models as `models/<file>`).
//
// The runner relies on every statement being idempotent (a file that failed halfway is simply run again): the lint
// (`lintSqlFiles`, enforced by a test over the folders) accepts only IF NOT EXISTS / OR REPLACE statements and an
// INSERT … SELECT into a ReplacingMergeTree table (a backfill whose copies fold). Two runners at once are kept
// apart by `_migrations_lock`: each inserts its claim, and the oldest live claim wins; the other refuses.
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIdentifier, type ChClient } from './clickhouse.js';

export type SqlKind = 'migration' | 'model';

export interface SqlSource {
  dir: string;
  kind: SqlKind;
}

export interface SqlFile {
  /** The `_migrations` key: the file name for a migration, `models/<file>` for a model. */
  name: string;
  kind: SqlKind;
  sql: string;
  checksum: string;
}

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
export const DEFAULT_SQL_SOURCES: readonly SqlSource[] = [
  { dir: join(REPO_ROOT, 'data/clickhouse/migrations'), kind: 'migration' },
  { dir: join(REPO_ROOT, 'data/clickhouse/models'), kind: 'model' },
];

export function readSqlFiles(sources: readonly SqlSource[] = DEFAULT_SQL_SOURCES): SqlFile[] {
  const files: SqlFile[] = [];
  for (const { dir, kind } of sources) {
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      // line endings do not change a checksum: a Windows checkout and CI agree
      const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      files.push({
        name: kind === 'model' ? `models/${file}` : file,
        kind,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      });
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

// ---- the idempotency lint ----------------------------------------------------------------------------------

const MIGRATION_OK = [
  /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s/i,
  /^CREATE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS\s/i,
  /^ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s/i,
];
const MODEL_OK = /^CREATE\s+OR\s+REPLACE\s+VIEW\s/i;
const INSERT = /^INSERT\s+INTO\s+(\w+)\s/i;

/** Tables created by the migrations with a ReplacingMergeTree engine: the only safe backfill targets. */
function replacingTables(files: readonly SqlFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (f.kind !== 'migration') continue;
    for (const s of splitStatements(f.sql)) {
      const m = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i.exec(s);
      if (m && /ENGINE\s*=\s*ReplacingMergeTree/i.test(s)) out.add(m[1]!);
    }
  }
  return out;
}

/** Every statement that would not survive a second run: [] means the folders are safe to re-run. */
export function lintSqlFiles(files: readonly SqlFile[]): string[] {
  const replacing = replacingTables(files);
  const problems: string[] = [];
  for (const f of files) {
    splitStatements(f.sql).forEach((s, i) => {
      const at = `${f.name} statement ${i + 1}`;
      if (f.kind === 'model') {
        if (!MODEL_OK.test(s)) problems.push(`${at}: a model must be CREATE OR REPLACE VIEW`);
        return;
      }
      const insert = INSERT.exec(s);
      if (insert) {
        if (!replacing.has(insert[1]!) || !/\bSELECT\b/i.test(s))
          problems.push(
            `${at}: an INSERT is allowed only as INSERT … SELECT into a ReplacingMergeTree table`,
          );
        return;
      }
      if (!MIGRATION_OK.some((re) => re.test(s)))
        problems.push(
          `${at}: not idempotent (use CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)`,
        );
    });
  }
  return problems;
}

// ---- the lock ----------------------------------------------------------------------------------------------

export class MigrationLockedError extends Error {
  constructor(holder: string) {
    super(`another ch:migrate holds the lock (${holder}); retry when it has finished`);
    this.name = 'MigrationLockedError';
  }
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
 * A claim whose holder has not renewed it for this long is a crashed runner's: it no longer counts, and the next
 * acquire sweeps it. A LIVE runner renews its claim every LOCK_RENEW_SECONDS, so a migration that runs longer than
 * the TTL keeps the lock (#628 review, finding 3). The longest expected run is the 0002 backfill over raw_events FINAL:
 * seconds at today's volume, minutes at years of history — the renewal, not the TTL, is what covers it; the TTL only
 * bounds how long a CRASHED runner blocks the next one.
 */
export const LOCK_TTL_SECONDS = 600;
export const LOCK_RENEW_SECONDS = 120;

export interface LockOptions {
  ttlSeconds?: number;
  renewSeconds?: number;
}

/**
 * The claim table: one row per claim and per renewal; a holder is live while its newest `renewed_at` is within the
 * TTL, and the winner is the live holder with the OLDEST first claim (renewals never change who holds the lock).
 */
async function ensureLockTable(db: ChClient): Promise<void> {
  await db.command({
    query: `CREATE TABLE IF NOT EXISTS _migrations_lock (holder String, acquired_at DateTime64(3, 'UTC') DEFAULT now64(3), renewed_at DateTime64(3, 'UTC') DEFAULT now64(3)) ENGINE = MergeTree ORDER BY acquired_at`,
  });
  // a lock table from before the renewal (#600 – #623) gains the column; its rows count as renewed when acquired
  await db.command({
    query: `ALTER TABLE _migrations_lock ADD COLUMN IF NOT EXISTS renewed_at DateTime64(3, 'UTC') DEFAULT acquired_at`,
  });
}

async function acquireLock(db: ChClient, holder: string, ttl: number): Promise<void> {
  await ensureLockTable(db);
  // sweep the claims of runners that stopped renewing (crashed), never our own
  const stale = (
    await (
      await db.query({
        query: `SELECT holder FROM _migrations_lock GROUP BY holder HAVING max(renewed_at) <= now64(3) - toIntervalSecond({ttl:UInt32})`,
        format: 'JSONEachRow',
        query_params: { ttl },
      })
    ).json<{ holder: string }>()
  )
    .map((r) => r.holder)
    .filter((h) => h !== holder);
  if (stale.length > 0)
    await db.command({
      query: 'DELETE FROM _migrations_lock WHERE holder IN {stale:Array(String)}',
      query_params: { stale },
    });
  await db.insert({ table: '_migrations_lock', values: [{ holder }], format: 'JSONEachRow' });
  const live = await (
    await db.query({
      query: `SELECT holder, min(acquired_at) AS first_claim FROM _migrations_lock GROUP BY holder HAVING max(renewed_at) > now64(3) - toIntervalSecond({ttl:UInt32}) ORDER BY first_claim, holder LIMIT 1`,
      format: 'JSONEachRow',
      query_params: { ttl },
    })
  ).json<{ holder: string }>();
  const winner = live[0]?.holder;
  if (winner !== holder) {
    await releaseLock(db, holder);
    throw new MigrationLockedError(winner ?? 'unknown');
  }
}

/** Keeps a live claim live while the migration runs; returns the stop function. */
function renewLock(db: ChClient, holder: string, everySeconds: number): () => void {
  const timer = setInterval(() => {
    void db
      .insert({ table: '_migrations_lock', values: [{ holder }], format: 'JSONEachRow' })
      .catch(() => undefined); // a missed renewal is retried at the next tick; only a dead runner stops renewing
  }, everySeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function releaseLock(db: ChClient, holder: string): Promise<void> {
  await db.command({
    query: 'DELETE FROM _migrations_lock WHERE holder = {holder:String}',
    query_params: { holder },
  });
}

// ---- migrate -----------------------------------------------------------------------------------------------

export interface MigrateResult {
  database: string;
  applied: string[];
  /** Models whose text changed since they were applied, and were applied again. */
  reapplied: string[];
  skipped: string[];
}

/**
 * `admin` is a client on any existing database (it creates `database`); `db` is a client on `database`.
 * Migrations first, then models, each in file-name order.
 */
export async function migrate(
  admin: ChClient,
  db: ChClient,
  database: string,
  files: readonly SqlFile[] = readSqlFiles(),
  opts: { holder?: string } & LockOptions = {},
): Promise<MigrateResult> {
  const problems = lintSqlFiles(files);
  if (problems.length > 0) throw new Error(`refusing to migrate:\n${problems.join('\n')}`);
  await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${assertIdentifier(database)}` });
  const holder = opts.holder ?? randomUUID();
  await acquireLock(db, holder, opts.ttlSeconds ?? LOCK_TTL_SECONDS);
  const stopRenewing = renewLock(db, holder, opts.renewSeconds ?? LOCK_RENEW_SECONDS);
  try {
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
    const ordered = [
      ...files.filter((f) => f.kind === 'migration'),
      ...files.filter((f) => f.kind === 'model'),
    ];
    const result: MigrateResult = { database, applied: [], reapplied: [], skipped: [] };
    for (const f of ordered) {
      const recorded = done.get(f.name);
      if (recorded === f.checksum) {
        result.skipped.push(f.name);
        continue;
      }
      if (recorded !== undefined && f.kind === 'migration') throw new MigrationChangedError(f.name);
      for (const statement of splitStatements(f.sql)) await db.command({ query: statement });
      await db.insert({
        table: '_migrations',
        values: [{ name: f.name, checksum: f.checksum }],
        format: 'JSONEachRow',
      });
      (recorded === undefined ? result.applied : result.reapplied).push(f.name);
    }
    return result;
  } finally {
    stopRenewing();
    await releaseLock(db, holder);
  }
}
