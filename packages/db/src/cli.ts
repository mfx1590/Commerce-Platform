#!/usr/bin/env node
// `pnpm db:migrate` / `pnpm db:seed` — runs as the owner role (DATABASE_URL).
import { connectionStringFromEnv, createPool, loadDotenv } from './pool.js';
import { migrate } from './migrate.js';
import { seed, topUpStock } from './seed/index.js';

const cmd = process.argv[2];
loadDotenv();

async function main(): Promise<void> {
  const pool = createPool(connectionStringFromEnv('owner'), 2);
  try {
    if (cmd === 'migrate') {
      const r = await migrate(pool);
      console.info(`migrate: applied ${r.applied.length}, skipped ${r.skipped.length}`);
      for (const a of r.applied) console.info(`  + ${a}`);
    } else if (cmd === 'seed') {
      await seed(pool);
      console.info('seed: done');
    } else if (cmd === 'top-up-stock') {
      // Local development only: the host must be loopback, so this can never raise stock on a deployed database.
      const host = new URL(connectionStringFromEnv('owner')).hostname;
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
        throw new Error(`top-up-stock refuses a non-local database host (${host})`);
      }
      const floor = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
      await topUpStock(pool, floor === undefined ? {} : { floor });
    } else {
      console.error('usage: db <migrate|seed|top-up-stock [floor]>');
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
