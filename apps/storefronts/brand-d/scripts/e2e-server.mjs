#!/usr/bin/env node
/**
 * The app server for the Playwright run: `next build`, then `next start` — **with a different
 * `SITE_URL` at build time than at run time** (#302) — and a readiness signal that means it.
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
 * **Readiness is "warm", not "listening" (#298 review).** Playwright used to wait on `/` and start
 * the workers the moment its response headers arrived — seconds after `next build` finished, while
 * the machine was still busy with the build's aftermath and the server had served nothing. On this
 * laptop that meant the first documents took 10 s and static chunks 10 s to first byte, and the
 * first tests of a run timed out before the server had warmed; CI, with no such start-up load,
 * passed the same code every time. Longer timeouts would have hidden that, not fixed it. Instead
 * this script answers Playwright's readiness URL only after a page **and** a static chunk have each
 * been served quickly twice in a row.
 *
 * A script rather than `SITE_URL=… next build && next start` in `playwright.config.ts`: that inline
 * syntax does not exist on Windows, where this repo is developed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eServerEnv } from './e2e-env.mjs';
import { warmUpPath, warmUpServer } from './e2e-warm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Resolved, not looked up on PATH — see scripts/perf.mjs for why.
const NEXT_BIN = createRequire(join(root, 'package.json')).resolve('next/dist/bin/next');

/**
 * Keep both in step with e2e/support/build-origin.ts, which reads them back. `.invalid` never
 * resolves.
 */
const BUILD_SITE_URL = process.env.E2E_BUILD_SITE_URL ?? 'https://build-time.invalid';
const BUILD_MARKER_FILE = 'e2e-build.json';

const port = process.env.PORT ?? '3100';
const appUrl = `http://127.0.0.1:${port}`;
/** Where Playwright asks "ready?" — keep in step with `READY_URL` in playwright.config.ts. */
const readyPort = process.env.E2E_READY_PORT ?? String(Number(port) + 1000);

// The backend is the run's, not the shell's: see scripts/e2e-env.mjs.
const serverEnv = e2eServerEnv(process.env);

async function alreadyServing() {
  try {
    const response = await fetch(`${appUrl}/health`, {
      signal: globalThis.AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** What Playwright polls. Nothing answers here until the app is warm. */
function serveReady() {
  const ready = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ready\n');
  });
  ready.listen(Number(readyPort), '127.0.0.1', () => {
    console.error(`[e2e-server] ready: ${appUrl} is warm (readiness on :${readyPort})`);
  });
  return ready;
}

async function main() {
  let server = null;

  if (await alreadyServing()) {
    // Somebody's server is on the port already (a developer's, usually). Playwright would have
    // reused it before this script existed; keep that, but still insist on warmth.
    console.error(`[e2e-server] reusing the server already on ${appUrl}; not building`);
  } else {
    // A clean data cache, every build (#327). `.next/cache/fetch-cache` outlives `next build`, so
    // a run could render stock cached by the previous run within CATALOG_REVALIDATE: on 2026-10-03
    // the PDP offered a product the core had just sold out, and add-to-cart refused it. The rest of
    // `.next/cache` (the compiler's) is kept; it holds no data.
    rmSync(join(root, '.next', 'cache', 'fetch-cache'), { recursive: true, force: true });
    const built = spawnSync(process.execPath, [NEXT_BIN, 'build'], {
      cwd: root,
      env: { ...serverEnv, SITE_URL: BUILD_SITE_URL },
      stdio: 'inherit',
    });
    if (built.status !== 0) process.exit(built.status ?? 1);

    // The marker the origin spec looks for: which build this is, and the origin it was made with.
    // It names the build id so that it cannot vouch for an ordinary `next build` run afterwards —
    // that leaves this file where it is and changes BUILD_ID.
    const nextDir = join(root, '.next');
    writeFileSync(
      join(nextDir, BUILD_MARKER_FILE),
      JSON.stringify({
        buildId: readFileSync(join(nextDir, 'BUILD_ID'), 'utf8').trim(),
        siteUrl: BUILD_SITE_URL,
      }),
    );

    server = spawn(process.execPath, [NEXT_BIN, 'start', '--port', port], {
      cwd: root,
      env: serverEnv,
      stdio: 'inherit',
    });
    server.on('exit', (code) => process.exit(code ?? 0));
  }

  const stop = () => {
    server?.kill();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);

  // The app's own default locale, a redirect is not warm (#441 part 4): scripts/e2e-warm.mjs.
  await warmUpServer({ appUrl, path: warmUpPath(serverEnv) });
  serveReady();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
