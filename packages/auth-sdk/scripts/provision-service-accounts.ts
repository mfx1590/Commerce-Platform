#!/usr/bin/env tsx
// `pnpm --filter @platform/auth-sdk provision:service-accounts -- --crm-sync-stores <code,…> [--dry-run]` (#632)
// Production provisioning of the crm-sync / analytics-sync service accounts: their staff_user rows (fixed ids,
// subjects `seed-<clientId>`) and role assignments (crm-sync `support` on each named store, analytics-sync
// `analyst` + `finance` on the organization) through assignRole — tuple + role_assignment mirror + audit. Runs as
// the system actor; idempotent; never removes anything (extra assignments are reported). Prints ids, codes and
// relations only. Env: DATABASE_URL_APP (platform_app), OPENFGA_API_URL, OPENFGA_STORE_ID, OPENFGA_MODEL_ID,
// ORGANIZATION_ID (default SEED_IDS.organization). The Keycloak clients themselves come with the production realm
// import (infra/keycloak/README.md, "Production"); their secrets live in Vault, never here.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrganizationClient, createPool, SEED_IDS } from '@platform/db';
import { createOpenFgaClient, isApiError, provisionServiceAccounts } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

const usage = (why: string): never => {
  console.error(
    `provision:service-accounts: ${why}\nusage: provision:service-accounts --crm-sync-stores <code,…> [--dry-run]`,
  );
  process.exit(1);
};

const args = process.argv.slice(2).filter((a) => a !== '--');
let dryRun = false;
let codes: string[] | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--dry-run') dryRun = true;
  else if (a === '--crm-sync-stores') codes = (args[++i] ?? '').split(',');
  else if (a.startsWith('--crm-sync-stores='))
    codes = a.slice('--crm-sync-stores='.length).split(',');
  else usage(`unknown argument ${a}`);
}
if (!codes || codes.every((c) => !c.trim())) usage('--crm-sync-stores is required');
if (!process.env.OPENFGA_STORE_ID) {
  usage('OPENFGA_STORE_ID is not set — the tuples would go nowhere');
}

const pool = createPool(process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL);
const db = createOrganizationClient(pool, {
  organizationId: process.env.ORGANIZATION_ID ?? SEED_IDS.organization,
  actorId: null,
});
try {
  const report = await provisionServiceAccounts(
    { db, fga: createOpenFgaClient() },
    { crmSyncStoreCodes: codes!, dryRun },
  );
  const verb = dryRun ? 'would create' : 'created';
  for (const u of report.users) {
    console.info(
      `staff_user ${u.clientId} ${u.staffUserId}: ${u.status === 'created' ? verb : 'present'}`,
    );
  }
  for (const a of report.assignments) {
    console.info(
      `role ${a.clientId} ${a.relation} ${a.object}: ${a.status === 'created' ? verb : 'present'}`,
    );
  }
  for (const e of report.extra) {
    console.warn(
      `EXTRA (not removed — revoke by hand if unintended): ${e.clientId} ${e.relation} ${e.object}`,
    );
  }
  console.info(`provision:service-accounts: done${dryRun ? ' (dry run, nothing written)' : ''}`);
} catch (err) {
  console.error(
    `provision:service-accounts: ${isApiError(err) ? `${err.status} ${err.message}` : (err as Error).message}`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
