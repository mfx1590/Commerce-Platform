# Changelog — @platform/storefront-brand-b

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
- **The visual suite now comes from the starter** (#781): full pages at `maxDiffPixelRatio` **0.0001**
  (was 0.002) plus five element shots. The starter commits no baselines of its own, so each brand
  keeps its own under `e2e/__screenshots__/`.
- **Brand B took all eight baselines for the first time**, each reviewed. One thing to know when
  reading them: `pnpm mock` serves the **contract's** example store, which is brand A's, so the
  header, footer and prices in these PNGs say "Brand A" and `EUR`. What they capture is brand B's
  **theme and layout** — the green tokens, the type, the spacing — over shared example data, and
  re-taking them with the documented command reproduces exactly this. A faithful catalogue needs a
  core (`E2E_STORE_API_URL`), which is how the e2e runs in CI.

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

## Unreleased — 2026-10-09 · brand B's perf store example (#448)

- **`perf/store.example.json`**, so brand B's perf measurement stops depending on luck. The perf
  gate measures against the Prism mock, whose `GET /store` example is brand A — and brand B worked
  only because `en-GB` happens to be one of brand A's two locales. It measured brand A's EUR store
  under brand B's name. Now it measures brand B: GBP, `en-GB`, GB, and brand B's own seeded theme
  (`#047857`), which matters because Lighthouse scores accessibility on contrast.
- Fields come from the seed (`SEED_IDS.stores.brandB`, `seedId(2, 6, 1)` for the sales channel), not
  from the contract example.
- The e2e exclusions are gone (#441): `seo-head.spec.ts`, the two locale-plural checkout tests and
  the four NL-address funnel tests all run now, the last of those on a **Manchester** address from
  `E2E_SHIP_ADDRESS_JSON`. Brand B has its `<head>` metadata coverage back.

## Unreleased — 2026-10-09 · brand B created from the starter (#437)

- **Cloned** from `apps/storefront-starter` with the brand's own copy of
  `scripts/sync-from-starter.mjs`: `220 copied, 0 merged, 0 preserved, 4 excluded` from 224 tracked
  starter files; `sync --check` reports `manifest is current`.
- **Identity derived from brand A's preserved files, not the starter's**, so B inherits the fixes A
  earned: the path-depth adjustments, `numberOfRuns: 5` (#348), the `STORE_PUBLISHABLE_KEY ??=` line
  in `playwright.config.ts` (#382) and the deliberate refusal to import `RUNTIME_SITE_URL` (#379).
  Port **3102**, `@platform/storefront-brand-b`, B's seeded publishable key.
- **One locale.** `SUPPORTED_LOCALES=en-GB` is a runtime default in `next.config.mjs` —
  `src/i18n/routing.ts` is synced and defaults to `'en-GB,de-DE'`, so a brand that sells one locale
  has to say so through the environment rather than by editing a synced file.
- **Theme: Stonecrop** (a working name). `src/brand/tokens.ts` carries B's own palette — Chalk,
  Slate, Moss, Mist, Brick — a **system font stack** (no font binaries: no licence to track, and
  #348 found A's hero LCP is render-delay bound) and squarer radii. `src/brand/config.ts` differs
  from the starter in name and description only, exactly as brand A's does.
- **`cms/brand-b/`**: the document **set** mirrored from brand A — home, `about`, `made`, the
  `winter-weight` campaign, navigation, footer and four legal documents. **Ten documents, not
  twenty**: A's twenty is ten per locale across two locales, and B sells one. All ten resolve and
  validate against the shared schema (`resolved 10 / dropped 0 / errors 0 / invalid 0` with a
  placeholder cloud name; `dropped 10 / invalid 0` without one).
- **Legal pages cite UK law** — Consumer Rights Act 2015, Consumer Contracts Regulations 2013, UK
  GDPR / Data Protection Act 2018, ICO — not the German statutes brand A's imprint carries, because
  B's legal entity is GB. They are drafts: **17 `[[PLACEHOLDER]]`s, 14 distinct**.
- **Media manifest declares seven slots with no `bytes`, `sha256`, `width` or `height`**: brand B's
  stills have not been generated and a made-up digest would be a false record. The manifest's own
  `source` and `generator` fields say `NOT YET GENERATED`.
- **Placeholder launch gate** (`test/launch-gate.test.ts`, `LAUNCH_GATE=1`): skips without the flag,
  fails with it naming every placeholder by name, count and file. It scans **all** of
  `cms/brand-b/content/*.json`, not only the imprint — which is how it caught
  `[[COMPANY_LEGAL_NAME]]` in `footer.json`'s copyright line. Brand A has the same gate.
- **`e2e/journey.spec.ts`** asserts what makes this app brand B rather than the starter: it serves
  `en-GB` and does **not** serve `de-DE` as that locale, and its prices render in **pounds** (a euro
  price would mean the wrong publishable key). The inherited starter specs cover the funnel.
- **`LAUNCH.md`** with a section 0 brand A does not have: the brand's real name and the copy review
  are owner actions, because the name and the prose here are a developer's first draft.
- **`ONBOARDING-GAPS.md`** — the input to #438: what a script can do, what it must ask, the six traps
  that cost time, the two CI legs that needed nothing, and what a brand _not_ already in the seed
  still needs.
- Verified: lint, `format:check`, typecheck clean; brand B **582 passed / 3 skipped**; brand A
  unchanged at **765 passed / 3 skipped**; `perf_apps` lists `apps/storefronts/brand-b`.
