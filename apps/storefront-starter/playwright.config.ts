import { defineConfig, devices } from '@playwright/test';
import { RUNTIME_SITE_URL } from './e2e/support/build-origin';

/**
 * End-to-end config for the storefront.
 *
 * Two servers are started for the run: the Prism mock (the Store API in Phase 1) and a production
 * build of the app. The build matters — `next dev` behaves differently enough around caching and
 * server actions that a green dev run would not tell us much.
 *
 * Browser choice (REQUEST #84): locally the Chrome already on the machine, so nothing is
 * downloaded; on CI Playwright's own chromium, which is version-matched to `@playwright/test` in the
 * lockfile and lighter to install. `infra/ci/run-e2e.sh` decides what to install by grepping this
 * file for a pinned `channel`, so the value must stay out of the literal source when CI runs.
 * `E2E_CHANNEL` overrides both ways.
 */
const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
/**
 * Where `scripts/e2e-server.mjs` says the app is ready — which it does only once a page and a static
 * chunk have each answered quickly twice in a row. Waiting on the app's own URL started the workers
 * on a cold server seconds after `next build`, and the first tests timed out on this laptop while
 * CI, with no start-up load, passed (#298 review). Keep in step with `readyPort` in the script.
 */
const READY_PORT = process.env.E2E_READY_PORT ?? String(Number(new URL(APP_URL).port) + 1000);
const READY_URL = `http://127.0.0.1:${READY_PORT}/`;
const MOCK_URL = process.env.MOCK_API_URL ?? 'http://localhost:4010';
/**
 * Against the real core (task 2.1): `E2E_STORE_API_URL=http://localhost:9000 pnpm e2e`.
 *
 * Prism still starts, because the core proxies `/store/customers*` to it
 * (`CORE_STORE_API_FALLBACK_URL`) for the account journeys; everything else the core answers
 * itself. Unset — the default — the app runs against Prism alone, so a laptop with no docker stack
 * still gets a full green run.
 */
const STORE_API_URL = process.env.E2E_STORE_API_URL;
const CHANNEL = process.env.E2E_CHANNEL ?? (process.env.CI ? undefined : 'chrome');
const browser = CHANNEL === undefined ? {} : { channel: CHANNEL };

// Every worker drives ONE Next server — a single Node event loop — and each listing view fires
// ~25 Link prefetch renders. Playwright's default (half the cores: 11 on the 22-thread dev
// machine) saturated it: in a full core run a listing took 17.7 s and a sign-in round trip over
// 15 s (0.1 s alone), and three passes failed 1, 1 and 9 tests on deadlines. With 4 workers the
// same suite passed 69/0 three times running, in about the same time (1.6–1.9 min against 1.6–2.3;
// one diagnostic pass took 1.2) — #327. CI keeps Playwright's default (its runners have few cores);
// `E2E_WORKERS` overrides either, and must be a positive integer.
function workersFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return process.env.CI ? undefined : 4;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`E2E_WORKERS must be a positive integer, got "${raw}"`);
  }
  return workers;
}
const WORKERS = workersFromEnv(process.env.E2E_WORKERS);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  ...(WORKERS === undefined ? {} : { workers: WORKERS }),
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: APP_URL,
    ...browser,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...browser } }],

  webServer: [
    {
      command: 'pnpm --filter @platform/contracts mock',
      // Any HTTP answer means Prism is up; `/store` without a key correctly returns 401.
      url: `${MOCK_URL}/store`,
      cwd: '../..',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Builds with one `SITE_URL` and starts with another, so a value captured by `next build`
      // shows up as the wrong origin in a spec instead of in production (#302).
      command: 'node scripts/e2e-server.mjs',
      url: READY_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      // The server honours $PORT rather than hard-coding one (REQUEST #68), so the port is set here.
      env: {
        MOCK_API_URL: MOCK_URL,
        PORT: new URL(APP_URL).port,
        // Said out loud rather than inherited: e2e/runtime-origin.spec.ts compares what is served
        // against this value, and the build is made with a different one.
        SITE_URL: RUNTIME_SITE_URL,
        // The e2e server is `next start` — production mode — where an unset client id fails closed
        // (#441). The starter shares the dev realm's brand-A client; a brand's own (preserved)
        // playwright.config / next.config names its own.
        KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID ?? 'storefront-brand-a',
        // The indexable configuration, as in `perf`. Without it `/robots.txt` is a bare
        // `Disallow: /` with no `Sitemap:` line — no origin in it at all — and a test that the
        // build origin is absent from it could not fail whatever robots.txt did (#309 review).
        ROBOTS_ALLOW_INDEXING: '1',
        // Set for a core run. For a mock run there is nothing to set here — and a `STORE_API_URL`
        // exported by the shell would still reach the server, because Playwright merges this map
        // over `process.env`. `scripts/e2e-env.mjs` removes it there, as `scripts/perf.mjs` does.
        ...(STORE_API_URL === undefined ? {} : { STORE_API_URL }),
      },
    },
  ],
});
