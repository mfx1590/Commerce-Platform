import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end config for the admin app.
 *
 * Three servers are started for the run: the Prism Admin API mock, a production build of the app,
 * and — unlike the storefront — nothing for Keycloak, because it is a docker service that must
 * already be up (`pnpm compose:up`). Signing in is the point of the journey, so it is the real realm
 * rather than a stub.
 *
 * **The app must be on port 3000.** The `admin-app` Keycloak client registers `http://localhost:3000/*`
 * as its only redirect URI, so a different port fails at the callback. If something else holds 3000,
 * run the app elsewhere with `ADMIN_APP_URL=http://localhost:3000` and point `E2E_BASE_URL` at it —
 * the `redirect_uri` then still matches what the client expects.
 *
 * `channel: 'chrome'` uses the Chrome already on the machine rather than downloading Playwright's
 * bundled browsers, matching what window 3 settled on for the storefront. CI wiring is a `REQUEST:`
 * issue, since `.github/workflows/**` is not this window's to edit.
 */
const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const MOCK_URL = process.env.MOCK_ADMIN_API_URL ?? 'http://localhost:4011';

export default defineConfig({
  testDir: './e2e',
  // Serial: the journey signs in against a shared realm, and parallel sign-ins on one account
  // would race over the realm's SSO session.
  fullyParallel: false,
  workers: 1,
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
      // Any HTTP answer means Prism is up; the admin mock answers /admin/me with any bearer token.
      url: `${MOCK_URL}/admin/me`,
      cwd: '../..',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm run build && pnpm run start',
      // `/health` is unauthenticated on purpose, so it is the one URL that answers 200 before a
      // sign-in — exactly what a readiness wait needs.
      url: `${APP_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        PORT: new URL(APP_URL).port,
        MOCK_ADMIN_API_URL: MOCK_URL,
        ADMIN_APP_URL: process.env.ADMIN_APP_URL ?? APP_URL,
        // Required in every environment; a throwaway value is right for a test run.
        ADMIN_SESSION_SECRET:
          process.env.ADMIN_SESSION_SECRET ?? 'e2e-session-secret-at-least-32-characters',
      },
    },
  ],
});
