# Changelog — @platform/storefront-brand-d

## Unreleased — 2026-11-12 · brand D, created in the D8 onboarding proving run

- **Generated** by `apps/storefronts/brand-b/scripts/new-brand.mjs` from brand B: 260 files in **one
  second**. Japan, **JPY**, `ja-JP` only, port 3104, jurisdiction JP. `sync --check` reports the
  manifest current; typecheck is clean and the unit suite is **749 passed / 3 skipped on the first
  run, with no edits**.
- **The first brand whose store was created in the onboarding wizard** rather than seeded
  (`brand-d`, `9f3c3c2a…`, legal entity "Brand D K.K."), and the first in a **zero-decimal**
  currency. Measured against that store: the Store API answers
  `{ amount_minor: 1980, currency: "JPY" }` and the PDP renders **￥1,980** — no decimal yen
  anywhere. `packages/ui`'s `minorUnitDigits` takes the digits from CLDR, so nothing in the
  storefront had to change for a currency with no minor unit.
- **Two generated values were wrong and are fixed here by hand**, both in `playwright.config.ts`:
  - `SUPPORTED_LOCALES` was the template brand's `en-GB`. The e2e server warms up on the app's
    default locale, so the entire suite died in warm-up — twelve rounds of
    `warm-up N: page failed` with nothing naming the locale, and the comment directly above the
    wrong line had been rewritten to say "Now they run against brand D's own locale and market".
    **#826**, fixed in the generator in the same change so the next brand does not pay it.
  - `E2E_SHIP_ADDRESS_JSON` was a Manchester address. This store ships **JP only**, so the funnel
    specs would have filled an address it refuses and timed out on "No delivery options are
    available for this address" — which reads like a checkout bug.
- **The publishable key in `next.config.mjs` cannot work** and must not be replaced in place: it is
  the seeded-database form, and a wizard-created brand's key is real and one-time. It comes from
  `STORE_PUBLISHABLE_KEY` in the environment (**#827**). Nothing git-tracked in this brand has ever
  held the real key.
- **Starting this brand against a core needs four environment values**, each failing separately
  (**#828**): `STORE_API_URL`, `STORE_PUBLISHABLE_KEY`, a loopback `SITE_URL` (a build carrying
  `E2E_LOCAL_IMAGES` refuses otherwise) and `KEYCLOAK_URL` (#783). The README lists them.
- **e2e against the real core: 10 passed, 3 failed, 1 skipped**, and none of the three is this app.
  Two wait on the store offering no payment method at all (`payment: {"methods": []}` — #825), so
  the funnel cannot complete; the third needs a second listed product. The CSP suite is **5 passed,
  1 failed**, that one failure being the same payment gap.
- `messages/ja-JP.json` is a copy of `en-GB` and **untranslated**. Without the file the app does not
  render at all, so the generator copies it; every string in it is English.
