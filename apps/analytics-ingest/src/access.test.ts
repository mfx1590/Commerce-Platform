// #648: the ClickHouse users as versioned SQL (data/clickhouse/access/). Pure: the files, the lint and the runner
// against a recording fake (no password or hash in git or in a statement the fake sees un-hashed, log_queries = 0 on
// every statement, a users.d user skipped). Live (ClickHouse, opt-in like the other live tests): the REAL files
// applied to throwaway users on a throwaway database, then every privilege the ingest uses checked AS
// analytics_ingest (insert + the MV push, the erasure's reads, DELETE and OPTIMIZE) and everything else refused
// (DDL, creating users, system tables), and analytics_ro's limits read back.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccessError,
  applyAccess,
  lintAccessFiles,
  readAccessFiles,
  sha256Hex,
  type AccessFile,
} from './access.js';
import { createChClient, createChReader, type ChClient } from './clickhouse.js';
import { loadConfig } from './config.js';
import { migrate, readSqlFiles } from './migrations.js';
import { clickHouseSkipReason, throwawayDatabase } from './testing/clickhouse-gate.js';

const file = (name: string, sql: string, user = 'u_test'): AccessFile => ({
  name,
  user,
  passwordEnv: 'TEST_PW',
  sql,
});

describe('data/clickhouse/access', () => {
  const files = readAccessFiles();

  it('one file per user, each with its password env, and every statement passes the lint', () => {
    expect(files.map((f) => [f.name, f.user, f.passwordEnv])).toEqual([
      ['10_analytics_ingest.sql', 'analytics_ingest', 'CLICKHOUSE_INGEST_PASSWORD'],
      ['20_analytics_ro.sql', 'analytics_ro', 'CLICKHOUSE_READONLY_PASSWORD'],
    ]);
    expect(lintAccessFiles(files)).toEqual([]);
  });

  it('analytics_ingest: SELECT on the database, INSERT into the tables it writes only, DELETE/OPTIMIZE on raw_events', () => {
    const grants = files[0]!.sql.split('\n').filter((l) => /^(GRANT|REVOKE)/.test(l));
    expect(grants).toEqual([
      'REVOKE ALL ON *.* FROM {{user}};',
      'GRANT SELECT ON {{database}}.* TO {{user}};',
      'GRANT INSERT ON {{database}}.raw_events TO {{user}};',
      'GRANT INSERT ON {{database}}.customer_erasures TO {{user}};',
      'GRANT INSERT ON {{database}}.orders_minute_events TO {{user}};',
      'GRANT ALTER DELETE, ALTER UPDATE(_row_exists), OPTIMIZE ON {{database}}.raw_events TO {{user}};',
    ]);
  });

  it('every materialised view on raw_events has its TO table in the INSERT grants (a new MV cannot be forgotten)', () => {
    const migrations = readSqlFiles().filter((f) => f.kind === 'migration');
    const targets = new Set<string>();
    for (const f of migrations)
      for (const m of f.sql.matchAll(
        /CREATE MATERIALIZED VIEW IF NOT EXISTS \w+ TO (\w+) AS[\s\S]*?\bFROM (\w+)/g,
      ))
        if (m[2] === 'raw_events') targets.add(m[1]!);
    expect([...targets]).toEqual(['orders_minute_events']);
    const inserts = new Set(
      [...files[0]!.sql.matchAll(/^GRANT INSERT ON \{\{database\}\}\.(\w+) TO/gm)].map((m) => m[1]),
    );
    for (const t of ['raw_events', 'customer_erasures', ...targets]) expect(inserts).toContain(t);
  });

  it('analytics_ro: SELECT on the database only, readonly, and the per-user bounds', () => {
    const sql = files[1]!.sql;
    expect(sql.split('\n').filter((l) => /^(GRANT|REVOKE)/.test(l))).toEqual([
      'REVOKE ALL ON *.* FROM {{user}};',
      'GRANT SELECT ON {{database}}.* TO {{user}};',
    ]);
    for (const s of [
      'readonly = 1',
      'max_execution_time = 10',
      'max_result_rows = 100000',
      "result_overflow_mode = 'throw'",
      'max_memory_usage = 536870912',
      'max_memory_usage_for_user = 805306368',
      'max_concurrent_queries_for_user = 16',
      'MAX queries = 1200',
    ])
      expect(sql).toContain(s);
  });
});

