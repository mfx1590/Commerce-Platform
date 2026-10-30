// `pnpm --filter @platform/analytics-ingest ch:migrate`: applies data/clickhouse SQL to CLICKHOUSE_DATABASE — the
// migrations, the models, then the access files (users, profiles, quotas, grants; #648). It runs as the admin
// (CLICKHOUSE_USER): the only process that may create users. The ingest itself runs as analytics_ingest.
import { applyAccess, readAccessFiles } from './access.js';
import { createChClient } from './clickhouse.js';
import { migrate, readSqlFiles } from './migrations.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const admin = createChClient(config.clickhouse, 'default');
const db = createChClient(config.clickhouse);
try {
  const r = await migrate(admin, db, config.clickhouse.database, readSqlFiles());
  console.info(JSON.stringify({ service: 'analytics-ingest', event: 'migrated', ...r }));
  const access = await applyAccess(admin, readAccessFiles(), {
    database: config.clickhouse.database,
    // in production every user's password must come from the secrets manager: a missing one fails the deploy
    strict: process.env.NODE_ENV === 'production',
  });
  // names and reasons only: never a password or a hash
  console.info(JSON.stringify({ service: 'analytics-ingest', event: 'access', ...access }));
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
