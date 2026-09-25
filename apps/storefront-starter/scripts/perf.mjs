#!/usr/bin/env node
/**
 * `pnpm --filter @platform/storefront-starter perf` — the performance gate (task 2.3, issue #111).
 *
 * One command, one exit code, suitable for CI:
 *
 *   1. `next build` against the mock (a production build — `next dev` is unoptimised and its scores
 *      mean nothing);
 *   2. the bundle budget (`scripts/bundle-budget.mjs` against `bundle-budget.json`);
 *   3. `next start`, then Lighthouse CI against `lighthouserc.json` (performance, accessibility,
 *      SEO, LCP, CLS), median of three runs;
 *   4. the server is stopped whatever happened.
 *
 * Both gates always run, so one failure does not hide the other, and the exit code is non-zero if
 * either fails. Flags: `--skip-build` reuses an existing `.next`; `--bundle-only` skips Lighthouse.
 *
 * Needs the Prism mock (`pnpm mock`, or the `mock-store` container) on `MOCK_API_URL`. It checks
 * first and says so, rather than letting Lighthouse time out against pages that render an error.
 * Hosts are `127.0.0.1`, never `localhost`: on Windows `localhost` resolves to `::1` first, where
 * nothing listens.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const PORT = process.env.PERF_PORT ?? '3100';
const MOCK_API_URL = process.env.MOCK_API_URL ?? 'http://127.0.0.1:4010';
const APP_URL = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === 'win32';
const LHCI_VERSION = '0.14.0';

/**
 * Next's own CLI, resolved from this package rather than looked up on `PATH`: `next` is only on
 * `PATH` when the script runs through `pnpm`, so `node scripts/perf.mjs` used to fail to start the
 * server and report it as a Lighthouse failure — a gate that fails for the wrong reason is as
 * misleading as one that never fails.
 */
const NEXT_BIN = createRequire(join(root, 'package.json')).resolve('next/dist/bin/next');

/** The app's own environment for the measured build: always the mock, so runs are comparable. */
const appEnv = { ...process.env, MOCK_API_URL, PORT, SITE_URL: process.env.SITE_URL ?? APP_URL };
delete appEnv.STORE_API_URL;

/**
 * A shell only for bare commands (`npx`, `node`), which Windows finds as `.cmd` shims only through
 * one. An absolute path - Node itself - runs without a shell, because under one a path containing a
 * space (`C:/Program Files/nodejs`) is split into two words.
 */
function run(label, command, commandArgs, env = process.env) {
  console.log(`\n── ${label} ──`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: !isAbsolute(command),
  });
  return result.status ?? 1;
}

async function reachable(url, init) {
  try {
    const response = await fetch(url, { ...init, signal: globalThis.AbortSignal.timeout(3000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/** Stop `next start` and anything it spawned: the whole tree, never just the parent. */
function stop(child) {
  if (child.exitCode !== null) return;
  if (isWindows)
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-child.pid, 'SIGTERM');
}

async function main() {
  // Any HTTP answer means Prism is up; `/store` without a publishable key is a correct 401.
  if (!(await reachable(`${MOCK_API_URL}/store`))) {
    console.error(
      `perf: the Store API mock is not reachable at ${MOCK_API_URL}.\n` +
        'Start it with `pnpm mock` (or the mock-store container), or set MOCK_API_URL.',
    );
    process.exit(2);
  }

  if (!args.has('--skip-build')) {
    const built = run(
      'next build (production, against the mock)',
      process.execPath,
      [NEXT_BIN, 'build'],
      appEnv,
    );
    if (built !== 0) process.exit(built);
  }

  const bundle = run('bundle budget', 'node', ['scripts/bundle-budget.mjs']);
  if (args.has('--bundle-only')) process.exit(bundle);

  console.log(`\n── next start on ${APP_URL} ──`);
  const server = spawn(process.execPath, [NEXT_BIN, 'start', '--port', PORT], {
    cwd: root,
    env: appEnv,
    stdio: 'inherit',
    detached: !isWindows,
  });

  let lighthouse = 1;
  try {
    if (!(await waitFor(`${APP_URL}/health`, 90_000))) {
      console.error(`perf: the app did not answer ${APP_URL}/health within 90 s.`);
    } else {
      // An exact pin fetched with npx rather than a devDependency: @lhci/cli brings ~950 lockfile
      // lines of transitive dependencies, and a devDependency would put them in every install of
      // every window in the monorepo for the sake of one CI job.
      lighthouse = run('Lighthouse CI (median of 3, mobile)', 'npx', [
        '-y',
        `@lhci/cli@${LHCI_VERSION}`,
        'autorun',
        '--config=lighthouserc.json',
      ]);
    }
  } finally {
    stop(server);
  }

  console.log(
    `\nperf: bundle budget ${bundle === 0 ? 'PASS' : 'FAIL'}, ` +
      `Lighthouse ${lighthouse === 0 ? 'PASS' : 'FAIL'}`,
  );
  process.exit(bundle !== 0 || lighthouse !== 0 ? 1 : 0);
}

await main();