describe('lintAccessFiles', () => {
  it.each([
    ['DROP USER {{user}};', 'not an access statement'],
    ['GRANT ALL ON {{database}}.* TO {{user}};', 'GRANT ALL'],
    ['GRANT SELECT ON *.* TO {{user}};', 'a grant on *.*'],
    ['GRANT SELECT ON system.query_log TO {{user}};', 'a grant on system'],
    ['GRANT SELECT ON {{database}}.* TO {{user}} WITH GRANT OPTION;', 'WITH GRANT OPTION'],
    ['GRANT ACCESS MANAGEMENT ON *.* TO {{user}};', 'access management'],
    ["ALTER USER {{user}} IDENTIFIED BY 'a-literal-word';", 'not {{password_sha256}}'],
    ['GRANT SELECT ON {{database}}.* TO someone_else;', '{{user}}'],
    ['CREATE TABLE t (x UInt8) ENGINE = Memory;', 'not an access statement'],
  ])('refuses %s', (sql, why) => {
    const problems = lintAccessFiles([file('x.sql', sql)]);
    expect(problems.join('\n')).toContain(why);
  });
});

/** A recording admin: answers the storage lookup from `storages`, records every command with its settings. */
function fakeAdmin(storages: Record<string, string> = {}) {
  const commands: { query: string; settings: unknown }[] = [];
  const admin: ChClient = {
    async command({ query, clickhouse_settings }) {
      commands.push({ query, settings: clickhouse_settings });
    },
    async query({ query_params }) {
      const s = storages[String(query_params?.u)];
      return { json: async <T>() => (s ? [{ storage: s }] : []) as T[] };
    },
    async insert() {},
    async close() {},
  };
  return { admin, commands };
}

