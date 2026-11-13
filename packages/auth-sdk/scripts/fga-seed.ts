#!/usr/bin/env tsx
// `pnpm --filter @platform/auth-sdk fga:seed`
// Creates/reuses the OpenFGA store, writes infra/openfga/model.fga and tuples.seed.json, and records
// OPENFGA_STORE_ID / OPENFGA_MODEL_ID in the repo-root .env (created from .env.example when missing).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectionStringFromEnv,
  createOrganizationClient,
  createPool,
  SEED_IDS,
} from '@platform/db';
import { loadSeedTuples, seedOpenFga, withoutAbsentStores } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(root, '.env');
const envExample = resolve(root, '.env.example');

// Load .env so OPENFGA_API_URL is honoured; existing process env wins.
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

const log = (m: string) => console.info(`fga:seed: ${m}`);

/**
 * The store ids this database has, or null when it cannot be reached in 5 s (#832). With them, a seed tuple about a
 * store the database lacks is skipped (the seed skipped that store: brand-d is the wizard's on the shared dev stack).
 */
async function storeIdsInDatabase(): Promise<Set<string> | null> {
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    pool = createPool(connectionStringFromEnv('owner'), 1);
    const hq = createOrganizationClient(pool, { organizationId: SEED_IDS.organization });
    const rows = await Promise.race([
      hq.query<{ id: string }>('SELECT id FROM store'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
    ]);
    return new Set(rows.rows.map((r) => r.id));
  } catch {
    return null;
  } finally {
    await pool?.end().catch(() => {});
  }
}

const storeIds = await storeIdsInDatabase();
const tuples = storeIds
  ? withoutAbsentStores(loadSeedTuples(), storeIds, log)
  : (log('database not reachable: writing every seed tuple'), loadSeedTuples());
const result = await seedOpenFga({ tuples, log });

function upsertEnv(content: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : `${content.replace(/\n?$/, '\n')}${key}=${value}\n`;
}

if (!existsSync(envFile)) {
  copyFileSync(envExample, envFile);
  console.info('fga:seed: created .env from .env.example');
}
let env = readFileSync(envFile, 'utf8');
env = upsertEnv(env, 'OPENFGA_STORE_ID', result.storeId);
env = upsertEnv(env, 'OPENFGA_MODEL_ID', result.modelId);
writeFileSync(envFile, env);
console.info(
  `fga:seed: .env updated (OPENFGA_STORE_ID=${result.storeId}, OPENFGA_MODEL_ID=${result.modelId})`,
);
