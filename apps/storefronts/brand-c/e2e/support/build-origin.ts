import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether the server under test was built with a different origin than it runs with (#302).
 *
 * `e2e/runtime-origin.spec.ts` only proves something against a build made by
 * `scripts/e2e-server.mjs`, which builds with `BUILD_SITE_URL` and starts without it. Against a
 * server built the ordinary way — one a developer already had running, which Playwright reuses
 * locally — the build origin and the runtime origin are the same string, the spec cannot fail, and
 * a green result would mean nothing. So the script leaves a marker next to the build, and the spec
 * asks this module before it asserts anything.
 */

/** The origin the e2e build is made with. `.invalid` never resolves. */
export const BUILD_SITE_URL = process.env.E2E_BUILD_SITE_URL ?? 'https://build-time.invalid';

/**
 * The `SITE_URL` the e2e server is **started** with. `playwright.config.ts` passes exactly this to
 * the server, and the origin spec compares what is served against it — so "the build origin is
 * absent" is never the whole claim; "the runtime origin is present" is asserted too.
 *
 * The default is the app's own: `http://localhost:3100` is also the redirect URI the Keycloak
 * customers realm registers, so the account journeys depend on it.
 */
export const RUNTIME_SITE_URL = process.env.SITE_URL ?? 'http://localhost:3100';

/** Written by `scripts/e2e-server.mjs` into the build directory after a successful `next build`. */
export const BUILD_MARKER_FILE = 'e2e-build.json';

/**
 * `null` when the build in `nextDir` was made with `expectedOrigin`; otherwise the reason it cannot
 * be trusted, in words that can go straight into a skip message or an error.
 *
 * The marker carries the build id it was written for: an ordinary `next build` afterwards leaves
 * the marker file behind but changes `BUILD_ID`, and a stale marker must not vouch for a new build.
 */
export function vacuousReason(nextDir: string, expectedOrigin: string): string | null {
  const markerPath = join(nextDir, BUILD_MARKER_FILE);
  const buildIdPath = join(nextDir, 'BUILD_ID');

  if (!existsSync(buildIdPath)) {
    return `no build found in ${nextDir}: the server under test was not built from this checkout`;
  }
  if (!existsSync(markerPath)) {
    return 'the build was not made by scripts/e2e-server.mjs, so it was built and started with the same SITE_URL';
  }

  let marker: { buildId?: unknown; siteUrl?: unknown };
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8')) as typeof marker;
  } catch {
    return `${BUILD_MARKER_FILE} is unreadable`;
  }

  const buildId = readFileSync(buildIdPath, 'utf8').trim();
  if (marker.buildId !== buildId) {
    return 'the app was rebuilt the ordinary way after the last e2e build (the marker names another build id)';
  }
  if (marker.siteUrl !== expectedOrigin) {
    return `the e2e build was made with SITE_URL=${String(marker.siteUrl)}, not ${expectedOrigin}`;
  }
  return null;
}

export type OriginSpecMode = { run: true } | { run: false; fail: boolean; message: string };

/**
 * What the spec does about it. Locally a vacuous run is skipped **with the reason**, so it shows
 * up as skipped rather than as three green ticks; on CI, where the server is never reused, it is
 * a failure — there the only way to get here is a broken setup.
 */
export function originSpecMode(reason: string | null, ci: boolean): OriginSpecMode {
  if (reason === null) return { run: true };
  const message =
    `runtime-origin would pass vacuously: ${reason}. ` +
    'Stop the server on the e2e port and let Playwright start it (scripts/e2e-server.mjs).';
  return { run: false, fail: ci, message };
}
