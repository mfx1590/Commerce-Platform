# Changelog — @platform/storefront-brand-c

## Unreleased — 2026-11-13 · re-synced for #846 and #806

- **Re-synced from `apps/storefront-starter`** at main `78c69dd9` (starter 0.16.4 → 0.16.5):
  254 copied, 1 merged, 10 preserved, 4 excluded. `sync --check` reports the manifest current and
  no preserved file drifted.
- **#846 — a blank Store API string no longer renders an empty tag.** No Store API string has a
  `minLength` and the onboarding wizard leaves several empty, so a `??` fallback stopped at `""`.
  The new `src/lib/text.ts` is the one place that decides: product title → handle, category name →
  handle, store name → `Storefront`, image alt → product name, blank `seo.title` → product name,
  and a blank subtitle, brand or description renders **no element at all** rather than an empty
  `<p>` or a "Description" heading over nothing. `firstText` folds ASCII whitespace only, so an
  ideographic space (U+3000) in Japanese text survives; `firstBlock` keeps JSON-LD paragraphs.
- **#846 — the checkout country is pre-filled from the store, never hard-coded.** `checkoutCountry`
  takes the store's `default_country`, else the cart's own `country`, else nothing, so the customer
  chooses. `NL` remains only for a store that could not be read. This is the one of these fixes
  that costs money rather than looks wrong: a blank `default_country` used to pre-fill `NL`, and a
  Japanese customer saving an NL address silently gets the wrong shipping options and the wrong tax.
- **#806 — `@types/node` is on `^22.20.5`** and the repo requires Node `>=22.12 <23`. This re-sync
  did not move it: #806 had already updated each brand's `package.json`, so the merged
  `package.json` came out unchanged and what this commit refreshes is
  `scripts/starter-manifest.json`, which still recorded `^20.19.0`.
- Unit suite: **792 → 815**, all from the synced tests: `test/display-text.test.ts` (10)
  and `test/blank-strings-render.test.ts` (13).

## Unreleased — 2026-11-13 · re-synced for #838 and #840

- **Re-synced from `apps/storefront-starter`** at main `79914780` (starter 0.16.1 → 0.16.4):
  251 copied, 1 merged, 10 preserved, 4 excluded. `sync --check` reports the manifest current, no
  preserved file drifted, and **no dependency moved** — `@types/node` stays on `^20.19.0`, because
  the Node-types bump arrives with #806 and gets its own re-sync.
- **#838 — the PDP, category and JSON-LD meta description now fall back properly.** This is the
  defect brand D found against a real core: the chain stopped at an empty `subtitle`, because `??`
  falls past `null` and `undefined` but not past `''`, and `product.description` was never
  considered at all. Six `seo-head` cases failed on a product that had a description all along.
  Brands A, B and C never saw it because every seeded product has a non-empty subtitle.
- **#840 — a spec that needs something from the store now fails fast and says which thing.** The
  new `e2e/support/preconditions.ts` and its tests arrive in all four brands. That is the second
  half of #830: the brand D run spent **180 seconds** per test watching `locator.check` time out on
  a radio that would never render, because the store had no payment method — a silent timeout that
  reads like a frontend bug. It now names the precondition instead.
- Unit suite: **763 → 792**, all from the synced tests.

## Unreleased — 2026-11-11 · the mocked world agrees with itself, and the money is guarded by a test

- **`scripts/e2e-store-mock.mjs` now prices the catalogue in this brand's own currency.** Every
  `currency: XXX` in the spec's examples becomes the store's (`USD`, read from
  `perf/store.example.json`, never hard-coded) before the overlay. Until now the mock served this
  brand's **store** over the contract's **EUR** catalogue, so a page said `Prices in USD` in the
  footer and rendered `€19.99` in the body. Safe as a text substitution and checked rather than
  assumed: `Money.currency` is `{ type: string, pattern: '^[A-Z]{3}$' }` with **no enum**, and every
  currency literal in the spec sits inside an example. The **amounts** are untouched — 1999 minor
  units is `$19.99` here exactly as it was `€19.99` before.
- **Three visual baselines re-taken** (`plp`, `pdp`, `plp-card`) and reviewed. The other five hold no
  price and are byte-identical.
