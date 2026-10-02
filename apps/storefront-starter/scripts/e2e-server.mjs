#!/usr/bin/env node
/**
 * The app server for the Playwright run: `next build`, then `next start` — **with a different
 * `SITE_URL` at build time than at run time** (#302).
 *
 * The deployment model is one image promoted through every environment, so nothing that differs
 * per environment may be decided by `next build`. That rule has been broken three times (the CSP,
 * `robots.txt`, the sitemap's origin), each time by a route that was quietly prerendered, and each
 * time invisibly — because every test built and started the app with the same environment, where a
 * value captured at build time and a value read at run time are the same string.
 *
 * So the end-to-end server is always built somewhere it will not run: the build sees
 * `BUILD_SITE_URL`, the running server sees whatever the caller's environment says (by default the
 * app's own `http://localhost:<port>`). `e2e/runtime-origin.spec.ts` then asserts the build origin
 * is served nowhere. Any future route that bakes the origin in fails there, not in production.
 *
 * A script rather than `SITE_URL=… next build && next start` in `playwright.config.ts`: that inline
 * syntax does not exist on Windows, where this repo is developed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Resolved, not looked up on PATH — see scripts/perf.mjs for why.
const NEXT_BIN = createRequire(join(root, 'package.json')).resolve('next/dist/bin/next');

/** Keep in step with `BUILD_SITE_URL` in e2e/runtime-origin.spec.ts. `.invalid` never resolves. */
const BUILD_SITE_URL = process.env.E2E_BUILD_SITE_URL ?? 'https://build-time.invalid';

const built = spawnSync(process.execPath, [NEXT_BIN, 'build'], {
  cwd: root,
  env: { ...process.env, SITE_URL: BUILD_SITE_URL },
  stdio: 'inherit',
});
if (built.status !== 0) process.exit(built.status ?? 1);

const port = process.env.PORT ?? '3100';
const server = spawn(process.execPath, [NEXT_BIN, 'start', '--port', port], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
