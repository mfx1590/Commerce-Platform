# @platform/storefront-brand-d

## Purpose

Brand D's storefront — **Japan, JPY, `ja-JP` only**, port **3104**. "Brand D" is a **working name**
off the generator's command line; the owner names the brand (LAUNCH row 0.1). Generated from
`apps/storefront-starter` per ADR 0004 by `apps/storefronts/brand-b/scripts/new-brand.mjs`, in the
**D8 onboarding proving run** (2026-11-12).

**This is the first brand that is not in `packages/db`'s seed.** Its store, legal entity and
publishable key were created in the admin onboarding wizard (#428). Two things follow and both bite:

- **The publishable key in `next.config.mjs` is the seeded form and authenticates as nothing.** The
  real key is one-time, comes from the wizard, and must never be committed (#827). Pass
  `STORE_PUBLISHABLE_KEY` from the environment.
- **Nothing in the seed knows this brand**, so anything that derives a brand list from the seed will
  not list it. `cms/test/datasets.test.ts` is a superset check (#521) and is fine with that.

## Owner

window 10 (brands). The starter is window 3 — never edit it from here; file a REQUEST. The
Dockerfile, the bake target and the helm values are window 5's (`**/Dockerfile`, `infra/**`) and do
not exist yet.

## Run / test

- `pnpm --filter @platform/storefront-brand-d dev` — brand D on **:3104**
- Against a real core, four values are required and each fails on its own (#828): `STORE_API_URL`,
  `STORE_PUBLISHABLE_KEY`, a **loopback** `SITE_URL`, `KEYCLOAK_URL`. See README.
- `pnpm --filter … start`, never `node scripts/start.mjs` — no workspace bin path.
- Gate before finishing: `pnpm lint && pnpm format:check && pnpm typecheck &&
pnpm test --filter @platform/storefront-brand-d`

## Constraints

Everything in the starter's CLAUDE.md applies. Brand work is `src/brand/**`, whole route files and
`cms/brand-d/**`; `src/lib/**` edits belong in the starter.

**Three things specific to this brand:**

- **JPY is zero-decimal.** ¥1,980 is `1980` minor units. Never divide or multiply by 100 anywhere:
  `packages/ui`'s `minorUnitDigits` asks CLDR and answers 0 for JPY. A `toFixed(2)` or a `/ 100`
  added here would be wrong in a way that looks right in every other brand.
- **One locale, `ja-JP`.** `SUPPORTED_LOCALES` is a runtime default in `next.config.mjs` because
  `src/i18n/routing.ts` is synced and defaults to the starter's two. `playwright.config.ts` sets the
  same value for the e2e process — it was generated with the template's `en-GB` and the whole suite
  died in warm-up (#826). If an e2e run ever fails with twelve `warm-up N: page failed`, check that
  line first.
- **`messages/ja-JP.json` is untranslated English.** It exists so the app renders at all;
  `src/i18n/request.ts` imports it unguarded. Do not mistake it for Japanese.
