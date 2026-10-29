import { describe, expect, it } from 'vitest';
import type { ChClient } from './clickhouse.js';
import {
  lintSqlFiles,
  migrate,
  MigrationChangedError,
  LOCK_TTL_SECONDS,
  MigrationLockedError,
  readSqlFiles,
  splitStatements,
  type SqlFile,
} from './migrations.js';

/**
 * A ClickHouse double for the runner: `_migrations` and `_migrations_lock` in memory, every command recorded, and a
 * clock in SECONDS the tests move (`tick`). A lock row is { holder, acquired, renewed }; the two lock queries are
 * answered with the runner's semantics (a holder is live while its newest renewal is within the TTL; the winner is
 * the live holder with the oldest first claim).
 */
function fakeServer() {
  const recorded: { name: string; checksum: string }[] = [];
  let locks: { holder: string; acquired: number; renewed: number }[] = [];
  let now = 1_000;
  const commands: string[] = [];
  const byHolder = () => {
    const m = new Map<string, { first: number; last: number }>();
    for (const l of locks) {
      const cur = m.get(l.holder) ?? { first: l.acquired, last: l.renewed };
      m.set(l.holder, {
        first: Math.min(cur.first, l.acquired),
        last: Math.max(cur.last, l.renewed),
      });
    }
    return m;
  };
  const client = (): ChClient & { commands: string[] } => ({
    commands,
    async command({ query, query_params }) {
      if (query.startsWith('DELETE FROM _migrations_lock WHERE holder IN')) {
        const stale = new Set(query_params?.stale as string[]);
        locks = locks.filter((l) => !stale.has(l.holder));
      } else if (query.startsWith('DELETE FROM _migrations_lock WHERE holder =')) {
        locks = locks.filter((l) => l.holder !== query_params?.holder);
      }
      commands.push(query);
    },
    async query({ query, query_params }) {
      const ttl = Number(query_params?.ttl ?? 0);
      let rows: unknown[];
      if (query.includes('HAVING max(renewed_at) <='))
        rows = [...byHolder()]
          .filter(([, h]) => h.last <= now - ttl)
          .map(([holder]) => ({ holder }));
      else if (query.includes('HAVING max(renewed_at) >'))
        rows = [...byHolder()]
          .filter(([, h]) => h.last > now - ttl)
          .sort(([a, x], [b, y]) => x.first - y.first || a.localeCompare(b))
          .slice(0, 1)
          .map(([holder]) => ({ holder }));
      else rows = recorded.map((r) => ({ ...r }));
      return { json: async <T>() => rows as T[] };
    },
    async insert({ table, values }) {
      if (table === '_migrations_lock')
        for (const v of values as { holder: string }[])
          locks.push({ holder: v.holder, acquired: now, renewed: now });
      else recorded.push(...(values as { name: string; checksum: string }[]));
    },
    async close() {},
  });
  return {
    client,
    commands,
    get locks() {
      return locks;
    },
    /** Another runner's claim, first made `ageSeconds` ago and last renewed `renewedAgo` seconds ago. */
    claim(holder: string, ageSeconds = 1, renewedAgo = 0) {
      locks.push({ holder, acquired: now - ageSeconds, renewed: now - renewedAgo });
    },
    tick(seconds: number) {
      now += seconds;
    },
  };
}

const mig = (name: string, sql: string): SqlFile => ({
  name,
  kind: 'migration',
  sql,
  checksum: `sum-${sql}`,
});
const model = (file: string, sql: string): SqlFile => ({
  name: `models/${file}`,
  kind: 'model',
  sql,
  checksum: `sum-${sql}`,
});
const userStatements = (commands: string[]) =>
  commands.filter((c) => !c.includes('_migrations') && !c.startsWith('CREATE DATABASE'));

