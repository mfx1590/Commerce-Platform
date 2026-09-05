import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end config for the storefront.
 *
 * Two servers are started for the run: the Prism mock (the Store API in Phase 1) and a production
 * build of the app. The build matters — `next dev` behaves differently enough around caching and
 * server actions that a green dev run would not tell us much.
 *
 * `channel: 'chrome'` uses the Chrome already on the machine instead of downloading Playwright's
 * bundled browsers. Task 1.7 decides what CI does (a `REQUEST:` issue owns the workflow file).
 */
const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
const MOCK_URL = process.env.MOCK_API_URL ?? 'http://localhost:4010';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: APP_URL,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],

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
      env: { MOCK_API_URL: MOCK_URL },
    },
  ],
});
