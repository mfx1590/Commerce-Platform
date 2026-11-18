// Measurement probe (BI v2, #924 review item 2): can `analytics_ro` (readonly = 1, its real profile from
// data/clickhouse/access/20_analytics_ro.sql) read the model views that carry `SETTINGS join_algorithm = 'hash'`?
// Everything it creates is throwaway and dropped at the end: one analytics_test_* database, and the access file applied
// under a renamed user (`ro_probe_*`, its profile and quota). No shared database or user is touched.
// Run: tsx src/testing/probe-readonly.ts
import { createValidator } from '@platform/events';
import { generateMonth } from '@platform/test-utils';
import { applyAccess, readAccessFiles } from '../access.js';
import { createChClient, createChReader, createRawEventsSink } from '../clickhouse.js';
import { loadConfig } from '../config.js';
import { migrate, readSqlFiles } from '../migrations.js';
import { classify } from '../rows.js';
import { toWire } from './fakes.js';

const cfg = loadConfig(process.env, []).clickhouse;
const tag = Math.random().toString(36).slice(2, 7);
const db = `analytics_test_ro${tag}`;
const user = `ro_probe_${tag}`;
const password = `probe-word-${tag}-not-a-secret`;
const admin = createChClient(cfg, 'default');
const ch = createChClient(cfg, db);
try {
  await migrate(admin, ch, db, readSqlFiles());
  const month = generateMonth({ orders: 60, legalEntities: 2, deterministicIds: true, seed: 924 });
  const validator = createValidator();
  await createRawEventsSink(ch).insert(
    month.events.map((e, i) => {
      const c = classify(toWire(e as never, i), { topic: e.topic, partition: 0 }, { groupId: 'g', validator, now: new Date() });
      if (c.kind !== 'row') throw new Error('dead');
      return c.row;
    }),
  );
  const ro = readAccessFiles().filter((f) => f.user === 'analytics_ro');
  await applyAccess(admin, ro, {
    database: db,
    rename: { analytics_ro: user },
    env: { [ro[0]!.passwordEnv]: password },
    strict: true,
  });
  const reader = createChReader({ url: cfg.url, database: db, username: user, password });
  const profile = await (
    await reader.query({
      query: "SELECT name, value FROM system.settings WHERE name IN ('readonly', 'join_algorithm')",
      format: 'JSONEachRow',
    })
  ).json<{ name: string; value: string }>();
  console.info(JSON.stringify({ probe: 'profile as the reader', settings: profile }));
  const views = (
    await (
      await admin.query({
        query: `SELECT name FROM system.tables WHERE database = {db:String} AND engine = 'View' AND create_table_query LIKE '%join_algorithm%' ORDER BY name`,
        format: 'JSONEachRow',
        query_params: { db },
      })
    ).json<{ name: string }>()
  ).map((r) => r.name);
  for (const v of views) {
    try {
      const id = `ro-probe-${tag}-${v}`;
      const [r] = await (
        await reader.query({ query: `SELECT count() AS n FROM ${v}`, format: 'JSONEachRow', query_id: id } as never)
      ).json<{ n: string }>();
      await admin.command({ query: 'SYSTEM FLUSH LOGS' });
      const [m] = await (
        await admin.query({
          query: "SELECT formatReadableSize(memory_usage) AS mem FROM system.query_log WHERE query_id = {id:String} AND type = 'QueryFinish'",
          format: 'JSONEachRow',
          query_params: { id },
        })
      ).json<{ mem: string }>();
      console.info(JSON.stringify({ view: v, ok: true, rows: Number(r!.n), peak_memory: m?.mem }));
    } catch (e) {
      console.info(JSON.stringify({ view: v, ok: false, error: (e as Error).message.split('\n')[0]!.slice(0, 220) }));
    }
  }
  await reader.close();
} finally {
  for (const q of [
    `DROP USER IF EXISTS ${user}`,
    `DROP QUOTA IF EXISTS ${user}_quota`,
    `DROP SETTINGS PROFILE IF EXISTS ${user}_profile`,
    `DROP DATABASE IF EXISTS ${db}`,
  ])
    await admin.command({ query: q }).catch((e) => console.error(`cleanup: ${q}: ${(e as Error).message}`));
  await Promise.allSettled([admin.close(), ch.close()]);
}
