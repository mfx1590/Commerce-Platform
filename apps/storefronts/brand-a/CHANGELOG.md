# Changelog — @platform/storefront-brand-a

## Unreleased — brand A imagery

- `cms/brand-a/media/manifest.json` covers the 19 premium stills and 2 hero loops: source path, bytes, sha256, aspect, Cloudinary public id, and alt text in en-GB and de-DE for each placed slot. No binaries are in the repo.
- Content refers to images by **slot**. `cms/brand-a/scripts/resolve-media.mjs` resolves slots at seed time using `CLOUDINARY_CLOUD_NAME_BRAND_A` or `CLOUDINARY_CLOUD_NAME`. With neither set, optional images are left out with one warning; a required image is an error. Placed: the heroes on home, about, cloth and the autumn campaign, four image blocks and the home Open Graph image (18 per seed across both locales).
- `cms/brand-a/scripts/upload-media.mjs` is for the owner: it verifies sha256, signs uploads, and with no credentials only prints the plan.
- `test/brand-media.test.ts` (15 tests). `test/cms-brand-content.test.ts` now validates the resolved documents, which are what the seed sends.
- `DESIGN.md` §7 Imagery: treatment, proportions by placement, alt-text rules, and the reduced-motion and pause rules for the hero loops. The loops wait on REQUEST #330, an optional video field on the CMS hero.

## Unreleased — #143 order history against the core

- `e2e/journey.spec.ts` "order history": sign in as the realm's verified customer, buy one unit through
  the UI, and assert the core-served history lists **that order id** at the confirmation's total, then
  open it from there. It reaches the history through the core's verified-email match: brand A does not
  have #312 yet, so the order is a guest order. Two units of stock per full-suite run now.
