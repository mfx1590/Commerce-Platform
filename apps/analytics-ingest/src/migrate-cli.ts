// `pnpm --filter @platform/analytics-ingest ch:migrate`: applies data/clickhouse SQL to CLICKHOUSE_DATABASE.
import { createChClient, migrate, readSqlFiles } from './clickhouse.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const admin = createChClient(config.clickhouse, 'default');
const db = createChClient(config.clickhouse);
try {
  const r = await migrate(admin, db, config.clickhouse.database, readSqlFiles());
  console.info(JSON.stringify({ service: 'analytics-ingest', event: 'migrated', ...r }));
} catch (err) {
  console.error(
    JSON.stringify({
      service: 'analytics-ingest',
      event: 'migrate_failed',
      error_class: (err as Error).name,
      message: (err as Error).message,
    }),
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled([admin.close(), db.close()]);
}
