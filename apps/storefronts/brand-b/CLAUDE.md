# @platform/storefront-brand-b

## Purpose

Brand B's storefront — **Stonecrop**, a WORKING name (the owner names the brand: `LAUNCH.md` 0.1).
GB market, **GBP**, **`en-GB` only**. Generated from `apps/storefront-starter` per ADR 0004.
Identity: port **3102**, publishable key `pk_brand-b_dev_…` (seed, local only), Keycloak client
`storefront-brand-b`, Sanity dataset `brand-b`.

Its store, legal entity, products and key **already exist in the seed** — #437 cloned the app, not
the store.

## Owner

window 10 (brands). The starter is window 3 — never edit it from here; file a REQUEST. The Dockerfile
is window 5's (`**/Dockerfile`) and does not exist yet: REQUEST #439.

## Run / test

- `pnpm mock` — Prism Store API on :4010
- `pnpm --filter @platform/storefront-brand-b dev` — brand B on **:3102**
- `build` / `start` / `typecheck` / `test` / `e2e` / `perf`
- Gate before finishing: `pnpm lint && pnpm format:check && pnpm typecheck &&
pnpm test --filter @platform/storefront-brand-b`
- Launch gate (not part of CI): `LAUNCH_GATE=1 pnpm test --filter @platform/storefront-brand-b`
  — **fails** while any `[[PLACEHOLDER]]` is left in `cms/brand-b/content`.

## Constraints

Everything in the starter's CLAUDE.md applies. Brand work is `src/brand/**`, whole route files, and
`cms/brand-b/**`; `src/lib/**` edits belong in the starter (REQUEST to window 3) so re-syncs stay
clean.

**Three things specific to this brand:**

- **One locale.** `SUPPORTED_LOCALES=en-GB` is a runtime default in `next.config.mjs`, because
  `src/i18n/routing.ts` is synced and defaults to two. Do not edit `routing.ts`.
- **`LOCAL_DEVELOPMENT_SITE_URL` stays `:3100`.** It is the starter's constant and synced starter
  tests assert it; brand A left it alone too. This app's port lives in `scripts/start.mjs` and
  `playwright.config.ts`.
- **The media manifest has no `bytes`/`sha256`** — brand B's stills do not exist yet. Do not invent
  them. See `ONBOARDING-GAPS.md`.

Read `ONBOARDING-GAPS.md` before cloning another brand: it is the list of what a script can and
cannot do (#438).
