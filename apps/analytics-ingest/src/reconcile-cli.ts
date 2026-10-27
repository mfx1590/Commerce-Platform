// `pnpm --filter @platform/analytics-ingest reconcile --from 2026-10-01 --to 2026-11-01 [--store <uuid>] [--json]`
// Reads ClickHouse (CLICKHOUSE_*), the core's HQ reports (CORE_URL + CORE_TOKEN: analyst and finance, e.g. owner)
// and the Finance API (ACCOUNTING_URL + ACCOUNTING_TOKEN: finance). Exit 0 only when every identity is 0; 1 on any
// difference; 2 on a usage or read error. Tokens are never printed.
import { createChClient } from './clickhouse.js';
import { ConfigError, loadConfig } from './config.js';
import { createAdminReportsClient, createFinanceClient } from './reconcile/clients.js';
import { reconcile, renderReport } from './reconcile/run.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new ConfigError(`${name} is required`);
  return v;
}

let code = 2;
const ch = createChClient(loadConfig(process.env, []).clickhouse);
try {
  const from = arg('--from');
  const to = arg('--to');
  if (!from || !to)
    throw new ConfigError(
      'usage: reconcile --from YYYY-MM-DD --to YYYY-MM-DD [--store <uuid>] [--json]',
    );
  const result = await reconcile({
    ch,
    finance: createFinanceClient({
      baseUrl: need('ACCOUNTING_URL'),
      token: need('ACCOUNTING_TOKEN'),
    }),
    admin: createAdminReportsClient({ baseUrl: need('CORE_URL'), token: need('CORE_TOKEN') }),
    window: { from, to, storeId: arg('--store') },
  });
  console.info(process.argv.includes('--json') ? JSON.stringify(result) : renderReport(result));
  code = result.ok ? 0 : 1;
} catch (err) {
  console.error(
    JSON.stringify({
      service: 'analytics-ingest',
      event: 'reconcile_failed',
      error_class: (err as Error).name,
      message: (err as Error).message,
    }),
  );
} finally {
  await ch.close();
}
process.exitCode = code;
