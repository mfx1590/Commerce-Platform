// Measurement probe (BI v2, #871 f): peak memory of the heavy views on the generated month, in a throwaway database.
// Not a test and not shipped (src/testing is excluded from the build). Run: tsx src/testing/probe-memory.ts
import { createValidator } from '@platform/events';
import { generateMonth } from '@platform/test-utils';
import { createChClient, createRawEventsSink } from '../clickhouse.js';
import { loadConfig } from '../config.js';
import { migrate, readSqlFiles } from '../migrations.js';
import { classify } from '../rows.js';
import { toWire } from './fakes.js';

const cfg = loadConfig(process.env, []).clickhouse;
const db = `analytics_test_probe${Math.random().toString(36).slice(2, 6)}`;
const admin = createChClient(cfg, 'default');
const ch = createChClient(cfg, db);
try {
  await migrate(admin, ch, db, readSqlFiles());
  const month = generateMonth({
    orders: 300,
    legalEntities: 3,
    deterministicIds: true,
    seed: 6030,
  });
  const validator = createValidator();
  const rows = month.events.map((e, i) => {
    const c = classify(
      toWire(e as never, i),
      { topic: e.topic, partition: 0 },
      { groupId: 'g', validator, now: new Date() },
    );
    if (c.kind !== 'row') throw new Error('dead');
    return c.row;
  });
  await createRawEventsSink(ch).insert(rows);
  await ch.command({
    query:
      "CREATE VIEW probe_line_hash AS SELECT * FROM fct_order_line SETTINGS join_algorithm = 'hash'",
  });
  const cases: [string, string, Record<string, unknown>][] = [
    ['fct_order', 'SELECT count() FROM fct_order', {}],
    ['fct_order_line', 'SELECT count() FROM fct_order_line', {}],
    ['fct_order_line 1 thread', 'SELECT count() FROM fct_order_line', { max_threads: 1 }],
    ['fct_order_line hash join', 'SELECT count() FROM fct_order_line', { join_algorithm: 'hash' }],
    ['view with SETTINGS', 'SELECT count() FROM probe_line_hash', {}],
    ['stg_order_placed', 'SELECT count() FROM stg_order_placed', {}],
    ['fct_return_line', 'SELECT count() FROM fct_return_line', {}],
    ['mart_sales_daily', 'SELECT count() FROM mart_sales_daily', {}],
  ];
  const ids: [string, string][] = [];
  for (const [name, query, settings] of cases) {
    const id = `probe-${Math.random().toString(36).slice(2)}`;
    await (
      await ch.query({
        query,
        format: 'JSONEachRow',
        clickhouse_settings: settings as never,
        query_id: id,
      } as never)
    ).json();
    ids.push([name, id]);
  }
  await admin.command({ query: 'SYSTEM FLUSH LOGS' });
  for (const [name, id] of ids) {
    const [r] = await (
      await admin.query({
        query: `SELECT formatReadableSize(memory_usage) AS mem, query_duration_ms AS ms, read_rows FROM system.query_log WHERE query_id = {id:String} AND type = 'QueryFinish'`,
        format: 'JSONEachRow',
        query_params: { id },
      })
    ).json<Record<string, string>>();
    console.info(JSON.stringify({ view: name, ...r }));
  }
} finally {
  await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => {});
  await Promise.allSettled([admin.close(), ch.close()]);
}
