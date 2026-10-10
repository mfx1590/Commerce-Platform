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
const APP_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3102';
/**
 * Brand B runs on :3102, but `e2e/support/build-origin.ts` (a starter file) defaults `SITE_URL` to
 * the starter's :3100. Every redirect is built on `SITE_URL` since #320, so left alone the sign-in
 * callback and sign-out would send the browser to the starter's port. Set before the workers start,
 * so the specs' `RUNTIME_SITE_URL` and the server agree.
 */
process.env.SITE_URL ??= new URL(APP_URL).origin;
const SITE_URL = process.env.SITE_URL;
/**
 * The store the **specs** talk to, set for the same reason as `SITE_URL` above: brand B's identity
 * has to reach the test process, not only the server (#379).
 *
 * `next.config.mjs` defaults this for the app, so the server has always had it — but a spec runs in
 * Playwright's process, where nothing set it and CI sets nothing either. The synced
 * `e2e/order-lifecycle.spec.ts` reads `GET /store` with
 * `'X-Publishable-Key': process.env.STORE_PUBLISHABLE_KEY ?? ''`, so against the core it sent an
 * empty key, got a 401 it did not check, and asked the Admin API for `viewer on store:undefined` —
 * a 403 that reads like a permissions bug and is really a missing variable. `journey.spec.ts`
 * never hit it because it carries the same fallback itself.
 *
 * The same value as `next.config.mjs`, deliberately: a dev **publishable** key, which is public by
 * design and already in this repo. Keep the two in step.
 *
 * Window 3 is hardening the spec separately (#382: assert `ok()` with status and body on
 * `GET /store` and every admin call) so the next missing variable fails where it happens.
 */
process.env.STORE_PUBLISHABLE_KEY ??= 'pk_brand-b_dev_00000000000000000000';
/**
 * **Brand B's locale and market, for the Playwright process** (#441 parts 4 and 3).
 *
 * `next.config.mjs` declares these for the app, and Playwright never loads it. Since #445 the
 * synced specs take the locale prefix from `e2e/support/locale.ts` and the shipping address from
 * `e2e/support/ship-address.ts`, both of which read `process.env` **at module load**. Set here with
 * `??=`, in this module's body, they reach the specs: Playwright evaluates this config in the parent
 * process before the workers fork, and the workers inherit `process.env` — the same mechanism
 * `STORE_PUBLISHABLE_KEY` above has always relied on.
 *
 * This is what replaced brand B's exclusions. Before #441 the inherited specs navigated to
 * `/en-GB` (right for B by luck) and filled a Netherlands address (wrong for B), so four funnel
 * tests timed out on "No delivery options are available for this address" and two locale-plural
 * tests failed against a correct app. Now they run against brand B's own locale and market.
 */
process.env.SUPPORTED_LOCALES ??= 'en-GB';
process.env.E2E_SHIP_ADDRESS_JSON ??= JSON.stringify({
  first_name: 'Ada',
  last_name: 'Lovelace',
  line1: '1 Deansgate',
  postal_code: 'M3 1BD',
  city: 'Manchester',
  country: 'GB',
});
/**
 * **Deliberate divergence from the starter, re-checked at every sync.** Since #375 the starter's
 * config imports `RUNTIME_SITE_URL` from `e2e/support/build-origin` and passes that to the server.
 * Brand B must NOT: that module reads `process.env.SITE_URL` in a module-level `const`, ES imports
 * are evaluated before the importing module's body, and the `??=` above runs in that body — so the
 * import would freeze the starter's `:3100` default before brand B ever set `:3102`, and every
 * redirect would leave the brand. `SITE_URL` here is the same string `RUNTIME_SITE_URL` computes,
 * only computed after the assignment instead of before it; the specs that import the module get the
 * right value because the `??=` mutates `process.env` before the workers fork.
 */
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
//
// Ported by hand from the starter at #375: this file is PRESERVED, so the sync reports its drift
// and never takes it. The validation is the starter's — `E2E_WORKERS=0` or `=two` used to mean
// "Playwright's default" silently, which reads as a passing run on a setting that did nothing.
function workersFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return process.env.CI ? undefined : 4;
  const workers = Number(raw);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`E2E_WORKERS must be a positive integer, got "${raw}"`);
  }
  return workers;
}
const WORKERS = workersFromEnv(process.env.E2E_WORKERS);

/**
 * **Brand B has no e2e exclusions any more** — #441 removed the reason for both of them, and this
 * block is the record of what used to be here so a reader does not go looking.
 *
 * - `seo-head.spec.ts` and two `checkout.spec.ts` tests were excluded because they hard-coded the
 *   starter's two locales. Part 1 made the list come from the app's own routing, so they now run
 *   against brand B's one locale, and **brand B has its `<head>` metadata coverage back** — the gap
 *   `ONBOARDING-GAPS.md` § 3.12 recorded is closed.
 * - Four funnel tests were excluded because `completeAddressStep` filled a Netherlands address and
 *   brand B ships GB only. Part 3 made the address come from `E2E_SHIP_ADDRESS_JSON`, set above.
 *
 * `e2e/journey.spec.ts` stays. It is not the same coverage: it asserts brand B's **identity** (one
 * locale served, `/de-DE` not served as de-DE, GBP prices against the core) and carries the
 * `GET /store` payment precondition with the CI-visible skip and success lines (#442). The funnel
 * overlap with the inherited specs is deliberate — a brand proving its own checkout on its own
 * market is worth one duplicated walk.
 */

export default defineConfig({
  testDir: './e2e',
  // No testIgnore and no grepInvert: see the block above. Every synced spec runs for brand B.
  // Visual baselines are keyed by platform: font rasterisation differs between a Windows laptop and
  // CI's Linux, so one PNG cannot serve both. Without this, taking a baseline locally guarantees a
  // meaningless red build on CI. See e2e/visual.spec.ts.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
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
      // One directory deeper than the starter.
      cwd: '../../..',
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
        SITE_URL,
        // The e2e server is `next start` — production mode — where since #441 part 2 an unset
        // client id **throws `OidcConfigError`** rather than borrowing brand A's. Ported from the
        // starter's config at the #445 sync, with brand B's own client.
        KEYCLOAK_CLIENT_ID: 'storefront-brand-b',
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
