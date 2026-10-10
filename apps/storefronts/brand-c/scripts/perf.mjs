#!/usr/bin/env node
/**
 * `pnpm --filter @platform/storefront-starter perf` — the performance gate (task 2.3, issue #111).
 *
 * One command, one exit code, suitable for CI:
 *
 *   1. `next build` against the mock (a production build — `next dev` is unoptimised and its scores
 *      mean nothing);
 *   2. the bundle budget (`scripts/bundle-budget.mjs` against `bundle-budget.json`);
 *   3. `next start`, every URL in `lighthouserc.json` warmed (answering under a second twice in a
 *      row, as `e2e-server.mjs` does, #390 — run 1 used to pay the routes' first render), then
 *      Lighthouse CI against `lighthouserc.json` (performance, accessibility,
 *      SEO, LCP, CLS), three runs per URL. **Not a median:** LHCI's default aggregation is
 *      `optimistic`, so each assertion is checked against the *best* of the three — except SEO,
 *      which is set to `pessimistic` (the worst), because the defect it guards shows up on runs
 *      2 and 3 and never on run 1;
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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  overlayStoreExample,
  readStoreExample,
  validateStoreExample,
} from './perf-store-example.mjs';
import { warmUrls } from './warm-urls.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const PORT = process.env.PERF_PORT ?? '3100';
const MOCK_API_URL = process.env.MOCK_API_URL ?? 'http://127.0.0.1:4010';
const APP_URL = `http://127.0.0.1:${PORT}`;
/** Where the brand's own Store mock listens when the app ships `perf/store.example.json` (#447). */
const PERF_MOCK_PORT = process.env.PERF_MOCK_PORT ?? '4012';
const isWindows = process.platform === 'win32';
const LHCI_VERSION = '0.15.1';

/**
 * Next's own CLI, resolved from this package rather than looked up on `PATH`: `next` is only on
 * `PATH` when the script runs through `pnpm`, so `node scripts/perf.mjs` used to fail to start the
 * server and report it as a Lighthouse failure — a gate that fails for the wrong reason is as
 * misleading as one that never fails.
 */
const NEXT_BIN = createRequire(join(root, 'package.json')).resolve('next/dist/bin/next');

/**
 * The app's own environment for the measured run: always the mock, so runs are comparable, and
 * always **indexable**.
 *
 * `ROBOTS_ALLOW_INDEXING` matters more than it looks. Without it `/robots.txt` serves
 * `Disallow: /` — correct for staging, and it takes Lighthouse's SEO category from ~95 to 58,
 * because `is-crawlable` fails. The gate is meant to measure the configuration that goes to
 * production, and a gate that fails on its own defaults teaches people to ignore it.
 */
const appEnv = {
  ...process.env,
  MOCK_API_URL,
  PORT,
  SITE_URL: process.env.SITE_URL ?? APP_URL,
  ROBOTS_ALLOW_INDEXING: '1',
};
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

/**
 * The brand's own Store mock (#447), or `null` when the app ships no `perf/store.example.json`.
 *
 * Prism, started from a temporary copy of the Store API spec whose `GET /store` example is the
 * brand's (validated against the spec's `Store` schema first — see `perf-store-example.mjs`), so a
 * brand that sells another locale than brand A's can be warmed and measured at all. Without the
 * file nothing changes: the shared mock on `MOCK_API_URL` serves, as before.
 */
async function startBrandMock() {
  const example = readStoreExample(root);
  if (example === null) return null;

  const contracts = join(root, 'node_modules', '@platform', 'contracts');
  const specText = readFileSync(join(contracts, 'openapi', 'store-api.yaml'), 'utf8');
  validateStoreExample(specText, example);
  const spec = join(mkdtempSync(join(tmpdir(), 'perf-store-')), 'store-api.yaml');
  writeFileSync(spec, overlayStoreExample(specText, example));

  const prism = resolve(
    dirname(
      createRequire(join(contracts, 'package.json')).resolve('@stoplight/prism-cli/package.json'),
    ),
    'dist/index.js',
  );
  const url = `http://127.0.0.1:${PERF_MOCK_PORT}`;
  console.log(`\n── Store mock for ${example.code} (perf/store.example.json) on ${url} ──`);
  const child = spawn(
    process.execPath,
    [prism, 'mock', spec, '--host', '127.0.0.1', '--port', PERF_MOCK_PORT, '--errors'],
    { cwd: root, stdio: 'inherit', detached: !isWindows },
  );
  if (!(await waitFor(`${url}/store`, 60_000))) {
    stop(child);
    throw new Error(`perf: the brand's Store mock did not answer ${url}/store within 60 s.`);
  }
  return { url, child };
}

/** The URLs Lighthouse will measure, straight from its own config. */
function measuredUrls() {
  const config = JSON.parse(readFileSync(join(root, 'lighthouserc.json'), 'utf8'));
  return config.ci?.collect?.url ?? [];
}

/** Warm every measured URL; false if one never answered quickly (#390). */
async function warmMeasuredUrls() {
  console.log('\n── warming the measured URLs ──');
  const results = await warmUrls(measuredUrls());
  for (const result of results.filter((r) => !r.warm)) {
    console.error(`perf: ${result.url} was not warm after ${result.attempts} requests.`);
  }
  return results.every((r) => r.warm);
}

async function main() {
  const brandMock = await startBrandMock();
  const mockUrl = brandMock?.url ?? MOCK_API_URL;
  appEnv.MOCK_API_URL = mockUrl;
  /** Every way out stops the brand's mock first: `process.exit` skips `finally` blocks. */
  const exit = (code) => {
    if (brandMock !== null) stop(brandMock.child);
    process.exit(code);
  };

  // Any HTTP answer means Prism is up; `/store` without a publishable key is a correct 401.
  if (!(await reachable(`${mockUrl}/store`))) {
    console.error(
      `perf: the Store API mock is not reachable at ${mockUrl}.\n` +
        'Start it with `pnpm mock` (or the mock-store container), or set MOCK_API_URL.',
    );
    exit(2);
  }

  if (!args.has('--skip-build')) {
    const built = run(
      'next build (production, against the mock)',
      process.execPath,
      [NEXT_BIN, 'build'],
      appEnv,
    );
    if (built !== 0) exit(built);
  }

  const bundle = run('bundle budget', 'node', ['scripts/bundle-budget.mjs']);
  if (args.has('--bundle-only')) exit(bundle);

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
    } else if (!(await warmMeasuredUrls())) {
      console.error('perf: a measured URL never answered quickly; not measuring a cold server.');
    } else {
      // An exact pin fetched with npx rather than a devDependency: @lhci/cli brings ~950 lockfile
      // lines of transitive dependencies, and a devDependency would put them in every install of
      // every window in the monorepo for the sake of one CI job.
      lighthouse = run('Lighthouse CI (3 runs per URL, mobile)', 'npx', [
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
  exit(bundle !== 0 || lighthouse !== 0 ? 1 : 0);
}

await main();
