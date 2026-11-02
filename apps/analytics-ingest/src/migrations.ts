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
//
// A backfill runs only once every INSERT already running (any replica, any database) has finished (#685). An MV
// sees only inserts that START after it exists, and a backfill sees only rows committed before it reads: an insert
// that began before the MV and committed after the backfill's read was in neither, and its rows were lost from the
// MV's table for good (proven on ClickHouse: 86 of 150 orders). Waiting for the inserts running at that moment
// closes the gap — each one began either before the MV (it is waited for, so the backfill sees it) or after (the MV
// sees it). Only those inserts are waited for, never ones that start later, so a busy ingest cannot starve it.
// `ch:migrate` runs as the admin, which sees every user's queries. system.processes is PER SERVER, so it is read on
// every replica (`clusterAllReplicas('default', …)`, which a multi-replica service such as ClickHouse Cloud needs),
// falling back to the local table on a single server with no `default` cluster (#687 review).
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

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
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
// #689: replacing a materialised view (create the new one, then drop the old) and removing rows a buggy one wrote.
// Both are narrow on purpose: a DROP only of a VIEW, IF EXISTS, that a migration created as a materialised view;
// a DELETE only of the zero-uuid store rows (what an MV's no-op `store_id IS NOT NULL` let through) from a
// ReplacingMergeTree table. Both are idempotent: a second run drops nothing and deletes nothing.
const DROP_VIEW = /^DROP\s+VIEW\s+(IF\s+EXISTS\s+)?(\w+)$/i;
const DELETE = /^DELETE\s+FROM\s+(\w+)\s+WHERE\s+([\s\S]+)$/i;
const ZERO_STORE = /^store_id\s*=\s*toUUID\(\s*'00000000-0000-0000-0000-000000000000'\s*\)$/i;

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

/** Materialised views the migrations create: the only views a migration may drop. */
function materializedViews(files: readonly SqlFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (f.kind !== 'migration') continue;
    for (const s of splitStatements(f.sql)) {
      const m = /^CREATE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS\s+(\w+)/i.exec(s);
      if (m) out.add(m[1]!);
    }
  }
  return out;
}

/** Every statement that would not survive a second run: [] means the folders are safe to re-run. */
export function lintSqlFiles(files: readonly SqlFile[]): string[] {
  const replacing = replacingTables(files);
  const views = materializedViews(files);
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
      const drop = DROP_VIEW.exec(s);
      if (drop || /^DROP\s/i.test(s)) {
        if (!drop || !drop[1] || !views.has(drop[2]!))
          problems.push(
            `${at}: a DROP is allowed only as DROP VIEW IF EXISTS of a materialised view a migration created`,
          );
        return;
      }
      const del = DELETE.exec(s);
      if (del || /^DELETE\s/i.test(s)) {
        if (!del || !replacing.has(del[1]!) || !ZERO_STORE.test(del[2]!.trim()))
          problems.push(
            `${at}: a DELETE is allowed only as DELETE FROM a ReplacingMergeTree table WHERE store_id = toUUID('00000000-0000-0000-0000-000000000000')`,
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

// ---- the drain before a backfill (#685) ---------------------------------------------------------------------

export const DRAIN_TIMEOUT_MS = 600_000;
export const DRAIN_POLL_MS = 200;

export interface DrainOptions {
  drainTimeoutMs?: number;
  drainPollMs?: number;
}

export class InsertsStillRunningError extends Error {
  constructor(
    readonly database: string,
    readonly queryIds: readonly string[],
  ) {
    super(
      `${queryIds.length} INSERT(s) still running before a backfill into ${database}; nothing was backfilled — ` +
        'run ch:migrate again (every statement is idempotent)',
    );
    this.name = 'InsertsStillRunningError';
  }
}

/**
 * Every INSERT running on EVERY replica (#687 review: system.processes is per server, so on a multi-replica service —
 * ClickHouse Cloud behind one endpoint — the local table would miss an ingest insert on another replica and the
 * drain would be blind). Every INSERT, not only this database's: one issued from another default database
 * (`INSERT INTO analytics.raw_events`) still writes here; the timeout bounds the wait either way.
 */
const RUNNING_INSERTS_ALL_REPLICAS =
  "SELECT hostName() AS host, query_id FROM clusterAllReplicas('default', system.processes) WHERE query_kind = 'Insert'";
/** A single server with no `default` cluster configured (a local ClickHouse): its own table is the whole truth. */
const RUNNING_INSERTS_LOCAL =
  "SELECT hostName() AS host, query_id FROM system.processes WHERE query_kind = 'Insert'";

/** ClickHouse's CLUSTER_DOESNT_EXIST (170): the server has no `default` cluster, so it is a single node. */
const noSuchCluster = (err: unknown) =>
  (err as { code?: string }).code === '170' ||
  /CLUSTER_DOESNT_EXIST/.test((err as Error).message ?? '');

/**
 * Waits until every INSERT running NOW (on any replica, into any database) has finished; inserts that start later
 * are not waited for. Past the timeout it throws rather than backfill with an insert still in flight (the rows it is
 * writing could be lost); the migration is re-run as a whole.
 */
export async function waitForRunningInserts(
  db: ChClient,
  database: string,
  opts: DrainOptions = {},
): Promise<void> {
  let query = RUNNING_INSERTS_ALL_REPLICAS;
  const read = async () =>
    (await db.query({ query, format: 'JSONEachRow' })).json<{ host: string; query_id: string }>();
  const running = async () => {
    let rows: { host: string; query_id: string }[];
    try {
      rows = await read();
    } catch (err) {
      if (query === RUNNING_INSERTS_LOCAL || !noSuchCluster(err)) throw err;
      query = RUNNING_INSERTS_LOCAL;
      rows = await read();
    }
    return new Set(rows.map((r) => `${r.query_id}@${r.host}`));
  };
  const waitingFor = await running();
  const deadline = Date.now() + (opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
  while (waitingFor.size > 0) {
    const now = await running();
    for (const id of [...waitingFor]) if (!now.has(id)) waitingFor.delete(id);
    if (waitingFor.size === 0) return;
    if (Date.now() >= deadline) throw new InsertsStillRunningError(database, [...waitingFor]);
    await new Promise((r) => setTimeout(r, opts.drainPollMs ?? DRAIN_POLL_MS));
  }
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
  opts: { holder?: string } & LockOptions & DrainOptions = {},
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
      for (const statement of splitStatements(f.sql)) {
        // a backfill, and a DELETE too (#689): an insert begun before a superseded MV was dropped still writes
        // through it, so the rows it could add must be in before the DELETE reads
        if (INSERT.test(statement) || DELETE.test(statement))
          await waitForRunningInserts(db, database, opts);
        await db.command({ query: statement });
      }
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
