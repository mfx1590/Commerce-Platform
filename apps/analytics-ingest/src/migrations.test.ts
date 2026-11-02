import { describe, expect, it } from 'vitest';
import type { ChClient } from './clickhouse.js';
import {
  InsertsStillRunningError,
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
  /** system.processes, one answer per poll (the last one repeats; none running by default) */
  const running: string[][] = [];
  let polls = 0;
  /** a single server with no `default` cluster: clusterAllReplicas fails with CLUSTER_DOESNT_EXIST */
  const topology = { clusterless: false, sources: [] as string[] };
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
      if (query.includes('system.processes')) {
        const cluster = query.includes('clusterAllReplicas');
        topology.sources.push(cluster ? 'cluster' : 'local');
        if (cluster && topology.clusterless)
          throw Object.assign(
            new Error("Requested cluster 'default' not found. (CLUSTER_DOESNT_EXIST)"),
            {
              code: '170',
            },
          );
        const ids = running[Math.min(polls, running.length - 1)] ?? [];
        polls += 1;
        commands.push(`POLL ${ids.join(',')}`);
        rows = ids.map((query_id) => ({ host: 'ch-1', query_id }));
      } else if (query.includes('HAVING max(renewed_at) <='))
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
    /** the INSERTs system.processes shows, poll by poll */
    running,
    topology,
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
  commands.filter(
    (c) => !c.includes('_migrations') && !c.startsWith('CREATE DATABASE') && !c.startsWith('POLL'),
  );

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
      '0001_a.sql statement 2: a DROP is allowed only as DROP VIEW IF EXISTS of a materialised view created earlier, once another MV writes to its TO table',
      'models/100_v.sql statement 1: a model must be CREATE OR REPLACE VIEW',
    ]);
  });

  // #689: replacing a materialised view and removing the rows a buggy one let through — narrow, both ways
  const base = mig(
    '0001_t.sql',
    [
      'CREATE TABLE IF NOT EXISTS r (store_id UUID) ENGINE = ReplacingMergeTree ORDER BY store_id;',
      'CREATE TABLE IF NOT EXISTS m (store_id UUID) ENGINE = MergeTree ORDER BY store_id;',
      // the source table, ReplacingMergeTree like raw_events, and no MV's TO table: a DELETE never touches it
      'CREATE TABLE IF NOT EXISTS raw_events (store_id Nullable(UUID)) ENGINE = ReplacingMergeTree ORDER BY tuple();',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS mv_old TO r AS SELECT store_id FROM raw_events;',
    ].join('\n'),
  );
  const ZERO = "toUUID('00000000-0000-0000-0000-000000000000')";
  const REPLACEMENT =
    'CREATE MATERIALIZED VIEW IF NOT EXISTS mv_new TO r AS SELECT store_id FROM raw_events;';
  // a plain view (a model) is no materialised view: a migration may not drop it
  const plain = model('100_plain.sql', 'CREATE OR REPLACE VIEW plain AS SELECT 1;');
  const lintOne = (sql: string) => lintSqlFiles([base, mig('0002_x.sql', sql), plain]);

  it.each([
    [
      'DROP VIEW IF EXISTS of an earlier MV, once its replacement writes to the same TO table',
      `${REPLACEMENT}\nDROP VIEW IF EXISTS mv_old;`,
    ],
    [
      'the replacement in an earlier file than the drop',
      // lintOne puts the SQL in 0002; the replacement goes in 0001b, between base and it
      null,
    ],
    [
      "DELETE of the zero-uuid store rows from an MV's ReplacingMergeTree TO table",
      `DELETE FROM r WHERE store_id = ${ZERO};`,
    ],
    [
      'the same, spaced',
      "DELETE FROM r WHERE store_id  =  toUUID(  '00000000-0000-0000-0000-000000000000'  );",
    ],
  ])('allows %s', (_, sql) => {
    const problems =
      sql === null
        ? lintSqlFiles([
            base,
            mig('0001b_new.sql', REPLACEMENT),
            mig('0002_x.sql', 'DROP VIEW IF EXISTS mv_old;'),
            plain,
          ])
        : lintOne(sql);
    expect(problems).toEqual([]);
  });

  it.each([
    ['DROP VIEW without IF EXISTS', `${REPLACEMENT}\nDROP VIEW mv_old;`, 'DROP'],
    ['DROP of an MV with no replacement on its TO table', 'DROP VIEW IF EXISTS mv_old;', 'DROP'],
    [
      'DROP before its replacement is created',
      `DROP VIEW IF EXISTS mv_old;\n${REPLACEMENT}`,
      'DROP',
    ],
    [
      'DROP of an MV created only LATER',
      'DROP VIEW IF EXISTS mv_later;\nCREATE MATERIALIZED VIEW IF NOT EXISTS mv_later TO r AS SELECT store_id FROM raw_events;',
      'DROP',
    ],
    ['DROP VIEW of a plain model view', 'DROP VIEW IF EXISTS plain;', 'DROP'],
    ['DROP VIEW of an unknown name', 'DROP VIEW IF EXISTS nope;', 'DROP'],
    ['DROP TABLE', 'DROP TABLE IF EXISTS r;', 'DROP'],
    ['DELETE from a plain MergeTree table', `DELETE FROM m WHERE store_id = ${ZERO};`, 'DELETE'],
    [
      "DELETE from raw_events (ReplacingMergeTree, but no MV's TO table: the truth)",
      `DELETE FROM raw_events WHERE store_id = ${ZERO};`,
      'DELETE',
    ],
    [
      'DELETE with touuid (the server rejects it)',
      "DELETE FROM r WHERE store_id = touuid('00000000-0000-0000-0000-000000000000');",
      'DELETE',
    ],
    [
      'DELETE of other rows',
      "DELETE FROM r WHERE store_id = toUUID('00000000-0000-4000-8000-000000000031');",
      'DELETE',
    ],
    ['DELETE with a wider predicate', `DELETE FROM r WHERE store_id = ${ZERO} OR 1 = 1;`, 'DELETE'],
    ['DELETE without WHERE', 'DELETE FROM r;', 'DELETE'],
    ['ALTER TABLE … DELETE', `ALTER TABLE r DELETE WHERE store_id = ${ZERO};`, 'not idempotent'],
  ])('refuses %s', (_, sql, kind) => {
    const problems = lintOne(sql);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      kind === 'not idempotent' ? 'not idempotent' : `a ${kind} is allowed only`,
    );
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

// #685: a backfill waits for every INSERT running at that moment (an insert that began before the MV and committed
// after the backfill's read was lost from the MV's table for good — proven on ClickHouse, see models.test).
describe('the drain before a backfill', () => {
  const RMT = 'ENGINE = ReplacingMergeTree ORDER BY x';
  const withBackfill = [
    mig('0001_t.sql', `CREATE TABLE IF NOT EXISTS t (x UInt8) ${RMT};`),
    mig(
      '0002_mv.sql',
      'CREATE MATERIALIZED VIEW IF NOT EXISTS mv TO t AS SELECT x FROM src;\nINSERT INTO t SELECT x FROM src;',
    ),
  ];
  const fast = { drainPollMs: 1 };

  it('waits until the inserts running before the backfill have finished, then backfills', async () => {
    const s = fakeServer();
    s.running.push(['ingest-1', 'ingest-2'], ['ingest-2'], []);
    await migrate(s.client(), s.client(), 'analytics_test', withBackfill, fast);
    const at = (c: string) => s.commands.indexOf(c);
    expect(s.commands.filter((c) => c.startsWith('POLL'))).toEqual([
      'POLL ingest-1,ingest-2',
      'POLL ingest-2',
      'POLL ',
    ]);
    expect(at('POLL ')).toBeLessThan(at('INSERT INTO t SELECT x FROM src'));
    expect(at('CREATE MATERIALIZED VIEW IF NOT EXISTS mv TO t AS SELECT x FROM src')).toBeLessThan(
      at('POLL ingest-1,ingest-2'),
    );
  });

  it('does not wait for an insert that starts later (a busy ingest cannot starve the backfill)', async () => {
    const s = fakeServer();
    s.running.push(['before'], ['later-1'], ['later-1', 'later-2']);
    await migrate(s.client(), s.client(), 'analytics_test', withBackfill, fast);
    expect(s.commands.filter((c) => c.startsWith('POLL'))).toEqual(['POLL before', 'POLL later-1']);
    expect(userStatements(s.commands).at(-1)).toBe('INSERT INTO t SELECT x FROM src');
  });

  it('past the timeout it refuses to backfill, records nothing and releases the lock', async () => {
    const s = fakeServer();
    s.running.push(['stuck']);
    const err = await migrate(s.client(), s.client(), 'analytics_test', withBackfill, {
      drainPollMs: 1,
      drainTimeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsertsStillRunningError);
    expect(err).toMatchObject({ database: 'analytics_test', queryIds: ['stuck@ch-1'] });
    expect(userStatements(s.commands)).not.toContain('INSERT INTO t SELECT x FROM src');
    expect(s.locks).toEqual([]);
  });

  // #687 review: system.processes is per server — a multi-replica service must be read on every replica
  it('reads every replica (clusterAllReplicas) when the server has a default cluster', async () => {
    const s = fakeServer();
    s.running.push(['ingest-1'], []);
    await migrate(s.client(), s.client(), 'analytics_test', withBackfill, fast);
    expect(s.topology.sources).toEqual(['cluster', 'cluster']);
  });

  it('on a single server with no default cluster it falls back to the local table, once, and still drains', async () => {
    const s = fakeServer();
    s.topology.clusterless = true;
    s.running.push(['ingest-1'], []);
    await migrate(s.client(), s.client(), 'analytics_test', withBackfill, fast);
    expect(s.topology.sources).toEqual(['cluster', 'local', 'local']);
    expect(s.commands.filter((c) => c.startsWith('POLL'))).toEqual(['POLL ingest-1', 'POLL ']);
  });

  it('any other error reading the processes is not swallowed: nothing is backfilled', async () => {
    const s = fakeServer();
    const c = s.client();
    const base = c.query.bind(c);
    c.query = async (p) => {
      if (p.query.includes('system.processes')) throw new Error('ACCESS_DENIED');
      return base(p);
    };
    await expect(migrate(s.client(), c, 'analytics_test', withBackfill, fast)).rejects.toThrow(
      'ACCESS_DENIED',
    );
    expect(userStatements(s.commands)).not.toContain('INSERT INTO t SELECT x FROM src');
    expect(s.locks).toEqual([]);
  });

  // #689: an insert begun before a superseded MV was dropped still writes through it — the DELETE waits for it
  it('drains before a DELETE as well, not before a DROP', async () => {
    const s = fakeServer();
    s.running.push(['ingest-1'], []);
    const replace = [
      withBackfill[0]!,
      mig(
        '0002_v2.sql',
        [
          'CREATE MATERIALIZED VIEW IF NOT EXISTS mv_old TO t AS SELECT x FROM src;',
          'CREATE MATERIALIZED VIEW IF NOT EXISTS mv_new TO t AS SELECT x FROM src;',
          'DROP VIEW IF EXISTS mv_old;',
          "DELETE FROM t WHERE store_id = toUUID('00000000-0000-0000-0000-000000000000');",
        ].join('\n'),
      ),
    ];
    await migrate(s.client(), s.client(), 'analytics_test', replace, fast);
    const at = (c: string) => s.commands.findIndex((x) => x.startsWith(c));
    expect(s.commands.filter((c) => c.startsWith('POLL'))).toEqual(['POLL ingest-1', 'POLL ']);
    expect(at('DROP VIEW IF EXISTS mv_old')).toBeLessThan(at('POLL ingest-1'));
    expect(at('POLL ')).toBeLessThan(at('DELETE FROM t'));
  });

  it('a file without a backfill never polls', async () => {
    const s = fakeServer();
    s.running.push(['ingest-1']);
    await migrate(s.client(), s.client(), 'analytics_test', [withBackfill[0]!], fast);
    expect(s.commands.filter((c) => c.startsWith('POLL'))).toEqual([]);
  });
});
