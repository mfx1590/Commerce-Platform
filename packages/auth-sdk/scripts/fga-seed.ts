#!/usr/bin/env tsx
// `pnpm --filter @platform/auth-sdk fga:seed`
// Creates/reuses the OpenFGA store, writes infra/openfga/model.fga and tuples.seed.json, and records
// OPENFGA_STORE_ID / OPENFGA_MODEL_ID in the repo-root .env (created from .env.example when missing).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedOpenFga } from '../src/index.js';

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

const result = await seedOpenFga({ log: (m) => console.info(`fga:seed: ${m}`) });

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
