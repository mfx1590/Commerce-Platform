#!/usr/bin/env tsx
// `pnpm --filter @platform/auth-sdk fga:reconcile [--fix]` (issue #415, task 3.1a)
// Lists the stores in the database that have no `organization:<slug>#organization@store:<id>` tuple in
// OpenFGA — invisible to every HQ user's scope — and writes the missing tuples with --fix. Runs as the system
// actor against the local stack. Env: DATABASE_URL_APP (platform_app), OPENFGA_API_URL, OPENFGA_STORE_ID,
// OPENFGA_MODEL_ID (from fga:seed), ORGANIZATION_ID (default SEED_IDS.organization), ORGANIZATION_SLUG
// (default hq).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrganizationClient, createPool, SEED_IDS } from '@platform/db';
import { createOpenFgaClient, isApiError, reconcileStoreObjects } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const unknown = args.filter((a) => a !== '--fix');
if (unknown.length > 0) {
  console.error(`usage: fga:reconcile [--fix]  (unknown: ${unknown.join(' ')})`);
  process.exit(1);
}
if (!process.env.OPENFGA_STORE_ID) {
  console.error(
    'fga:reconcile: OPENFGA_STORE_ID is not set — run `pnpm --filter @platform/auth-sdk fga:seed` first',
  );
  process.exit(1);
}

const pool = createPool(process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL);
const db = createOrganizationClient(pool, {
  organizationId: process.env.ORGANIZATION_ID ?? SEED_IDS.organization,
  actorId: null,
});
try {
  const report = await reconcileStoreObjects(db, {
    fga: createOpenFgaClient(),
    organization: process.env.ORGANIZATION_SLUG ?? 'hq',
    fix,
  });
  console.info(
    `fga:reconcile: ${report.stores.length} store(s) in the database, ${report.organization}`,
  );
  if (report.missing.length === 0) {
    console.info('fga:reconcile: every store has its organization tuple — nothing to do');
  } else {
    console.info(
      `fga:reconcile: ${report.missing.length} store(s) WITHOUT the organization tuple:`,
    );
    for (const s of report.missing) console.info(`  ${s.code}  store:${s.id}`);
    if (fix) {
      console.info(`fga:reconcile: --fix wrote ${report.fixed.length} tuple(s)`);
      const after = await reconcileStoreObjects(db, {
        fga: createOpenFgaClient(),
        organization: process.env.ORGANIZATION_SLUG ?? 'hq',
      });
      console.info(
        after.missing.length === 0
          ? 'fga:reconcile: report after --fix: empty'
          : `fga:reconcile: report after --fix: ${after.missing.length} still missing`,
      );
      if (after.missing.length > 0) process.exitCode = 1;
    } else {
      console.info('fga:reconcile: run again with --fix to write them');
      process.exitCode = 2;
    }
  }
} catch (err) {
  console.error(
    `fga:reconcile: ${isApiError(err) ? `${err.status} ${err.message}` : (err as Error).message}`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
