#!/usr/bin/env node
// `pnpm dev`: boots the whole local stack (docker compose), migrates, seeds, prints the service table.
// `pnpm dev --down` stops it. `pnpm dev --reset` also wipes volumes.
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '-f', resolve(root, 'infra/docker/docker-compose.yml')];
const args = new Set(process.argv.slice(2));

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: root,
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`\n${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  return r.status;
}

if (args.has('--down') || args.has('--reset')) {
  run('docker', [...compose, 'down', ...(args.has('--reset') ? ['-v'] : [])]);
  process.exit(0);
}

if (!existsSync(resolve(root, '.env'))) {
  copyFileSync(resolve(root, '.env.example'), resolve(root, '.env'));
  console.info('dev: created .env from .env.example');
}
// Load .env into this process (child pnpm commands inherit it). Existing env vars win.
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}

console.info(
  'dev: starting docker compose (postgres, redis, redpanda, keycloak, openfga, mock-store, mock-admin)…',
);
run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180']);

console.info('dev: migrating…');
run('pnpm', ['db:migrate']);
console.info('dev: seeding (idempotent)…');
run('pnpm', ['db:seed']);

console.info(`
  service           url / connection
  ----------------- ------------------------------------------------------------
  Postgres          postgres://platform:platform@localhost:5433/platform  (app role: platform_app)
  Redis             redis://localhost:6381
  Redpanda          localhost:19092 (Kafka)  http://localhost:18081 (schema registry)
  Keycloak          http://localhost:8180  (admin / admin; realms: staff, customers)
  OpenFGA           http://localhost:8081  (playground http://localhost:3001)
  Store API mock    http://localhost:4010  (X-Publishable-Key: pk_brand-a_dev)
  Admin API mock    http://localhost:4011  (Authorization: Bearer dev)

  Seeded: 3 stores (brand-a EUR, brand-b GBP, brand-c USD) × 200 products, 2 warehouses, 7 staff users.
  Stop: pnpm dev --down   Wipe: pnpm dev --reset
`);
