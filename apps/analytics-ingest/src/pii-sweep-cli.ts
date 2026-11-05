// `pnpm --filter @platform/analytics-ingest pii:sweep [--json]`: the live PII sweep (pii-sweep.ts) over the
// configured ClickHouse database (CLICKHOUSE_*). Read-only: as `CLICKHOUSE_READONLY_USER` (analytics_ro, readonly = 1)
// when that is set, so the server itself refuses any write; as `CLICKHOUSE_USER` otherwise. Prints what was read and the findings as counts, never a
// value. Exit 0 when nothing is found, 1 on any finding, 2 on a read or configuration error.
import { createChClient, createChReader } from './clickhouse.js';
import { loadConfig } from './config.js';
import { sweepPii } from './pii-sweep.js';

let code = 2;
const cfg = loadConfig(process.env, []).clickhouse;
const roUser = process.env.CLICKHOUSE_READONLY_USER?.trim();
const ch = roUser
  ? createChReader({
      url: cfg.url,
      database: cfg.database,
      username: roUser,
      password: process.env.CLICKHOUSE_READONLY_PASSWORD ?? '',
    })
  : createChClient(cfg);
try {
  const r = await sweepPii(ch);
  if (process.argv.includes('--json')) console.info(JSON.stringify(r));
  else {
    console.info(
      `pii:sweep ${r.database} as ${roUser ?? cfg.username}: ${r.scanned.length} tables and views, ${r.scanned.reduce((n, t) => n + t.columns.length, 0)} string columns read`,
    );
    for (const t of r.scanned)
      console.info(`  ${t.table} (${t.engine}): ${t.columns.join(', ') || '-'}`);
    console.info(
      r.findings.length === 0
        ? 'findings: none'
        : `findings:\n${r.findings.map((f) => `  ${f.table}.${f.column}: ${f.kind} × ${f.count}`).join('\n')}`,
    );
  }
  code = r.findings.length === 0 ? 0 : 1;
} catch (err) {
  console.error(
    JSON.stringify({
      service: 'analytics-ingest',
      event: 'pii_sweep_failed',
      error_class: (err as Error).name,
      message: (err as Error).message,
    }),
  );
} finally {
  await ch.close();
}
process.exitCode = code;
