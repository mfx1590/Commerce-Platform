#!/usr/bin/env node
// Starts the Sanity Studio with the project id from the root .env. Sanity's CLI only exposes
// `SANITY_STUDIO_*` variables to the config, so this maps SANITY_PROJECT_ID onto that name; the
// Studio itself needs no token (editors sign in through sanity.io).
import { spawn } from 'node:child_process';
import { loadRootEnv, ROOT } from './env.mjs';

loadRootEnv();

const projectId = process.env.SANITY_PROJECT_ID;
if (!projectId) {
  console.error(
    'SANITY_PROJECT_ID is not set in .env — create the project at sanity.io/manage, copy its id into .env (see cms/README.md), then retry.',
  );
  process.exit(1);
}

const child = spawn('sanity', ['dev', ...process.argv.slice(2)], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    SANITY_STUDIO_PROJECT_ID: projectId,
    SANITY_STUDIO_ROOT: ROOT,
    // Optional extra workspaces for brands onboarded from the admin UI (#521); validated in
    // sanity.config.ts, so a bad entry fails here with the entry named rather than silently.
    ...(process.env.SANITY_DATASETS ? { SANITY_STUDIO_DATASETS: process.env.SANITY_DATASETS } : {}),
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
