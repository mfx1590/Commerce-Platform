import { describe, expect, it } from 'vitest';
import {
  migrate,
  MigrationChangedError,
  readSqlFiles,
  splitStatements,
  type ChClient,
  type SqlFile,
} from './clickhouse.js';

/** Records commands; `_migrations` is kept in memory so a second run sees the first. */
function fakeClient(): ChClient & { commands: string[] } {
  const recorded: { name: string; checksum: string }[] = [];
  const commands: string[] = [];
  return {
    commands,
    async command({ query }) {
      commands.push(query);
    },
    async query() {
      return { json: async <T>() => recorded.map((r) => ({ ...r })) as T[] };
    },
    async insert({ values }) {
      recorded.push(...(values as { name: string; checksum: string }[]));
    },
    async close() {},
  };
}

describe('data/clickhouse migrations', () => {
  const files = readSqlFiles();

  it('raw_events is a ReplacingMergeTree keyed (topic, event_id) with the envelope columns', () => {
    const raw = files.find((f) => f.name === '0001_raw_events.sql');
    expect(raw).toBeDefined();
    const sql = raw!.sql;
    expect(sql).toMatch(/ENGINE = ReplacingMergeTree\(ingested_at\)/);
    expect(sql).toMatch(/ORDER BY \(topic, event_id\)/);
    for (const col of [
      'topic',
      'version',
      'event_id',
      'store_id',
      'organization_id',
      'occurred_at',
      'published_at',
      'payload',
      'ingested_at',
    ])
      expect(sql).toMatch(new RegExp(`^\\s+${col}\\s`, 'm'));
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it('files are applied in name order with stable, line-ending-free checksums', () => {
    expect(files.map((f) => f.name)).toEqual([...files.map((f) => f.name)].sort());
    for (const f of files) {
      expect(f.sql).not.toContain('\r');
      expect(f.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('splitStatements', () => {
  it('drops comment lines and splits on a ; that ends a line, not one inside a line', () => {
    expect(
      splitStatements(
        "-- head; not a statement\nCREATE TABLE a (x String DEFAULT ';');\n\nSELECT 1;",
      ),
    ).toEqual(["CREATE TABLE a (x String DEFAULT ';')", 'SELECT 1']);
  });
});

describe('migrate', () => {
  const file = (name: string, sql: string): SqlFile => ({ name, sql, checksum: `sum-${sql}` });

  it('creates the database, applies each file once, and a second run applies nothing', async () => {
    const admin = fakeClient();
    const db = fakeClient();
    const set = [
      file('0001_a.sql', 'CREATE TABLE a (x UInt8) ENGINE = Memory;'),
      file('0002_b.sql', 'SELECT 1;\nSELECT 2;'),
    ];
    const first = await migrate(admin, db, 'analytics_test', set);
    expect(admin.commands).toEqual(['CREATE DATABASE IF NOT EXISTS analytics_test']);
    expect(first.applied).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(db.commands.filter((c) => !c.includes('_migrations'))).toEqual([
      'CREATE TABLE a (x UInt8) ENGINE = Memory',
      'SELECT 1',
      'SELECT 2',
    ]);
    const before = db.commands.length;
    const second = await migrate(admin, db, 'analytics_test', set);
    expect(second).toEqual({
      database: 'analytics_test',
      applied: [],
      skipped: ['0001_a.sql', '0002_b.sql'],
    });
    expect(db.commands.length).toBe(before + 1); // only the CREATE TABLE IF NOT EXISTS _migrations
  });

  it('refuses a recorded file whose text changed', async () => {
    const db = fakeClient();
    await migrate(fakeClient(), db, 'analytics_test', [file('0001_a.sql', 'SELECT 1;')]);
    await expect(
      migrate(fakeClient(), db, 'analytics_test', [file('0001_a.sql', 'SELECT 2;')]),
    ).rejects.toBeInstanceOf(MigrationChangedError);
  });

  it('refuses a database name that is not a plain identifier', async () => {
    await expect(migrate(fakeClient(), fakeClient(), 'x; DROP', [])).rejects.toThrow(
      'invalid ClickHouse identifier',
    );
  });
});