- Proven 2026-10-04 against the core: green (1 passed), and red with a wrong order id ("not in the
  history", 0 of 1).
- README: the backend table now shows `/store/customers*` on the core (#325), and order history is
  documented as real. Added a gotcha: rebuild the workspace packages after merging main.

## Unreleased — 2026-10-03 · re-sync from the starter at main 4c4aa80

- **Re-sync**: 176 copied, 1 merged, 10 preserved, 5 excluded. Brings #299, #305, #309, #316,
  #317, #320, #321, #322 (metadata in `<head>`, store facts, per-request sitemap, routed CMS
  documents in the sitemap, redirects and preview redirects from `SITE_URL`, fail-closed origin,
  warm-readiness e2e server).
- **Preserved files had drifted and silently missed starter fixes**, so each was rebuilt from the
  starter with only brand values kept: `next.config.mjs` (gains `htmlLimitedBots`, CSP frame
  hosts, security headers, the picsum seed host), `src/brand/config.ts` (fail-closed `siteUrl()`),
  `playwright.config.ts` (`scripts/e2e-server.mjs` with build-vs-runtime `SITE_URL` and the
  readiness port) and `lighthouserc.json` (pessimistic SEO at 0.95).
- **`SITE_URL` is no longer defaulted** in `next.config.mjs`: a default would defeat #320's fail
  closed and answer `localhost:3101` from a real deployment. A production brand A without it now
  answers 500; the e2e config derives it from `APP_URL` (the starter's support file defaults to
  :3100, which would have sent sign-in and sign-out redirects to the wrong port).
- `e2e/routes.spec.ts`: the #274 placement pin went red as designed and is replaced by an
  assertion that description, canonical and hreflang are in `<head>` on brand A's routes,
  **content routes included**.
- `test/brand-i18n-seo.test.ts`: the `STATIC_PATHS` pin is replaced by the real inventory — brand
  A's authored dataset fed through the synced `contentEntries`: 2 pages, 4 legal pages and the live
  campaign, each in both locales; the campaign drops out after `endsAt`.
- Sync lists: `test/slots.test.ts` is no longer preserved (#278 resolved upstream);
  `test/starter-defaults.test.ts` is excluded (starter-only, and its imports evaluate brand fonts;
  REQUEST #326 asks window 3 to move them inside the `runIf` block).
- **SEO re-measured**: 1.00 on all 12 Lighthouse runs (worst of three per URL), hreflang in
  `<head>` in the raw bytes on 280/280 checks. Details in the README.
- `e2e/routes.spec.ts` placement check is case-insensitive (React writes `hrefLang=`), and its
  content routes follow the same `CMS_DATASET` gate as the route test.
- **Preserved-file drift is now reported.** Each sync records the starter's git blob id per
  preserved file in `scripts/starter-preserved.json`; the sync and `sync --check` list every
  preserved file whose starter counterpart changed since. Report only — it never fails a suite.
  `scripts/preserved-drift.mjs` + 5 tests.

## 0.6.0 — 2026-10-02 · task 2.5 (#143, partial — see below)

- **`e2e/journey.spec.ts`** — browse → buy against the **core**, covering what the inherited
  `checkout.spec.ts` does not: PLP sorting and category filtering **with an observable effect**, PDP
  variant selection, and a placed order whose server-produced values are asserted.
  - sorting asserts the listing is **actually ordered by price**, not merely that the URL changed;
  - the category filter compares **totals from the API**, because the listing is paginated and an
    earlier version compared 24 cards against 24 cards and proved nothing;
  - the buy test places a real order and ties it to the cart **arithmetically**: the order total is
    the cart total plus a shipping amount that is itself a line on the confirmation. They are not
    equal, and should not be — delivery is chosen after the cart. Asserting equality was wrong about
    the app, and failed with €40.54 vs €45.53, exactly one delivery option apart.
- **Which backend answers what is now documented per route** in the README. Running "against the
  core" does not mean every request reaches it: with `CORE_STORE_API_FALLBACK=1` the core proxies
  what it does not mount. The core answers `/store`, `/store/products*`, `/store/carts*` (a real
  UUID) and `/store/orders/{id}`; **Prism answers `/store/customers/me` and the `/store/orders`
  list** (#303). Keycloak is real throughout.
- **Order history against the core is NOT verified**, and is no longer claimed. `account.spec.ts`
  asserts `jane@example.com` and `Order #1000` — both Prism-served, the latter a hard-coded dataset
  value — so it proves the Keycloak journey and nothing about the core's customer routes.
  REQUEST **#306** asks window 3 to split the file; the core gap is **#303**.
- **Stock budget stated**: the buy test consumes one unit per run from a shared seed, so it buys
  from the deepest-stocked variant in the catalogue, chosen by property at runtime.
- `playwright.config.ts` forwards `STORE_API_URL` into the `webServer` env, mirroring the starter.
  Locally invisible (`reuseExistingServer`), but in CI (#295) the run would have booted against
  Prism while reporting as a core run.
- README: corrected the stale `#212` references and a Stone hex (`#746C60` → `#6B6357`).
- **Flake check, taken on a quiet machine** (windows 1 and 3 idle by arrangement, CPU 0–12% sampled
  immediately before, fresh core and storefront, every run bounded with `--max-failures=1` and
  `--global-timeout`):

  | Full-suite pass | Result                                                                           |
  | --------------- | -------------------------------------------------------------------------------- |
  | 1               | 34 passed, 21 skipped, exit 0                                                    |
  | 2               | 34 passed, 21 skipped, exit 0                                                    |
  | 3               | 33 passed, 1 failed, 21 skipped — `checkout.spec.ts:182`, the **starter's** file |

  `journey.spec.ts` passed **5/5 in every one** of those passes, and five consecutive standalone
  passes besides. The single failure is the starter's, reported with its fix on **#304**.

- **Three flakes found and fixed in this app's own spec**, each one a real defect in the test rather
  than the app:
  - add-to-cart asserted the cart URL on Playwright's 5 s default; it is a server action writing
    through to the core, so it now waits for the button to be enabled and allows 30 s;
  - a sort-link click was dispatched before the page was interactive and silently swallowed;
  - `getByText(productTitle)` resolved to the document's `<title>`, and scoping to `<body>` did not
    help because this app streams metadata into the body (#274) — the order line is now located by
    `getByRole('listitem')`, which also made asserting the quantity natural.
- **An earlier worker cap was reverted.** It was measured while another window was building and
  running Lighthouse on the same machine, so the evidence for it was worthless; the real causes were
  the three test defects above.
- The buy test now requires **10+ units** on the variant it buys and names the shortfall if the seed
  drains, instead of failing as a navigation timeout. Stock measured 2026-10-02: the starter's
  target `alpine-backpack` is at 18 (from ~35); the deepest in the first 20 products is 49.

## 0.5.1 — 2026-10-01 · parked review nits

Housekeeping from the #289 and #291 reviews, built while the shared stack was unavailable. No
behaviour change to the storefront; two real defects in the content and one in a script.

- **The footer repeated every legal page, in both locales.** The "Help" column carried
  `/legal/imprint` and `/legal/returns`, which `legalLinks` already listed. Brand A has no other
  help pages authored, so the column had nothing of its own to say and is gone; a test pins that no
  footer destination appears twice.
- **`seed-content.mjs` now refuses to write without `--yes`.** `createOrReplace` is idempotent with
  respect to the files, which is not the same as safe — it replaces whatever is in the dataset, so a
  re-run silently overwrote an editor's work in the Studio. The destructive path is opt-in and the
  refusal explains itself; `--dry-run` is unchanged.
- **`lastReviewed` no longer implies a legal review.** The field is required by window 6's schema
  and renders as "Last reviewed {date}", which contradicted this app saying the copy is unreviewed.
  It means _last edited in this repository_, now documented in `cms/brand-a/README.md` and asserted.
- **Hero and block CTAs joined the link-resolution walk**, which previously covered navigation and
  footer only while the README claimed "every internal link".
- **The `productStory` block is asserted positively**, not merely checked for absence of its
  "not available" state — which an empty block would have passed.
- **The contrast surface matrix no longer double-counts.** `card` equals `background`, so four of
  twelve generated cases were exact duplicates. Surfaces are de-duplicated by value, with a tripwire
  that fails if the two ever diverge, so the matrix widens on its own instead of under-covering.

## 0.5.0 — 2026-09-30 · task 2.4 (#142, partial — see below)

- **`e2e/routes.spec.ts`** renders public routes in both locales against a real server — 200,
  `<html lang>`, self-referencing canonical, full alternate set. **Local only**; nothing in CI runs
  it. 8 of 22 route renders execute (the four catalogue routes × two locales); the 14 content-route
  renders skip without a seeded Sanity dataset and are **unverified**. This began as a unit test and
  the attempt is recorded in the suite: calling each route's `generateMetadata` in vitest means
  standing in for Next's request scope (`cookies`, `headers`, catalogue, CMS), at which point the
  test renders stubs rather than the app.
- **`test/brand-i18n-seo.test.ts`** (43 tests) keeps what a unit can answer: the route inventory
  **derived from the filesystem** so a new route cannot be silently skipped, the root layout
  emitting the right `<html lang>` per locale, the sitemap module emitting both locales with their
  language maps; **both** message catalogues checked
  for key parity, placeholder parity and actual translation — `src/lib/cms/messages/` was
  unchecked before; JSON-LD priced in **EUR** with minor units converted, `Organization` named from
  `brandConfig`, breadcrumbs absolute and locale-prefixed; the sitemap paging boundary.
  Five falsifying mutations, all red.
- **The `package.json` manifest test is no longer a repo-wide tripwire.** It now asserts only
  self-consistency — the manifest parses and carries the fields the merge reads. The manifest is by
  definition the starter _as of the last sync_, so differing from today's starter is a correct
  state; the freshness question moved to **`node scripts/sync-from-starter.mjs --check`**, run by
  whoever is syncing. Verified both ways and it writes nothing.
- README gained the generated bundle-budget table the re-synced script now requires.
- **#142's first criterion is met only in part**, and is not ticked: route rendering is verified for
  the four catalogue routes in both locales; the seven content routes are unverified for want of a
  seeded dataset. Everything else in that criterion — translation completeness across both
  catalogues, the derived inventory, `<html lang>` per locale — is verified.
- **Two further criteria of #142 are NOT met, and are named:** Lighthouse SEO is **0.92** against a required
  ≥ 95 (sole failing audit `meta-description`, blocked on **#274**), and hreflang is not effective
  on the content routes — in `<body>` where Google ignores it, and absent from the sitemap
  (**#293**). Both are the starter's to fix; both are diagnosed with evidence on their issues.

## 0.4.1 — 2026-09-29 · merge-mode deletions (#288 follow-up)

- **The `package.json` merge now honours deletions.** A key the brand had and the starter did not
  was ambiguous — either the brand added it, or the starter removed it and the brand was holding a
  corpse — so anything deleted upstream survived in every brand forever. Found in the #288 review.
- `scripts/starter-manifest.json` (generated, committed) records the starter's `package.json` at
  each sync. A key present there and absent now was deleted upstream and is dropped; a key in
  neither is the brand's own and stays. **With no manifest nothing is dropped**, because deleting a
  real dependency for lack of evidence is the worse failure.
- Nine tests. The three deletion cases share a paired brand-only assertion, because a merge that
  simply dropped everything brand-only would otherwise pass a deletion test on its own; plus the
  starter-rename case, starter-can-re-add, non-mutation of the record, and a drift check on the
  committed manifest.
- **An identity key is never deleted**, even when the record says the starter dropped it: a starter
  rename of `dev` to `dev:web` looks exactly like a deletion and would otherwise have taken brand
  A's `--port 3101` with it. A key both sides carry stays starter-managed and goes when the starter
  drops it.
- The manifest drift check compares only the key sets the merge actually reads — `scripts` and the
  dependency blocks — never `version`. This file runs in the root `pnpm test` on every PR, so
  comparing whole objects would have turned _other windows'_ branches red whenever window 3 bumped
  the starter version.
- Verified end to end, not only in unit tests: deleting `bundle-budget` from the starter and
  re-syncing drops it from this app while `sync`, the 3101 dev port and the package name survive.

## 0.4.0 — 2026-09-28 · task 2.3 (#141)

- **Real CMS content for brand A**, in `cms/brand-a/content/` — 20 documents, every one in both
  `en-GB` and `de-DE`: the `home` page feeding the storefront's `CmsHome` slot, two content pages
  (`about`, `cloth`), the four EU legal pages (`imprint`, `privacy`, `terms`, `returns`),
  navigation, footer, and the `autumn-cloth` campaign landing. Copy is written to
  `src/brand/DESIGN.md`'s voice; German is genuine prose, not translated-looking English.
- **`cms/brand-a/scripts/seed-content.mjs`** pushes them, reusing `@platform/cms`'s _pure_ exported
  helpers rather than reimplementing credential handling. Documents are validated before anything is
  sent, and `--dry-run` (also the no-credentials path) prints the payload instead.
- **`test/cms-brand-content.test.ts`** (50 tests) is the acceptance criterion: it reads the same
  JSON the seed script does, validates each document against window 6's schemas, and renders them
  through the real route components — `HomeContent`, `pages/[slug]`, `legal/[slug]` and
  `campaign/[slug]`, every document in both locales — with no Sanity credentials, because
  `CmsReader` is an interface. The campaign tests pin the clock, because that route 404s outside
  its schedule and an unpinned test would rot on `endsAt`. It also asserts locale parity, that no German document is a copy of its English twin,
  that every navigation and footer link resolves to an authored document or a real app route, and
  that no route falls back to its empty state.
- The axe suite now scans four content routes too — a legal page in each locale, a content page and
  the campaign landing — skipped unless `CMS_DATASET` is set. They were deliberately absent in 2.2,
  when they were 404s. Note this means CI does not yet run them: nothing sets `CMS_DATASET`.
- **The legal documents are not lawyer-reviewed** and say so in `cms/brand-a/README.md`. No
  registration number, VAT identifier or company name is invented; every such value is a marked
  `[[PLACEHOLDER]]`. The guard scans for anything bracket-shaped and requires it to be well-formed
  (so `[[Register Court]]` and `{{VAT_ID}}` fail), pins the full required set per document kind —
  not just the five §5 DDG fields — and rejects anything resembling a register number, VAT id,
  email, phone number, street address or postcode. It is mutation-tested four ways. The statutory fourteen-day withdrawal period is stated as the law
  requires; brand A's own thirty-day free EU returns are presented as additional to it.
- Corrected the stale claim that this app has no Dockerfile — window 5 delivered it via REQUEST
  #197 and the compose build uses it.

## 0.3.0 — 2026-09-28 · task 2.3 part 1 (#141)

- **Re-synced from the starter** (154 copied, 1 merged, 11 preserved, 4 excluded), carrying in
  **#273's open-redirect fixes** that this app had been missing — `src/lib/safe-path.ts`, the OIDC
  callback and middleware hardening, `src/lib/cms/safe-href.ts` — plus the referral routes, product
  reviews, and the CMS home slots (window 6's REQUEST #178) that 2.3's content will fill.
- **`package.json` is now MERGED rather than preserved** (`scripts/merge-package-json.mjs`).
  Preserve is all-or-nothing: it kept the brand's identity and also froze everything the starter
  added afterwards, which is how this app missed `perf` and `bundle-budget` for a whole task before
  2.2 found the gap by hand. Identity survives (name, version, the 3101 dev port, brand-only
  scripts and dependencies); scripts and dependency versions track the starter.
- `test/sync-merge.test.ts` (13 tests) asserts **both halves** — a starter script arrives, a
  dependency bump arrives, a new top-level field arrives; the brand name, version, dev port,
  brand-only script and brand-only dependency all survive — plus non-mutation, sorted dependency
  blocks, and byte-level idempotency against the real files, so a re-sync produces no diff.

## 0.2.1 — 2026-09-28 · task 2.2 review fixes (#140, PR #280)

Three defects from review, two of which were the code disagreeing with `src/brand/DESIGN.md`.

- **WCAG AA regression fixed.** Stone on the `muted` surface measured **4.36:1** — below AA and
  below the kit default it replaced — in the neutral `Badge` and the CMS hero eyebrow. Stone is now
  `#6B6357`: 5.40:1 on Paper, 4.98:1 on `muted`. Missed because the first tests only checked text
  against the page and Lighthouse audits only the PLP and PDP, where neither component renders.
  The suite now walks **every text token against every surface it can land on**.
- **`input` split from `border`.** A form-field edge identifies a UI component (WCAG 1.4.11, 3:1);
  a divider does not. They shared one value at 1.28:1, leaving every field edge in checkout
  effectively invisible. `input` is now `#8F8676` — 3.28:1 on Paper, 3.03:1 on `muted`.
- **DESIGN/tokens drift closed.** §2 claimed "five, named, and no sixth" while the tokens shipped
  nine hex literals. The document now owns the four derived values (`muted`, `border`, `input`,
  `destructive`) with each one's measured ratio, and a test fails if a colour token ships a hex the
  design does not name. §4 now names `xl`, and the false "a 1px Stone rule" claim is corrected.
- **`radius.full` collapsed to 2px.** Review asked why `Badge` was still a pill: `rounded-full`
  resolves to this token, its only user in `@platform/ui` is `Badge`, and **no avatar component
  exists** — so §4's "kept for avatars" exemption guarded nothing and rounded the one component it
  reached.
- **The display face now actually renders.** Newsreader was loaded but unused: nothing in the kit or
  the starter asks for `font-serif`, so 58 kB shipped to render nowhere while §3 described it
  carrying headings. `src/brand/theme.css` (one rule, element selectors) puts headings on it. Found
  by the new visual baseline — which is what that suite is for.
- **#140's own acceptance criteria**, which the first PR description replaced with its own list:
  - **axe in the e2e suite** — `e2e/a11y.spec.ts`, five pages plus a contrast re-scan of the PDP,
    full WCAG 2.1 A/AA, zero `color-contrast` violations. Local only for now: CI does not run the
    spec until window 2 lands #212's opt-in. Two rules are suppressed with a documented, issue-linked allowlist:
    `dlitem` + `definition-list`, one inherited starter defect (REQUEST #286).
  - **Visual regression snapshots for home/PLP/PDP** — `e2e/visual.spec.ts`, platform-keyed and
    opt-in via `E2E_VISUAL=1`. Tolerance tightened from 0.01 to 0.002 after 0.01 proved loose
    enough to sleep through the entire heading typeface changing.
  - **Dark-mode decision** — a documented no for brand A in Phase 2, with reasons and what would
    overturn it (DESIGN.md §4b).
  - **Favicon / OG defaults** — `src/app/icon.svg` and `src/app/opengraph-image.tsx`, in the brand
    palette rather than the kit's dark neutral, with tests pinning their colours to the tokens.
- README: the repro commands now include the two build steps and the `ROBOTS_ALLOW_INDEXING=1`
  requirement.

## 0.2.0 — 2026-09-25 · task 2.2 (#140)

- **Re-synced from the starter** ahead of the theme: 148 copied, 10 preserved, 4 excluded. Brings
  in storefront 2.2-2.4 (SEO/JSON-LD/sitemap/robots, CSP, perf + bundle budgets, the `(content)`
  campaign and legal routes, Cloudinary media) and **#254's `src/brand/config.ts`**.
- **Brand A's design**, authored in `src/brand/DESIGN.md` — no Figma exists, so the document is the
  design and is written before the code. Calm editorial D2C apparel; explicitly not the admin's
  dark Medusa rail and not the generic AI storefront.
- **Palette**: five named values — Paper `#F7F4EF`, Ink `#23201B`, Clay `#9C4A32`, Sage `#5F6B57`,
  Stone `#746C60`. Every pair measured against WCAG 2.1; Stone was darkened from `#7A7266` after it
  measured 4.32:1. Primary is Ink, not the accent.
- **Type**: Newsreader over Hanken Grotesk, self-hosted as Latin-subset woff2 under
  `src/brand/fonts/` (OFL 1.1, licences beside them) and loaded with `next/font/local` — the build
  stays hermetic and no page view reaches `fonts.gstatic.com`. Newsreader ships weight-only: the
  optical-size axis costs 74 kB on a face that only sets headings.
- **Shape**: radius collapses to 2px, all four shadow tokens to `none`.
- Fonts are wired through `tokens.ts`, not a component slot — the checkout and account layouts
  render no `Header`, so a slot-injected font would drop out at checkout. Verified in the build
  output and the served HTML, not assumed (DESIGN.md §5).
- `brandConfig` names the brand (**Fieldnote**) and its description, so the title template and
  Open Graph tags land in `<head>` without an API round trip (#254's mechanism).
- **New** `test/brand-theme.test.ts` (21 tests): recomputes every contrast ratio DESIGN.md
  publishes from the tokens that actually ship, asserts the shape/type tokens, and asserts the
  faces are loaded from local woff2 rather than a CDN. `next/font/local` is mocked — it is a
  build-time transform with no runtime implementation.
- Added the `perf` and `bundle-budget` scripts and pinned `@lhci/cli` to 0.14.0, matching the
  starter: `package.json` is on the PRESERVE list, so it had silently missed them.
- `test/slots.test.ts` temporarily deviates and is preserved on sync — the starter's copy asserts
  this brand's override files are empty, which is false by construction in a clone (REQUEST #278).
- Measured on a production build: performance 0.99 / 0.97 — **superseded, see 0.2.1**, which
  re-measured 0.96 / 0.96 after the review fixes — accessibility **1.00**, SEO 0.92,
  CLS 0.0000 / 0.0001 (PLP / PDP); bundle budget green on all seven routes.

## 0.1.0 — 2026-09-09 · task 2.1 (#139)

- Generated from `apps/storefront-starter` 0.8.1 (ADR 0004) via the new
  `scripts/sync-from-starter.mjs`: 110 tracked starter files copied; `Dockerfile` (window 5's
  path — REQUEST filed for the image), `README.md`, `CHANGELOG.md` and `CLAUDE.md` excluded.
- Brand A identity: package name, port **3101** (`dev` script, `start.mjs` default — `start`
  still honours `$PORT` for the image contract), `SITE_URL` and `STORE_PUBLISHABLE_KEY`
  (`pk_brand-a_dev_00000000000000000000`, the packages/db seed key) as runtime defaults in
  `next.config.mjs`, Playwright/Lighthouse URLs on :3101. `KEYCLOAK_CLIENT_ID` keeps the
  starter's `storefront-brand-a` default. `/health` inherited.
- The complete diff-against-starter list lives in the README and is enforced by the sync
  script's preserve/exclude sets.