- **The finding that changes what those baselines are worth: the visual suite cannot catch a
  currency change, even now.** Measured, not guessed — the `€` → `$` difference on the PLP card is
  **37 pixels**, and the element tolerance of `maxDiffPixelRatio: 0.002` allows about **111** on that
  image; a full-page shot dilutes it further. #781 chose those numbers against a heading weight and
  a typeface swap, both much larger. So `--update-snapshots` did not even rewrite the files: it saw
  a match. They had to be deleted and re-taken.
- **`test/brand-money.test.ts`** (new) is therefore where this brand's currency is actually
  guarded: the store example really says USD, `formatMoney` renders `$19.99` with two decimals for
  `en-US`, and the same amount in EUR formats differently — so a fallback that quietly prices this
  brand in euros fails a test instead of passing a screenshot (#810).
- **`e2e-store-mock.mjs` refuses to start behind a stale mock.** If something already holds the
  port, Prism exits with `EADDRINUSE` and the script followed it quietly — while the OLD mock kept
  answering every request. That is not a harmless confusion: it is how a set of baselines gets
  re-taken against the wrong backend, passes, and proves nothing. It happened while building this
  change. The script now checks the port first and says so.

## Unreleased — 2026-11-11 · re-synced for #793 (every response carries the policy)

- **Re-synced from the starter** (#793): `src/lib/route-handlers.ts` and its tests, the
  `KEYCLOAK_URL` boot check in `src/instrumentation*.ts`, `ZoneBoundary` without
  `stopPropagation`, and the cart page's zone-aware link. `sync --check` clean; no dependency moved.
- **`e2e/visual.spec.ts` takes its paths from the locale helper** and asserts each page is the page
  it means to shoot before taking any screenshot (#797, which this brand's re-sync filed). A 404 can
  no longer be baselined as a passing full-page shot.
- **README bundle table re-synced from this PR's own legs: nothing moved.** #793 costs this brand
  **0.0 kB** on every route — all 19 rows are byte-identical to #800's. The legs report
  `bundle budget PASS` with the table as committed.
- **CSP e2e: 6 passed**, up from 3 passed / 1 skipped. The account/Keycloak test now **runs** rather
  than skipping — the shared stack's host ports were dead on 2026-11-10 and came back after the
  owner's Docker restart — and #790's two new cases are covered: back and forward across the
  checkout boundary each land on their own zone's document, and a path under a route-handler prefix
  with no handler answers a plain-text 404 that still carries the policy.
- **Brand C has visual baselines at last** — all eight, each reviewed. #797 was the blocker: the
  spec hard-coded `/en-GB`, this brand serves `en-US`, so every shot was of the 404 page and the
  full-page `home` shot passed because a 404 is perfectly stable. The fix is in the starter and the
  baselines are real pages now: "Brand C" in the header, `© 2026 Brand C · Ships to US · Prices in
USD` in the footer, the red theme throughout.
- **Read one thing out of those PNGs carefully: the product prices in them say `€`.** The mock
  serves this brand's **store** (via `scripts/e2e-store-mock.mjs`) over the **contract's**
  catalogue, whose example products are priced in EUR — so a page states USD in the footer and
  renders €19.99 in the body. That is the mock, not this brand: against a core its products are
  USD. The consequence worth knowing is that these baselines **cannot catch a currency-formatting
  regression** for brand C; everything about the theme, type, spacing and layout they do catch.

## Unreleased — 2026-11-10 · re-synced onto the nonce CSP and the starter's visual suite (#783, #781)

- **Nonce + `'strict-dynamic'` CSP arrives from the starter** (#783, starter 0.16.0): `src/lib/csp.ts`,
  `src/lib/csp-zone.ts`, `src/middleware.ts`, `src/components/zone-boundary.tsx`, the localised
  `[locale]/[...rest]` 404 route, `SCRIPTS.md` and the tests. `script-src` no longer carries
  `'unsafe-inline'`; the two frame zones (checkout = Stripe only, everywhere else = Stripe plus the
  vetted embed hosts) are crossed by a full page load in both directions.
- **This app adds no scripts of its own, so `SCRIPTS.md` needs no brand rows.** Audited before the
  sync: `next/script`, `<script`, `dangerouslySetInnerHTML`, `srcdoc`, inline handlers, `eval` and
  `new Function` return **zero** hits across `src/brand/**` and this brand's CMS content. Editor-side
  embeds stay window 6's (REQUEST #784).
- **CSP e2e on the production build: 3 passed, 1 skipped.** No violation on home, PLP, PDP, cart,
  checkout, the payment step or a CMS page; the cart → checkout click produces a **new document**
  with the Stripe-only policy and "continue shopping" a new document with the embed policy; the
  locale 404 answers **404** and carries the policy. Skipped: the account/Keycloak test, because
  Keycloak is not reachable from this laptop — it runs in CI, where `E2E_REQUIRE_KEYCLOAK` makes it
  an error rather than a skip. The Stripe card step also reports itself skipped on a mock run, which
  is #783's own stated blind spot.
- **`KEYCLOAK_URL` is now required for a production build** (`form-action` fails loudly without it).
  This brand's Helm values set it in both environments that exist — `values-dev.yaml` and
  `values-staging.yaml`. **No app in this repo has a `values-prod.yaml` yet**, so there is nothing
  in-tree to confirm for production; when that file is written it must carry `KEYCLOAK_URL`
  (`infra/helm/**`, window 5; recorded on #342).
- **README bundle table re-synced from this PR's own CI perf legs**, including the new
  `/[locale]/[...rest]/page` row (**125.1 kB** of the 145 kB default). The CSP middleware and
  `ZoneBoundary` cost about **0.8 kB** on every route: the PDP goes 140.6 → **141.4 kB** of
  its 144 kB budget, the tightest of the set, and every route stays inside its budget. No budget was
  touched (#348).
- **The visual suite now comes from the starter** (#781): full pages at `maxDiffPixelRatio` **0.0001**
  (was 0.002) plus five element shots. The starter commits no baselines of its own, so each brand
  keeps its own under `e2e/__screenshots__/`.
- **Brand C has NO visual baselines, and that is a starter bug, not an omission** — REQUEST
  **#797**. The synced `e2e/visual.spec.ts` hard-codes `/en-GB` in all three page entries; this
  brand serves `en-US` only, so each path is a correct 404. The suite does not error: it screenshots
  the localised "Page not found" page, the two element shots fail because a 404 has no product card
  or add-to-cart button, and the full-page `home` shot **passes**, because a 404 page is perfectly
  stable. I took those three, saw what they were and deleted them rather than commit a green
  baseline of the wrong page. `e2e/support/locale.ts` already exists and `csp.spec.ts` uses it; the
  fix is `localePath('')` and friends, in the starter.
- **`scripts/e2e-store-mock.mjs`** (new, this brand only): a Prism mock serving **this brand's**
  store, so its e2e can run on a laptop at all. Against `pnpm mock` — the contract's `en-GB`/`de-DE`
  example store — every page here is a 404 and the e2e server dies in warm-up. The script overlays
  `perf/store.example.json` onto a temporary copy of the spec with the same two functions
  `scripts/perf.mjs` has used since #447, so nothing new is invented; it is how the CSP run above
  was done. The catalogue is still the contract's: only the **store** is brand C's.

## Unreleased — 2026-11-10 · a Dependabot PR that bumps a starter package is no longer red (#758)

- **The comparison that made it red is narrowed.** `test/sync-merge.test.ts` asserts that this app's
  committed `package.json` agrees with the merge rules, by re-merging from
  `scripts/starter-manifest.json` — which it passes as _the starter_. The rule "the starter's value
  wins for a shared key" therefore read the version out of the manifest and demanded this app match
  it. Dependabot edits every `package.json` and never the manifest, so every PR of its for a starter
  package reverted its own bump and failed (#747, #755). Now the **version string of a dependency
  both this app and the manifest declare is ignored** in that comparison.
- **Why that is safe, and not just convenient.** `mergePackageJson` reads `previousStarter` only for
  key membership (`key in previousStarter`); it never reads a value out of it. The manifest's
  versions were authoritative in no code path — only in this one assertion. The live starter is the
  authority, and `sync --check` enforces it on demand, keys and values.
- **Everything else stays byte-exact**, and the file proves it rather than claiming it: a table of
  five mutations runs against the narrowed comparison **and** the byte-exact one it replaced. A
  dropped synced dependency, a changed synced script body and a reordered dependency block are
  caught; a hand-added dependency and an edited `dev` port are caught by neither, because the merge
  keeps a key only this app declares and `dev` is identity (the port is asserted directly in the
  next test). In the committed state the two comparisons are **equivalent**, which is the evidence
  the narrowing opened no hole; with a bump in the tree the byte-exact one differs for every row,
  which is the construction that made those PRs red.
- The commit shape of a bump is documented in the README — starter first, then each brand's sync,
  then a non-frozen `pnpm install`.
- **The masking is guarded by shape, after #789's review found the first version too broad.** It
  replaced a shared key's value _whatever it was_, so `"@platform/cms": "workspace:*"` could be
  swapped for `git+https://…`, an `npm:` alias or a tarball URL and this assertion no longer
  noticed — where the byte-exact comparison it replaced did, and nothing else in CI would. A value
  is masked only when **both** this app's and the manifest's are plain semver ranges (no `:`, no
  `/`), so every protocol value stays byte-exact. Four more mutation rows cover it, including the
  reverse direction: a `workspace:` dependency repointed at a registry range.
- Still invisible, and said plainly in the README: a **downgrade** inside plain semver reads exactly
  like a bump. The production audit gate is what catches a version with a known advisory.
- **This app now has `test/sync-merge.test.ts` at all.** Its `package.json` is generated, its merge
  module and manifest were here, and nothing checked that the three agreed — only brand A had the
  test, so a hand edit here would have been reverted by the next sync with no warning in between.

## Unreleased — 2026-11-10 · next 15.5.29 + sharp 0.35.5 from the starter (#731)

- **Re-synced from `apps/storefront-starter`** (#760): `next` `^15.5.4` → **`^15.5.28`**, which
  resolves to **15.5.29** and pulls **sharp 0.35.5** as next's optional dependency. That clears
  **GHSA-2464-fhr4-w9xw** (critical — its `infra/security/audit-allowlist.json` entry expires
  2026-11-20), **GHSA-p3m5-59mp-jv5r** (high) and **GHSA-wq5f-xc86-pv6w** (high, sharp < 0.35.5).
  Lockfile-wide: `pnpm why next -r` finds **one** version of next and `pnpm why sharp -r` **one** of
  sharp, so no importer is left on a vulnerable range.
- **The bump arrived through `scripts/sync-from-starter.mjs`, not by hand.** `next` is a
  starter-manifest package, so `package.json` and `scripts/starter-manifest.json` have to move in the
  same step: editing the dependency by itself leaves the manifest claiming the old specifier, and
  `test/sync-merge.test.ts` fails on exactly that. `sync --check` reports the manifest current.
- The same sync picked up the starter's `scripts/perf-store-example.mjs` validator cache (#620) —
  the `Store` Ajv schema is now compiled once per spec text instead of per assertion. It was already
  on main and had simply not reached this brand yet.
- **README bundle table re-synced** from this PR's own CI perf leg — there was no machine slot for
  a local build, and the table is generated from a build. Every route grew: the PDP **139.7 → 140.6
  kB** of its 144 kB budget and the cart **140.2 → 141.1** of 145, the two tightest. `bundle budget
PASS` on the leg. The budgets themselves are untouched (#348).
- The README's gate line said **583 passed**; the suite is **658 passed, 3 skipped**.

## Unreleased — 2026-10-09 · brand C's perf store example (#438, #448)

- **`perf/store.example.json`**, so the perf gate measures brand C's own store. `scripts/perf.mjs`
  measures **always against the Prism mock** by design, and the mock's `GET /store` example is brand
  A (`en-GB`, `de-DE`) — so brand C's `/en-US` URLs were correct 404s, the warm-up never succeeded
  and the Lighthouse leg failed while the bundle budget passed. #448 lets a brand overlay its own
  example; this file is brand C's half. Locally: `perf: bundle budget PASS, Lighthouse PASS`.
- Every field is taken from `packages/db`'s seed rather than invented — including the **theme**
  (`#B91C1C`), because Lighthouse scores accessibility on contrast and an empty theme would measure
  the design kit's default palette instead of this brand's.
- `test/i18n.test.ts` is no longer preserved — for real this time. A `git checkout` during an
  unrelated revert had restored it to `PRESERVE` after I removed it, and the commit that claimed it
  was dropped was wrong. The file is synced from the starter again; preserved count is 10, matching
  brands A and B.

## Unreleased — 2026-10-09 · brand C generated by script (#438)

- **The first brand created by a generator**, `apps/storefronts/brand-b/scripts/new-brand.mjs`,
  rather than by hand. The rules live in a pure, unit-tested module
  (`scripts/new-brand-plan.mjs`, tests in brand B's suite); the CLI runs the brand's own
  `scripts/sync-from-starter.mjs` first — `208 copied, 1 merged, 11 preserved, 4 excluded` from 224
  tracked starter files — then writes identity, runtime defaults and the content skeleton.
  `sync --check` reports `manifest is current`.
- **Derived from brand B, not from the starter**, so C inherits the fixes A and B earned: the
  path-depth adjustments, `numberOfRuns: 5` (#348), the `STORE_PUBLISHABLE_KEY ??=` line in
  `playwright.config.ts` (#382) and the deliberate refusal to import `RUNTIME_SITE_URL` (#379). Port
  **3103**, `@platform/storefront-brand-c`, C's seeded publishable key.
- **Runtime defaults in `next.config.mjs`**: `STORE_PUBLISHABLE_KEY`, `SUPPORTED_LOCALES=en-US` and
  `KEYCLOAK_CLIENT_ID=storefront-brand-c`. The last one is not optional —
  `src/lib/auth/oidc.ts` falls back to `storefront-brand-a`, and a brand that stays quiet mints
  sessions scoped to `brand-a` which the core is right to refuse (#437, #441 part 2).
- **`messages/en-US.json`**, brand C's own catalogue, 139 keys. Not cosmetic:
  `src/i18n/request.ts` imports `messages/${locale}.json` **unguarded**, so before this file existed
  brand C threw on **every page**. Copied from the starter's `en-GB.json` with two strings
  Americanised ("was not authorised" → "authorized"); it has had no US-English review
  (`LAUNCH.md` 12.2).
- **`test/i18n.test.ts` is PRESERVED**, which no other brand does, and carries one new test. The
  starter's version asserts a hard-coded set of two catalogues and never reads the configured
  locales, so in a brand app — where vitest sets no `SUPPORTED_LOCALES` — it passed on an app that
  could not serve a page. C's copy expects three and adds a test that reads `SUPPORTED_LOCALES` out
  of `next.config.mjs` and fails when a catalogue is missing. The preservation is removed when
  window 3 derives the set from the config.
- **`lighthouserc.json` measures `/en-US`.** The generator used to copy it byte for byte from the
  template, which left brand C measuring two `/en-GB` 404s and calling the result a performance
  score. `numberOfRuns: 5` and the 2500 ms LCP budget are unchanged; the port stays `3100` for every
  brand because `scripts/perf.mjs` starts its own `next start --port ${PERF_PORT ?? 3100}`.
- **`cms/brand-c/content`**: the home page and the four legal documents in `en-US`. All five validate
  against the shared schemas (`seed-content.mjs --dry-run` → _10 documents valid (1 campaignLanding, 1 footer, 3 page, 4 legal, 1 navigation)_).
  The legal texts cite **US** instruments — UCC Article 2 as adopted by the state, the FTC Mail,
  Internet, or Telephone Order Merchandise Rule, CCPA/CPRA, the NY SHIELD Act, COPPA, CAN-SPAM — and
  are **a developer's drafts**. They are not brand B's text translated: there is **no federal right
  to cancel an online order** in the US (the FTC Cooling-Off Rule covers door-to-door sales, not
  websites), prices are quoted **without** sales tax rather than VAT-inclusive, and privacy is state
  law rather than one statute. `LAUNCH.md` 9.3 is the gate that matters.
- **`LAUNCH_GATE=1` fails on 23 placeholders (19 distinct)**, naming each with the owner value it
  needs. The scanner self-test validates against a sample string rather than the content's current
  state, so it survives go-live.
- **e2e is excluded and not yet trustworthy.** `playwright.config.ts` carries the locale-plural and
  NL-address exclusions the generator emits (so #441 has one place to undo), but brand C's deeper
  problem is that every synced spec addresses `/en-GB` and `scripts/e2e-server.mjs` warms `/en-GB`
  before declaring the app ready. Both are window 3's files. See `LAUNCH.md` § 12; a REQUEST asks for
  the locale prefix to come from `src/i18n/routing.ts`.

### Known red on the creating PR

`app images` fails: `infra/ci/check-image-manifests.sh` requires every image's `deps` stage to copy
every workspace `package.json`, so adding brand C turns it red across **nine** Dockerfiles, all of
them window 5's (`**/Dockerfile`). Brand B hit the same wall and it landed through a manager
integration PR (#443). REQUEST #439 carries brand C's lines.
