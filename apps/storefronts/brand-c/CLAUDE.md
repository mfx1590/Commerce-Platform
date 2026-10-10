# @platform/storefront-brand-c

## Purpose

Brand C's storefront. **US market, USD, `en-US` only**, port **3103**. The brand has **no name yet** —
"Brand C" came off the generator's command line and `LAUNCH.md` 0.1 is the owner action that fixes it.
Generated from `apps/storefront-starter` per ADR 0004, by
`apps/storefronts/brand-b/scripts/new-brand.mjs` (#438) — the **first brand created by script**.

Identity: publishable key `pk_brand-c_dev_…` (seed, local only), Keycloak client
`storefront-brand-c`, Sanity dataset `brand-c`. Its store, legal entity, **NY sales tax 8.875%**,
`shippingCountries: ['US']` and key **already exist in the seed** — #438 generated the app, not the
store. Check what you pass on the command line against `packages/db` `SEED_IDS.*.brandC` rather than
assuming; an app and a store that disagree about currency or locale is a silent bug.

## Owner

window 10 (brands). The starter is window 3 — never edit it from here; file a REQUEST. The Dockerfile
is window 5's (`**/Dockerfile`) and does not exist yet, and **nine existing Dockerfiles need brand
C's `COPY` line**: REQUEST #439. See `LAUNCH.md` § 11.

## Run / test

- `pnpm mock` — Prism Store API on :4010
- `pnpm --filter @platform/storefront-brand-c dev` — brand C on **:3103**
- `build` / `start` / `typecheck` / `test` / `e2e` / `perf`
- Gate before finishing: `pnpm lint && pnpm format:check && pnpm typecheck &&
pnpm test --filter @platform/storefront-brand-c`
- Launch gate (not part of CI): `LAUNCH_GATE=1 pnpm test --filter @platform/storefront-brand-c`
  — **fails** while any `[[PLACEHOLDER]]` is left in `cms/brand-c/content` (23 today, 19 distinct).
- **`pnpm e2e` runs in CI and not on a laptop**, and the difference is the backend. CI's live job
  runs brand storefronts against the kept core, which holds brand C's real store: **44 passed /
  6 skipped** on #444's run 37920845926, with `[e2e-server] ready: http://127.0.0.1:3103 is warm`.
  Locally it cannot start, because `pnpm mock` is Prism serving one store (`brand-a`,
  `en-GB`/`de-DE`) and every `/en-US/...` route is then a correct 404. Point it at a core with
  `E2E_STORE_API_URL` or read the CI leg. See "The locale gap" below.

## Constraints

Everything in the starter's CLAUDE.md applies. Brand work is `src/brand/**`, whole route files, and
`cms/brand-c/**`; `src/lib/**` edits belong in the starter (REQUEST to window 3) so re-syncs stay
clean.

### The locale gap — read this before touching anything i18n

Brand C is the **first brand whose locale is not one the starter serves**. The starter serves `en-GB`
and `de-DE` and writes those into its synced files as literals. Brand B sells `en-GB`, so every
literal it inherited happened to be right; for brand C none of them are.

- **`messages/en-US.json` is brand C's own file and must exist.** `src/i18n/request.ts` imports
  `messages/${locale}.json` **unguarded** — without it brand C throws on every page, in dev, in
  `next build` and in production. It is brand B's `en-GB.json` with two spellings changed; 12.2 in
  `LAUNCH.md` is the review nobody has done.
- **`test/i18n.test.ts` is PRESERVED here**, which no other brand does. The starter's version
  asserts a hard-coded set of two catalogues, which is vacuously true in a brand app (vitest sets no
  `SUPPORTED_LOCALES`). Brand C's copy expects three and adds a test that reads the locale out of
  `next.config.mjs`. The preservation comes out when window 3 takes the set from the config.
- **The synced e2e specs and `scripts/e2e-server.mjs` still address `/en-GB`.** They are window 3's
  and the sync replaces them, so do not rewrite them here. Excluding them would delete the suite
  rather than port it.
- **Do not edit `src/i18n/routing.ts`.** It is synced and defaults to the starter's two.
  `SUPPORTED_LOCALES=en-US` is a runtime default in `next.config.mjs` instead.

### Three more things specific to this brand

- **`LOCAL_DEVELOPMENT_SITE_URL` stays `:3100`.** It is the starter's constant and synced starter
  tests assert it; brands A and B left it alone too. This app's port lives in `scripts/start.mjs` and
  `playwright.config.ts`.
- **Prices exclude sales tax.** A and B quote VAT-inclusive prices; C quotes the price and adds NY
  sales tax at checkout. Anything ported from A or B that assumes a tax-inclusive total is wrong.
- **The media manifest has no `bytes`/`sha256`** — brand C's stills do not exist yet. Do not invent
  them.

Read `apps/storefronts/brand-b/ONBOARDING-GAPS.md` before cloning another brand: it is the list of
what a script can and cannot do (#438), and brand C is the evidence for most of it.
