#!/usr/bin/env node
/**
 * Samples Postgres once a second while a load run is on (#359), for ONE database:
 *
 *   node infra/load/pg-sampler.mjs <out.jsonl> [database]   # stops when <out.jsonl>.stop appears, or on SIGINT/SIGTERM
 *
 * The stop FILE is what run.sh uses: in Git Bash on Windows, `kill -INT` never reaches a native node process,
 * and a signal-only sampler made the laptop run hang after k6 had finished.
 *
 * Connects with PG_SAMPLER_URL (default: the compose stack's `platform` superuser on 127.0.0.1:5433,
 * database `postgres`) — a superuser sees every role's sessions in pg_stat_activity; the app's own role
 * would see only its own. Each line: time, connections by role (application_name) and state, how many
 * are waiting and on what (`Lock` waits are the store-row and cart-row locks), and the longest-running
 * active query. It reads; it never writes.
 */
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Client } = createRequire(join(root, 'packages', 'db', 'package.json'))('pg');

const out = process.argv[2];
const db = process.argv[3] || 'platform_boot_smoke';
const url = process.env.PG_SAMPLER_URL || 'postgres://platform:platform@127.0.0.1:5433/postgres';
if (!out) {
  console.error('usage: pg-sampler.mjs <out.jsonl> [database]');
  process.exit(2);
}

const SQL = `
  SELECT coalesce(nullif(application_name, ''), usename) AS app,
         usename AS role,
         coalesce(state, 'unknown') AS state,
         coalesce(wait_event_type, '') AS wait_type,
         coalesce(wait_event, '') AS wait_event,
         extract(epoch FROM (now() - query_start)) * 1000 AS query_ms
    FROM pg_stat_activity
   WHERE datname = $1 AND pid <> pg_backend_pid()`;

const client = new Client({ connectionString: url, application_name: 'load-sampler' });
await client.connect();
writeFileSync(out, '');
let stopping = false;
const stop = async () => {
  stopping = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const stopFile = `${out}.stop`;
rmSync(stopFile, { force: true });
while (!stopping && !existsSync(stopFile)) {
  const t = Date.now();
  try {
    const { rows } = await client.query(SQL, [db]);
    const byRole = {};
    const waits = {};
    let lockWaits = 0;
    let longestActiveMs = 0;
    for (const r of rows) {
      const key = `${r.role}`;
      byRole[key] ??= { total: 0, active: 0, idle: 0, idle_in_tx: 0, other: 0 };
      const b = byRole[key];
      b.total++;
      if (r.state === 'active') b.active++;
      else if (r.state === 'idle') b.idle++;
      else if (r.state.startsWith('idle in transaction')) b.idle_in_tx++;
      else b.other++;
      if (r.wait_type && r.state === 'active') {
        const k = `${r.wait_type}:${r.wait_event}`;
        waits[k] = (waits[k] ?? 0) + 1;
        if (r.wait_type === 'Lock') lockWaits++;
      }
      if (r.state === 'active' && r.query_ms > longestActiveMs)
        longestActiveMs = Math.round(r.query_ms);
    }
    appendFileSync(
      out,
      `${JSON.stringify({ t, total: rows.length, byRole, waits, lockWaits, longestActiveMs })}\n`,
    );
  } catch (error) {
    appendFileSync(out, `${JSON.stringify({ t, error: error.message })}\n`);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - t))));
}
await client.end();
rmSync(stopFile, { force: true });
