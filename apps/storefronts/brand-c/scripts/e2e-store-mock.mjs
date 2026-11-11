#!/usr/bin/env node
/**
 * A Prism Store mock serving **brand C's** store, so brand C's e2e can run on a laptop (#783).
 *
 *   node scripts/e2e-store-mock.mjs                 # listens on 4018
 *   PORT=4020 node scripts/e2e-store-mock.mjs
 *   # then, in another shell:
 *   MOCK_API_URL=http://127.0.0.1:4018 pnpm --filter @platform/storefront-brand-c e2e csp
 *
 * **Why brand C needs this and A and B do not.** `pnpm mock` serves the Store API contract's own
 * example store, which is brand A's: `en-GB` and `de-DE`. Brand C serves `en-US` only, so every
 * page of it is a correct 404 against that mock, the e2e server never warms up, and the run dies in
 * warm-up with no useful message. That is the gap `CLAUDE.md` describes under "The locale gap".
 *
 * **Nothing here is new.** `scripts/perf.mjs` has done exactly this since #447: it overlays the
 * brand's own `perf/store.example.json` onto a temporary copy of the spec and points Prism at that.
 * This is the same two functions from the same module, exposed as a command so an e2e run can use
 * it too — the example is validated against the spec's `Store` schema first, so a malformed overlay
 * fails here rather than as a puzzling 404 later.
 *
 * It is still a mock: the catalogue is the contract's, only the **store** is brand C's. A run that
 * needs brand C's real products points `E2E_STORE_API_URL` at a core instead.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { overlayStoreExample, validateStoreExample } from './perf-store-example.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const contracts = resolve(appRoot, '..', '..', '..', 'packages', 'contracts');
const port = process.env.PORT ?? '4018';

const example = JSON.parse(readFileSync(join(appRoot, 'perf', 'store.example.json'), 'utf8'));
const specText = readFileSync(join(contracts, 'openapi', 'store-api.yaml'), 'utf8');
validateStoreExample(specText, example);

const specDir = mkdtempSync(join(tmpdir(), 'brand-c-store-'));
const spec = join(specDir, 'store-api.yaml');
writeFileSync(spec, overlayStoreExample(specText, example));

// The overlaid spec is this process's scratch copy, so it goes when the process does — including
// on Ctrl-C, which is how a mock is usually stopped (#800 review). `exit` runs for all three, and
// the signal handlers are what turn Ctrl-C into an exit at all.
let cleaned = false;
const cleanUp = () => {
  if (cleaned) return;
  cleaned = true;
  rmSync(specDir, { recursive: true, force: true });
};
process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.exit(0);
  });
}

const require = createRequire(join(contracts, 'package.json'));
const prism = require.resolve('@stoplight/prism-cli/dist/index.js');

console.log(`brand C's store (${example.code}, ${example.locales?.join(', ')}) on :${port}`);
const child = spawn(
  process.execPath,
  [prism, 'mock', spec, '--host', '127.0.0.1', '--port', port, '--errors'],
  { stdio: 'inherit' },
);
child.on('exit', (code) => {
  cleanUp();
  process.exit(code ?? 0);
});