describe('applyAccess', () => {
  const files = readAccessFiles();
  const env = {
    CLICKHOUSE_INGEST_PASSWORD: 'ingest-word',
    CLICKHOUSE_READONLY_PASSWORD: 'ro-word',
  };

  it('substitutes the user, the database and the HASH; every statement runs with log_queries = 0', async () => {
    const { admin, commands } = fakeAdmin();
    const r = await applyAccess(admin, files, { database: 'analytics', env });
    expect(r).toEqual({
      applied: [
        { file: '10_analytics_ingest.sql', user: 'analytics_ingest' },
        { file: '20_analytics_ro.sql', user: 'analytics_ro' },
      ],
      skipped: [],
    });
    expect(commands.length).toBeGreaterThan(8);
    for (const c of commands) {
      expect(c.settings).toEqual({ log_queries: 0 });
      expect(c.query).not.toMatch(/\{\{/);
      expect(c.query).not.toContain('ingest-word'); // the password itself never travels
      expect(c.query).not.toContain('ro-word');
    }
    expect(commands[0]!.query).toBe(
      `CREATE USER IF NOT EXISTS analytics_ingest IDENTIFIED WITH sha256_hash BY '${sha256Hex('ingest-word')}' DEFAULT DATABASE analytics`,
    );
  });

  it('a user users.d defines is skipped with the reason (SQL cannot alter it), the others applied', async () => {
    const { admin, commands } = fakeAdmin({
      analytics_ro: 'users_xml',
      analytics_ingest: 'local_directory',
    });
    const r = await applyAccess(admin, files, { database: 'analytics', env });
    expect(r.applied.map((a) => a.user)).toEqual(['analytics_ingest']);
    expect(r.skipped).toEqual([
      {
        file: '20_analytics_ro.sql',
        user: 'analytics_ro',
        reason: 'defined in users_xml (users.d), not by SQL',
      },
    ]);
    expect(commands.every((c) => !c.query.includes('analytics_ro'))).toBe(true);
  });

  it('a missing password skips the file in dev and FAILS in production (strict)', async () => {
    const { admin } = fakeAdmin();
    const dev = await applyAccess(admin, files, {
      database: 'analytics',
      env: { CLICKHOUSE_INGEST_PASSWORD: 'ingest-word' },
    });
    expect(dev.skipped).toEqual([
      {
        file: '20_analytics_ro.sql',
        user: 'analytics_ro',
        reason: 'CLICKHOUSE_READONLY_PASSWORD is not set',
      },
    ]);
    await expect(
      applyAccess(admin, files, { database: 'analytics', env: {}, strict: true }),
    ).rejects.toBeInstanceOf(AccessError);
  });

  it('refuses lint problems and a database that is not an identifier before touching the server', async () => {
    const { admin, commands } = fakeAdmin();
    await expect(
      applyAccess(admin, [file('x.sql', 'DROP USER {{user}};')], { database: 'analytics', env }),
    ).rejects.toThrow('refusing to apply access');
    await expect(applyAccess(admin, files, { database: 'x; DROP', env })).rejects.toThrow(
      'invalid ClickHouse identifier',
    );
    expect(commands).toEqual([]);
  });
});

// ---- live: the real files, as the real users, on a throwaway database ------------------------------------------

const cfg = loadConfig(process.env, []).clickhouse;
const skip = await clickHouseSkipReason(cfg);

describe.skipIf(skip !== null)('ClickHouse access as SQL (#648)', () => {
  const db = throwawayDatabase();
  const word = db.slice('analytics_test_'.length);
  const users = { analytics_ingest: `${db}_ingest`, analytics_ro: `${db}_ro` };
  // throwaway passwords, generated per run and never written anywhere
  const pw = { ingest: randomBytes(12).toString('hex'), ro: randomBytes(12).toString('hex') };
  let admin: ChClient;
  let asIngest: ChClient;
  let asRo: ChClient;
  const refused = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, 'expected ClickHouse to refuse').not.toBeNull();
    expect(String(err?.message)).toMatch(
      /ACCESS_DENIED|Not enough privileges|readonly|Cannot execute query in readonly mode/i,
    );
  };

  beforeAll(async () => {
    admin = createChClient(cfg, 'default');
    const owner = createChClient(cfg, db);
    await migrate(admin, owner, db, readSqlFiles());
    await owner.close();
    const r = await applyAccess(admin, readAccessFiles(), {
      database: db,
      rename: users,
      env: { CLICKHOUSE_INGEST_PASSWORD: pw.ingest, CLICKHOUSE_READONLY_PASSWORD: pw.ro },
    });
    expect(r.applied.map((a) => a.user)).toEqual([users.analytics_ingest, users.analytics_ro]);
    asIngest = createChClient(
      { ...cfg, username: users.analytics_ingest, password: pw.ingest },
      db,
    );
    // the reader client: a readonly user is refused any per-query setting (as the metrics API reads)
    asRo = createChReader({
      url: cfg.url,
      database: db,
      username: users.analytics_ro,
      password: pw.ro,
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([asIngest?.close(), asRo?.close()]);
    for (const q of [
      `DROP USER IF EXISTS ${users.analytics_ingest}, ${users.analytics_ro}`,
      `DROP QUOTA IF EXISTS ${users.analytics_ro}_quota`,
      `DROP SETTINGS PROFILE IF EXISTS ${users.analytics_ro}_profile`,
      `DROP DATABASE IF EXISTS ${db}`,
    ])
      await admin?.command({ query: q }).catch(() => undefined);
    await admin?.close();
  });

  it('analytics_ingest writes raw events (and the MV pushes them), reads, DELETEs and OPTIMIZEs as the erasure does', async () => {
    const event = '00000000-0000-4000-8000-00000000f648';
    const order = '00000000-0000-4000-8000-00000000a648';
    await asIngest.insert({
      table: 'raw_events',
      format: 'JSONEachRow',
      values: [
        {
          topic: 'order.placed',
          version: 1,
          event_id: event,
          store_id: '00000000-0000-4000-8000-000000000031',
          organization_id: '00000000-0000-4000-8000-000000000001',
          occurred_at: '2026-10-30 10:00:00.000',
          published_at: '2026-10-30 10:00:00.000',
          payload: JSON.stringify({
            order_id: order,
            currency: 'EUR',
            totals: { total_minor: 1234 },
          }),
          ingested_at: '2026-10-30 10:00:01.000',
        },
      ],
    });
    const mv = await (
      await asIngest.query({
        query: 'SELECT total_minor FROM orders_minute_events FINAL WHERE order_id = {o:UUID}',
        query_params: { o: order },
        format: 'JSONEachRow',
      })
    ).json<{ total_minor: string }>();
    expect(mv.map((r) => Number(r.total_minor))).toEqual([1234]);
    await asIngest.insert({
      table: 'customer_erasures',
      format: 'JSONEachRow',
      values: [
        {
          digest: 'f'.repeat(64),
          organization_id: '00000000-0000-4000-8000-000000000001',
          event_id: event,
          erased_at: '2026-10-30 10:00:02.000',
        },
      ],
    });
    // the erasure's own statements, with its own settings
    await asIngest.command({
      query: `DELETE FROM raw_events WHERE event_id IN {ids:Array(UUID)} AND ingested_at < {at:DateTime64(3, 'UTC')}`,
      query_params: { ids: [event], at: '2026-10-30 10:00:05.000' },
      clickhouse_settings: { log_queries: 0 },
    });
    await asIngest.command({
      query: `OPTIMIZE TABLE raw_events PARTITION ID '202610' FINAL`,
      clickhouse_settings: { log_queries: 0 },
    });
    const left = await (
      await asIngest.query({
        query: 'SELECT count() AS n FROM raw_events WHERE event_id = {e:UUID}',
        query_params: { e: event },
        format: 'JSONEachRow',
        use_multipart_params: true,
      })
    ).json<{ n: string }>();
    expect(Number(left[0]!.n)).toBe(0);
  });

  it('analytics_ingest is refused DDL, user management, other tables’ DELETE, system tables and other databases', async () => {
    // INSERT only where it writes: a mart, the reconcile job's ledger_lines and the runner's _migrations are refused
    await refused(
      asIngest.command({
        query: 'INSERT INTO mart_bookings_daily SELECT * FROM mart_bookings_daily LIMIT 0',
      }),
    );
    await refused(
      asIngest.command({ query: 'INSERT INTO ledger_lines SELECT * FROM ledger_lines LIMIT 0' }),
    );
    await refused(
      asIngest.command({ query: "INSERT INTO _migrations (name, checksum) VALUES ('x', 'y')" }),
    );
    await refused(asIngest.command({ query: 'CREATE TABLE t648 (x UInt8) ENGINE = Memory' }));
    await refused(asIngest.command({ query: 'DROP TABLE raw_events' }));
    await refused(
      asIngest.command({ query: `CREATE USER ${db}_evil IDENTIFIED WITH no_password` }),
    );
    await refused(asIngest.command({ query: `GRANT SELECT ON ${db}.* TO ${users.analytics_ro}` }));
    await refused(asIngest.command({ query: 'DELETE FROM customer_erasures WHERE 1' }));
    await refused(
      asIngest.query({ query: 'SELECT count() FROM system.query_log', format: 'JSONEachRow' }),
    );
    await refused(
      asIngest.query({ query: 'SELECT count() FROM analytics.raw_events', format: 'JSONEachRow' }),
    );
  });

  it('analytics_ro reads, is refused every write and system table, and carries the per-user bounds', async () => {
    const n = await (
      await asRo.query({ query: 'SELECT count() AS n FROM raw_events', format: 'JSONEachRow' })
    ).json<{ n: string }>();
    expect(n).toHaveLength(1);
    await refused(
      asRo.insert({ table: 'raw_events', format: 'JSONEachRow', values: [{ topic: 'x' }] }),
    );
    await refused(
      asRo.query({ query: 'SELECT count() FROM system.query_log', format: 'JSONEachRow' }),
    );
    await refused(
      asRo.query({
        query: "SELECT * FROM url('http://127.0.0.1:1/x', CSV, 'a String')",
        format: 'JSONEachRow',
      }),
    );
    const settings = await (
      await asRo.query({
        query: `SELECT getSetting('readonly') AS ro, getSetting('max_concurrent_queries_for_user') AS conc,
                       getSetting('max_memory_usage_for_user') AS mem, getSetting('max_execution_time') AS t`,
        format: 'JSONEachRow',
      })
    ).json<Record<string, string | number>>();
    // getSetting answers numbers or numeric strings depending on the setting's type: compare as numbers
    const num = (k: string) => Number(settings[0]![k]);
    expect([num('ro'), num('conc'), num('mem'), num('t')]).toEqual([1, 16, 805_306_368, 10]);
    expect(word).toMatch(/^[a-z0-9]+$/);
  });

  it('applying the files again changes nothing and still succeeds (idempotent, the grants reset)', async () => {
    const again = await applyAccess(admin, readAccessFiles(), {
      database: db,
      rename: users,
      env: { CLICKHOUSE_INGEST_PASSWORD: pw.ingest, CLICKHOUSE_READONLY_PASSWORD: pw.ro },
    });
    expect(again.applied).toHaveLength(2);
    const grants = await (
      await admin.query({
        query:
          'SELECT toString(access_type) AS access_type, table, column FROM system.grants WHERE user_name = {u:String}',
        query_params: { u: users.analytics_ingest },
        format: 'JSONEachRow',
      })
    ).json<{ access_type: string; table: string | null; column: string | null }>();
    // system.grants orders access_type by its enum, not by name: compare as a sorted set
    expect(
      grants
        .map((g) => `${g.access_type}:${g.table ?? '*'}${g.column ? `(${g.column})` : ''}`)
        .sort(),
    ).toEqual([
      'ALTER DELETE:raw_events',
      'ALTER UPDATE:raw_events(_row_exists)',
      'INSERT:customer_erasures',
      'INSERT:orders_minute_events',
      'INSERT:raw_events',
      'OPTIMIZE:raw_events',
      'SELECT:*',
    ]);
  });
});
