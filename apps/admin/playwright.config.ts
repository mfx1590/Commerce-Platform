import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end config for the admin app.
 *
 * Three things are needed for a run: Keycloak (a docker service that must already be up —
 * `pnpm compose:up`), the Prism Admin API mock, and a production build of the app. The last two are
 * started here; Keycloak is not stubbed because signing in against the real staff realm is the whole
 * point of the journey. The build matters too: `next dev` behaves differently enough around caching
 * and server actions that a green dev run would prove little.
 *
 * **Ports.** The app honours `$PORT` (REQUEST #68) and so does this config, defaulting to 3000.
 * The catch is the OIDC redirect: the `admin-app` client registers `http://localhost:3000/*` as its
 * only redirect URI today, so the callback lands on whatever owns 3000 regardless of where the app
 * listens — moving `$PORT` alone is not enough. REQUEST #82 asks window 2 to register
 * `http://localhost:3200/*` as well; once that lands, `PORT=3200 pnpm --filter @platform/admin e2e`
 * runs cleanly when another project is holding 3000.
 *
 * `channel: 'chrome'` uses the Chrome already on the machine rather than downloading Playwright's
 * bundled browsers, matching what window 3 settled on for the storefront. CI wiring is REQUEST #80,
 * since `.github/workflows/**` is not this window's to edit.
 */
const PORT = process.env.PORT ?? '3000';
const APP_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
/**
 * The Prism mock this run starts, and the only Admin API the app under test is allowed to see.
 * Deliberately **not** derived from `ADMIN_API_URL`: that variable points a developer's app at the
 * real core, and an e2e run that silently followed it would stop being hermetic — the journey would
 * pass or fail on whatever the core happened to be serving. The webServer block below forces
 * `ADMIN_API_URL` to this value for the same reason, so a `.env` carrying
 * `ADMIN_API_URL=http://localhost:9000` changes nothing here.
 */
const MOCK_URL = process.env.MOCK_ADMIN_API_URL ?? 'http://localhost:4011';

/**
 * What the app calls itself, which is what it builds `redirect_uri` from. It must be an origin the
 * Keycloak client registers, so it follows `APP_URL` rather than being pinned — override it only to
 * point a differently-hosted app at a registered origin.
 */
const APP_ORIGIN = process.env.ADMIN_APP_URL ?? APP_URL;

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
        // `next start` takes the port from here (REQUEST #68 dropped the hard-coded --port).
        PORT: new URL(APP_URL).port || '3000',
        // Both names, highest-precedence one first: `ADMIN_API_URL` wins in the app, so setting it
        // is what actually pins the run to Prism when the developer's .env points at the core.
        ADMIN_API_URL: MOCK_URL,
        MOCK_ADMIN_API_URL: MOCK_URL,
        ADMIN_APP_URL: APP_ORIGIN,
        // Required in every environment; a throwaway value is right for a test run.
        ADMIN_SESSION_SECRET:
          process.env.ADMIN_SESSION_SECRET ?? 'e2e-session-secret-at-least-32-characters',
      },
    },
  ],
});
