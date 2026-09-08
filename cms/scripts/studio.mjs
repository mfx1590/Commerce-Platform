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
  env: { ...process.env, SANITY_STUDIO_PROJECT_ID: projectId, SANITY_STUDIO_ROOT: ROOT },
});
child.on('exit', (code) => process.exit(code ?? 0));
