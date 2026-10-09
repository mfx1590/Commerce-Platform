# Changelog — @platform/storefront-brand-b

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
