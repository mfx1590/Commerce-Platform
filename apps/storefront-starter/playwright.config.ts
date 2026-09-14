import { defineConfig, devices } from '@playwright/test';

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

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
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
      command: 'pnpm run build && pnpm run start',
      url: APP_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      // `start` honours $PORT rather than hard-coding one (REQUEST #68), so the port is set here.
      env: {
        MOCK_API_URL: MOCK_URL,
        PORT: new URL(APP_URL).port,
        ...(STORE_API_URL === undefined ? {} : { STORE_API_URL }),
      },
    },
  ],
});