describe('data/clickhouse', () => {
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
  });

  it('every statement in both folders survives a second run (the idempotency lint)', () => {
    expect(files.some((f) => f.kind === 'model')).toBe(true);
    expect(lintSqlFiles(files)).toEqual([]);
  });

  it('files are ordered by name with stable, line-ending-free checksums', () => {
    for (const kind of ['migration', 'model'] as const) {
      const names = files.filter((f) => f.kind === kind).map((f) => f.name);
      expect(names).toEqual([...names].sort());
    }
    for (const f of files) {
      expect(f.sql).not.toContain('\r');
      expect(f.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('lintSqlFiles', () => {
  it('refuses non-idempotent migrations and models that are not CREATE OR REPLACE VIEW', () => {
    expect(
      lintSqlFiles([
        mig('0001_a.sql', 'CREATE TABLE a (x UInt8) ENGINE = Memory;\nDROP TABLE b;'),
        model('100_v.sql', 'CREATE VIEW v AS SELECT 1;'),
      ]),
    ).toEqual([
      '0001_a.sql statement 1: not idempotent (use CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)',
      '0001_a.sql statement 2: not idempotent (use CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)',
      'models/100_v.sql statement 1: a model must be CREATE OR REPLACE VIEW',
    ]);
  });

  it('allows a backfill INSERT … SELECT only into a ReplacingMergeTree table', () => {
    const tables = mig(
      '0001_t.sql',
      'CREATE TABLE IF NOT EXISTS r (x UInt8) ENGINE = ReplacingMergeTree ORDER BY x;\nCREATE TABLE IF NOT EXISTS m (x UInt8) ENGINE = MergeTree ORDER BY x;',
    );
    expect(lintSqlFiles([tables, mig('0002_b.sql', 'INSERT INTO r SELECT 1;')])).toEqual([]);
    expect(lintSqlFiles([tables, mig('0002_b.sql', 'INSERT INTO m SELECT 1;')])).toHaveLength(1);
    expect(lintSqlFiles([tables, mig('0002_b.sql', 'INSERT INTO r VALUES (1);')])).toHaveLength(1);
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
  const set = [
    model('100_v.sql', 'CREATE OR REPLACE VIEW v AS SELECT x FROM a;'),
    mig('0001_a.sql', 'CREATE TABLE IF NOT EXISTS a (x UInt8) ENGINE = Memory;'),
    mig('0002_b.sql', 'CREATE TABLE IF NOT EXISTS b (x UInt8) ENGINE = Memory;'),
  ];

  it('creates the database, applies migrations then models, and a second run applies nothing', async () => {
    const s = fakeServer();
    const first = await migrate(s.client(), s.client(), 'analytics_test', set);
    expect(s.commands[0]).toBe('CREATE DATABASE IF NOT EXISTS analytics_test');
    expect(first.applied).toEqual(['0001_a.sql', '0002_b.sql', 'models/100_v.sql']);
    expect(userStatements(s.commands)).toEqual([
      'CREATE TABLE IF NOT EXISTS a (x UInt8) ENGINE = Memory',
      'CREATE TABLE IF NOT EXISTS b (x UInt8) ENGINE = Memory',
      'CREATE OR REPLACE VIEW v AS SELECT x FROM a',
    ]);
    const before = userStatements(s.commands).length;
    const second = await migrate(s.client(), s.client(), 'analytics_test', set);
    expect(second).toEqual({
      database: 'analytics_test',
      applied: [],
      reapplied: [],
      skipped: ['0001_a.sql', '0002_b.sql', 'models/100_v.sql'],
    });
    expect(userStatements(s.commands).length).toBe(before);
    expect(s.locks).toEqual([]); // released both times
  });

  it('re-applies a model whose text changed', async () => {
    const s = fakeServer();
    await migrate(s.client(), s.client(), 'analytics_test', set);
    const edited = [
      set[1]!,
      set[2]!,
      model('100_v.sql', 'CREATE OR REPLACE VIEW v AS SELECT x + 1 AS x FROM a;'),
    ];
    const r = await migrate(s.client(), s.client(), 'analytics_test', edited);
    expect(r.reapplied).toEqual(['models/100_v.sql']);
    expect(userStatements(s.commands).at(-1)).toBe(
      'CREATE OR REPLACE VIEW v AS SELECT x + 1 AS x FROM a',
    );
  });

  it('refuses a recorded MIGRATION whose text changed, and releases the lock', async () => {
    const s = fakeServer();
    await migrate(s.client(), s.client(), 'analytics_test', [set[1]!]);
    await expect(
      migrate(s.client(), s.client(), 'analytics_test', [
        mig('0001_a.sql', 'CREATE TABLE IF NOT EXISTS a (y UInt8) ENGINE = Memory;'),
      ]),
    ).rejects.toBeInstanceOf(MigrationChangedError);
    expect(s.locks).toEqual([]);
  });

  it('refuses to run while another runner holds a live claim, and withdraws its own', async () => {
    const s = fakeServer();
    s.claim('the-other-runner');
    await expect(
      migrate(s.client(), s.client(), 'analytics_test', set, { holder: 'me' }),
    ).rejects.toBeInstanceOf(MigrationLockedError);
    expect(s.locks.map((l) => l.holder)).toEqual(['the-other-runner']);
    expect(userStatements(s.commands)).toEqual([]);
  });

  // #628 review, finding 3: a crashed runner's claim is swept; a long-running live one is not
  it('takes over a STALE claim (a crashed runner that stopped renewing) and sweeps its rows', async () => {
    const s = fakeServer();
    s.claim('crashed-runner', LOCK_TTL_SECONDS + 100, LOCK_TTL_SECONDS + 100);
    const r = await migrate(s.client(), s.client(), 'analytics_test', set, { holder: 'me' });
    expect(r.applied).toEqual(['0001_a.sql', '0002_b.sql', 'models/100_v.sql']);
    expect(s.locks).toEqual([]); // the crashed claim swept, ours released
  });

  it('does NOT take over an old claim that is still being renewed (a run longer than the TTL keeps the lock)', async () => {
    const s = fakeServer();
    s.claim('long-runner', LOCK_TTL_SECONDS + 100, 30);
    await expect(
      migrate(s.client(), s.client(), 'analytics_test', set, { holder: 'me' }),
    ).rejects.toBeInstanceOf(MigrationLockedError);
    expect(new Set(s.locks.map((l) => l.holder))).toEqual(new Set(['long-runner']));
    expect(userStatements(s.commands)).toEqual([]);
  });

  it('renews its own claim while a slow migration runs, and stops renewing when it is done', async () => {
    const s = fakeServer();
    const slow = s.client();
    const base = slow.command.bind(slow);
    slow.command = async (p) => {
      if (!p.query.includes('_migrations')) await new Promise((r) => setTimeout(r, 120));
      return base(p);
    };
    let renewals = 0;
    const insert = slow.insert.bind(slow);
    slow.insert = async (p) => {
      if (p.table === '_migrations_lock') renewals += 1;
      return insert(p);
    };
    await migrate(s.client(), slow, 'analytics_test', set, { holder: 'me', renewSeconds: 0.05 });
    const atEnd = renewals;
    expect(atEnd).toBeGreaterThan(2); // the claim + renewals during ~360 ms of statements
    await new Promise((r) => setTimeout(r, 150));
    expect(renewals).toBe(atEnd); // no renewal after the run
  });

  it('refuses files that fail the lint before touching the server', async () => {
    const s = fakeServer();
    await expect(
      migrate(s.client(), s.client(), 'analytics_test', [mig('0001_a.sql', 'DROP TABLE a;')]),
    ).rejects.toThrow('refusing to migrate');
    expect(s.commands).toEqual([]);
  });

  it('refuses a database name that is not a plain identifier', async () => {
    const s = fakeServer();
    await expect(migrate(s.client(), s.client(), 'x; DROP', [])).rejects.toThrow(
      'invalid ClickHouse identifier',
    );
  });
});
