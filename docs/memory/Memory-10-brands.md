# Memory 10 — Brand storefronts (A, B, C…)
Window: 10 · Key: `brands` · Branch prefix: `brands/` · Model: Sonnet
Last updated: 2026-10-06 · Contracts: contracts-v0.4.11 · Branch: `brands/phase3` (from main 1280fe6) · Status: **INTEGRATION 2a** — Phase 2 closed (#139–#144); working the manager's 2a docket (#374, then #372's brand A half, then #348).

## Identity (does not change)
Owned paths (write):
- `apps/storefronts/<brand>/**`
- `cms/<brand>/**`
Reads:
- packages/ui
- apps/storefront-starter (read only)
Never touches:
- the starter
- other brands

## Mission — Phase 2 (Commerce complete, brand 1 live)
Brand A real storefront from the starter: theme/layout from Figma, real CMS content, checkout polish, SEO, i18n, full Playwright e2e browse → buy → account. Wave C — starts when cms 2.2 and core 2.2 have merged.

## Done
- **#374 · the buy test's order total** — `apps/storefronts/brand-a/e2e/journey.spec.ts`. It asserted
  `order total == cart total + delivery row`, which silently claimed delivery is untaxed; #352 (PR
  #373) taxes delivery at the goods' rate, so the core answered 2661 where the spec demanded
  2057 + 499 and #373's live job went red on a correct app. **Now the confirmation is compared with
  the REVIEW STEP** — `completeCheckout()` captures the review step's totals with the existing
  `captureOrder()` before clicking *Place order* and returns them (its old `string[]` return was
  unused at both call sites); total, lines and currency are asserted equal. Both sides are read off
  the page in minor units, so it passes on today's main and after #373 with no edit either way. The
  cart stays only as a lower bound; the delivery row is still asserted present;
  `completeCheckout()` now throws if the review step never rendered, which would otherwise have left
  the comparison vacuous and green. CHANGELOG + README updated. Gates: lint clean, typecheck clean,
  unit **687 passed / 2 skipped**, mock e2e **83 passed / 30 skipped** (exit 0) — `journey.spec.ts`
  skips on the mock by design, so **the live job on the PR is the proof**; the pattern it adopts is
  the one `checkout.spec.ts:52` already runs green against the mock. **Machine free** (no core, no
  Keycloak, no docker — Playwright started and stopped the Prism mock and the app itself).
  - **Reported, not edited (window 3's file):** `apps/storefront-starter/e2e/checkout.spec.ts` does
    **not** share the assumption — it already does `expect(placed.totalMinor).toBe(reviewed.totalMinor)`
    at :159. A case-insensitive sweep for arithmetic on money (`grep -i minor` filtered to lines with
    `+`/`-`) found **no** other site in the starter's suite or brand A's: `journey.spec.ts:405-411`
    was the only one in the repo. Nothing is owed to window 3.
- **#144 · 2.6 launch checklist** — `apps/storefronts/brand-a/LAUNCH.md`, PR #340 MERGED as 976fe99;
  #144 CLOSED by the manager with a recorded waiver (the staging dry run becomes an Integration 2 /
  Phase 3 gate). 11
  areas, each item with owner window + verification command/URL + state on 2026-10-05; the two
  gates waived from #142 (content routes on staging, Google Rich Results); owner actions
  (Cloudinary upload, 48 legal placeholders + lawyer review, consent decision). Staging dry run
  NOT possible (no deployed environment; brand A not in the deploy matrix). Laptop dry run: 10
  checks, all passing, recorded in the file.
- **Re-sync with #312/#326/#327 + three clean passes** — PR #337, merged as 8690267. **#142 and #143
  CLOSED.** 91 passed / 0 failed / 22 skipped ×3 against the core; order #1123 linked at placement
  (read-only query). Unit tests at the merge: **687 passed, 2 skipped**.
- **Imagery** — PR #335, merged as 013da4a; the review carry-overs (cloud-name validation, upload
  hashes the bytes it sends) rode in #337.
- **#143 order history against the core** — PR #333, merged as 96aeb19.
- **Re-sync PR #328** (MERGED as 444ee6b, Refs #142) — commits **466213e** (re-sync from the starter at main
  4c4aa80; the four preserved files rebuilt from the starter; `SITE_URL` no longer defaulted;
  #274 placement pin and `STATIC_PATHS` pin replaced by real assertions), **697af36** (preserved-file
  drift report: `scripts/preserved-drift.mjs`, `scripts/starter-preserved.json`, 5 tests; REQUEST
  #326), **a67972f** (SEO measured; placement check case-insensitive; content routes gated on
  `CMS_DATASET`). Measured on main d335979: **SEO 1.00 worst-of-three** on home/PLP/PDP/de-DE PLP
  (12/12 runs 1.00), hreflang in `<head>` 280/280 raw-byte checks, sitemap 422 URLs with alternates.
  **Flake check FAILED: 84/3, 87/0, 82/5** (22 skipped each) — picsum through the optimiser +
  `networkidle`, REQUEST #327 (decided: window 3 serves a local placeholder and drops networkidle).
  gitleaks flagged a blob id in starter-preserved.json — false positive, allow-listed on main 2a0f828.
- **#143 · 2.5 e2e browse → buy** — PR #301 (de3e9ef), MERGED (f999f78).
  `journey.spec.ts`: PLP sort (asserts real ordering), category filter (page handles ⊆ API's
  category handles), PDP variants, and a placed order tied to the cart — quantity from the cart's
  `<input name="quantity">`, and `order total == cart total + the Delivery row` in **minor units**.
  Proven by mutation: doubled quantity RED, dropped Delivery row RED (`order 2556 != cart 2057 +
  delivery 499`), loose "any price" RED; float-vs-minor-units GREEN and reported as defensive
  rather than proven. Three bounded full passes on a quiet machine (34/34, 34/34, 33+1 — the 1 in
  the **starter's** `checkout.spec.ts:182`, routed as #304).
- **#142 · 2.4 SEO + i18n (partial)** — **MERGED** as PR #294, merge commit db8aa80. #142 was
  auto-closed by a commit keyword and the manager reopened it — never put close/fix/resolve next to
  an issue number unless that commit finishes it. 49 tests: routes x both locales (canonical,
  alternates, x-default), BOTH message catalogues (cms one was unchecked), JSON-LD in EUR,
  sitemap paging. 5 mutations red. Manifest tripwire replaced with self-consistency +
  `sync-from-starter.mjs --check`. Measured perf 0.97 / a11y 1.00 / SEO 0.92 / CLS ~0.
  REQUEST #293 filed.
- **Merge-mode deletion fix** — PR #291 (2032082). `scripts/starter-manifest.json` records the
  starter's package.json per sync, so a key deleted upstream is dropped instead of surviving
  forever. No manifest = nothing dropped (conservative). 8 paired tests + end-to-end proof.
- **#141 · 2.3 CMS content** — **MERGED** as PR #289, merge commit 1a44b04. — 20 documents in `cms/brand-a/content/` (home, about, cloth, 4 EU
  legal, nav, footer, campaign), **all in en-GB + de-DE**. Seed runner reuses @platform/cms's pure
  helpers; validates before sending. `test/cms-brand-content.test.ts` (43 tests) renders them
  through the real routes with no Sanity credentials. Legal copy uses `[[PLACEHOLDER]]` for every
  statutory value and is **not lawyer-reviewed** (flagged in cms/brand-a/README.md). Stale
  Dockerfile claim corrected (carried nit #3 — done).
- **2.3 part 1 (MERGED as #288, 44c57cf) — re-sync + package.json MERGE mode** — commits f682dde (re-sync: #273's
  open-redirect fixes, referral, reviews, CMS home slots) and the merge-mode commit. `package.json`
  is no longer PRESERVEd but merged: identity survives, scripts/deps track the starter.
  13 tests assert both halves + byte-level idempotency. Root gate green (397 tests).
- **#140 · 2.2 Brand A theme** — **MERGED** as PR #280, merge commit 8c49bd4. — DESIGN.md authored first (no Figma), then implemented to it.
  Five measured colours, Newsreader + Hanken Grotesk self-hosted via `next/font/local` from
  `src/brand/fonts/`, radius 2px, shadows none, `brandConfig` = Fieldnote. 21 new tests in
  `test/brand-theme.test.ts` recompute every published contrast ratio. Measured on a production
  build: perf 0.96/0.96, **a11y 1.00**, SEO 0.92, CLS 0.0000/0.0001; bundle budget green ×7.
  REQUEST #278 + #283 filed. Root gate green (lint, format, typecheck 21/21, 332 tests, ownership
  OK). PR #280, 13/13 CI green — but the perf check among them is vacuous (#283).
- **Re-sync brand-a from the starter** — commit e44d87d (prerequisite for 2.2). 148 copied,
  10 preserved, 4 excluded; brought in storefront 2.2-2.4 (SEO/JSON-LD/sitemap/robots, CSP, perf +
  bundle budgets, (content) campaign/legal, Cloudinary) and **#254's `src/brand/config.ts`**.
  Verified: typecheck clean, 312/312 unit tests green.
- **#139 · 2.1 Clone the starter into apps/storefronts/brand-a** — commit 59d4830. Clone via `apps/storefronts/brand-a/scripts/sync-from-starter.mjs` (110 starter files; excludes Dockerfile/README/CHANGELOG/CLAUDE.md; preserves identity files + `src/brand/**` on re-sync, `pnpm --filter @platform/storefront-brand-a sync`). Identity: port 3101, `SITE_URL`/`STORE_PUBLISHABLE_KEY` (`pk_brand-a_dev_00000000000000000000`) as `??=` runtime defaults in next.config.mjs, path-depth fixes in tsconfig/tailwind/playwright. Verified: build green, `/health` 200, PLP/PDP/de-DE 200 against the mock, 184 unit tests, root lint+typecheck+format green, `diff -rq` vs starter = exactly the README's documented list. REQUEST #197 filed to window 5 (Dockerfile + image manifest; the `check-image-manifests.sh` CI failure on this PR is the intended prompt).

## In progress — Integration 2a, the manager's docket (opened 2026-10-06)

Branch `brands/phase3`, cut from `origin/main` 1280fe6 (≥ 4e03a81, contracts-v0.4.11), with the
Phase 2 memory commit carried across by cherry-pick. Rules for 2a: merge main before pushing, one PR
per task, **hold each push until the manager confirms the previous merge**, no docker, long runs
detached to a file with bounded polls, say "machine free" after any core run.

1. **#374 — DONE locally, PR open.** See Done below.
2. **#372, brand A's half** — order status asserted after ship/deliver. Window 3 does the starter
   first; I align by sync, so **wait for the starter's version to land** rather than writing it twice.
3. **#348** — decide with data: ten runs of LCP for brand A's PLP and PDP are on the issue and in the
   perf logs. A decision task, not a measurement task — read the numbers that already exist before
   running anything, and remember that a measurement run has to be driven in-turn
   ([[laptop-standby-voids-background-runs]]).

## Phase 3 onboarding — gaps recorded at the end of Phase 2
For whoever starts the next brand, or takes brand A live. Details and verify commands are in
`apps/storefronts/brand-a/LAUNCH.md`.
- **No deployed environment exists.** Staging is coded (Terraform, Helm, ArgoCD) but never applied;
  AWS/ArgoCD credentials are missing. Brand A is absent from `deploy-staging.yml` (`APPS: core admin
  storefront-starter`), the Terraform `apps` list (no ECR repo) and the Helm values (window 5).
  The starter's `values-staging.yaml` carries brand A's dev publishable key.
- **Payments:** checkout offers only the `manual` provider. Stripe hosted fields are window 7/3's;
  live keys are refused by design in Phase 2.
- **Search:** shopper search is a database ILIKE; the Algolia index exists in code (window 9) but
  nothing deploys or schedules it.
- **Consent:** `sf_attribution` (30 days) is set without a consent gate, and there is no banner; this
  needs an owner/lawyer decision first.
- **Monitoring:** no alert rules, no error tracking in the storefront, and `/health` reports
  `"app":"storefront-starter"` (starter's, window 3).
- **Legal:** 48 placeholders (19 distinct), not lawyer-reviewed. A "no `[[` left" launch gate is
  missing (window 10, Phase 3).
- **Media:** no Cloudinary account (paid plan needed: 18/19 stills > 10 MB); hero loops wait on #330.
- **CMS:** no Sanity project locally, so content routes are never runtime-tested; `CMS_DATASET` is
  set nowhere in CI.
- **Process lessons:** diff every preserved file on each sync (the drift report does this since
  #328); rebuild the workspace packages after every merge of main; never `String.replace` with `$`
  in replacement text (it duplicated a file once). Write multi-line edits as a script file.
- **Never let a spec do arithmetic on money** (#374). Adding rows up restates the core's pricing
  rules in a file that does not own them, so the spec breaks the day pricing changes — and it breaks
  *as a red test on correct code*, which costs another window their merge. Compare two pages the app
  rendered instead. `captureOrder()` in `e2e/support/journey.ts` already returns totals in minor
  units for exactly this; the cart, the review step and the confirmation all carry the hooks.
  Corollary: when a comparison's other side is captured elsewhere, assert it was actually captured —
  a vacuous comparison is green.

## RESUME HERE (the exact sequence, in order)

1. ~~Phase 2 tasks 2.1–2.5~~: all merged; #139–#143 closed.
2. ~~#144 (2.6)~~ — merged as 976fe99, closed with a waiver. The staging dry run is an Integration 2 /
   Phase 3 gate. LAUNCH.md's findings go to the owner and the Integration 2 plan as they stand.
3. **Integration 2a (current)** — the manager's docket, in "In progress" above: #374 (done, PR
   open), then #372's brand A half (after the starter's), then #348 (decide from the LCP numbers
   already on the issue). Push only after the manager confirms the previous merge.
4. Phase 3 proper: start from "Phase 3 onboarding — gaps" above and LAUNCH.md's owner actions.

### Machine recipe that works (verified 2026-10-02)
```
fga:seed                 pnpm --filter @platform/auth-sdk fga:seed     # OpenFGA is in-memory
core  :9000              set -a && . ./.env && set +a; PORT=9000 CORE_DEV_TOKENS=1                          CORE_STORE_API_FALLBACK=1 CORE_STORE_API_FALLBACK_URL=http://127.0.0.1:4010                          pnpm --filter @platform/core exec tsx src/server.ts
brand :3101              PORT=3101 STORE_API_URL=http://127.0.0.1:9000 SITE_URL=http://localhost:3101                          ROBOTS_ALLOW_INDEXING=1 pnpm --filter @platform/storefront-brand-a start
e2e                      E2E_REQUIRE_CORE=1 E2E_REQUIRE_KEYCLOAK=1 E2E_STORE_API_URL=http://127.0.0.1:9000                          pnpm e2e --max-failures=1 --global-timeout=360000   (always bounded)
```
The DB needed no migrate/seed (51 tables, 3 stores, 607 products). **Stop :9000 and :3101 when
done** and say the machine is free. Never `docker exec`; never touch the stack without the
manager's OK.

## Blocked — infrastructure
- (resolved 2026-10-01) **The shared Docker daemon was DOWN** (2026-10-01). `docker version` → server UNREACHABLE, API 500
  on `/v1.54/version`; 5433/6381/8180/8081/9000/9092 all closed. Confirmed from the manager window;
  their "stack is healthy" was stale. **The owner restarts Docker Desktop and the manager brings the
  containers up** — I do not run the recovery, even though [[stack-interventions-need-prior-ok]]
  records one as pre-approved: the manager's current instruction named `wsl --shutdown` as
  stop-and-ask, and a standing pre-approval does not outrank a current instruction.

## Blocked on other windows — resolved (kept for history)
- ~~#274~~ (metadata in `<head>`) fixed by #299; ~~#293~~ (sitemap content routes) fixed by #322; both
  verified in #328. ~~#212~~ MERGED (871f086). #142 closed with #337.
- **#295** (window 5): brand A's e2e in CI. Still open on 2026-10-05; it is LAUNCH.md item 11.4.

## Carried nits
### From the #291 review
- ~~idempotency test passes two args~~ — DONE in the #294 fixes: it merges from the manifest.
- **STILL PARKED, with a reason**: nothing tests that `sync-from-starter.mjs` forwards
  `previousStarter`. The script resolves the starter path relative to itself, so testing the wiring
  needs an env override or a subprocess against a fake tree — more machinery than the risk warrants.
  The composition *is* proven end to end by hand (delete `bundle-budget` upstream, re-sync, it goes).
  Do it properly if the script grows a second caller.
- ~~CHANGELOG "eight tests, each pairing" overstated~~ — fixed in 0.4.1.

### From the #289 review (parked — do in 2.4 or a cleanup PR)
- ~~`productStory` never asserted positively~~ — DONE (cleanup PR).
- ~~hero/campaign CTA hrefs outside the link test~~ — DONE (cleanup PR).
- ~~`lastReviewed` vs "unreviewed"~~ — DONE: it means *last edited here*, documented in
  cms/brand-a/README.md and asserted.
- ~~Impressum footer link doubled per locale~~ — DONE: `/legal/returns` was doubled too; the Help
  column repeated what `legalLinks` already carried, so it is gone and a test pins no-duplicates.
- **`CMS_DATASET` is set nowhere in `.github`**, so the content axe scans never run in CI.
- `seed-content.mjs` without `--dry-run` overwrites Studio edits with no confirmation — add one.
- The en-GB imprint cites German statutes (a lawyer item, not mine — carry to the legal review).

### From the #288 review
- ~~**Merge mode cannot REMOVE.**~~ DONE in PR #291.
- (was) **Merge mode cannot REMOVE.** A script or dependency the *starter deletes* looks brand-only to
  `mergeRecord` and survives in the brand forever. Needs either a documented limitation or a
  deletion test + rule (e.g. track the previous starter manifest). Not yet decided.
- **Precision in the record**: "root gate 397 tests" in #288 was *brand-a's suite alone*, not the
  repo. Say which suite when quoting a count.
- ~~**Stale Dockerfile claim**~~ — DONE in the 2.3 content PR.
- (superseded, kept for the trail) **Stale Dockerfile claim**: README's diff table + CLAUDE.md + this memory say "no Dockerfile in
  this app / absent". **Window 5 delivered it** — `apps/storefronts/brand-a/Dockerfile` exists and
  `infra/docker/docker-compose.build.yml` builds `storefront-brand-a` from it; REQUEST #197 is
  CLOSED. Correct in passing with the content PR.

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#139 · 2.1** Clone the starter into apps/storefronts/brand-a — MERGED (#198)
- [x] **#140 · 2.2** Theme and layout overrides from the brand design — MERGED (8c49bd4)
- [x] **#141 · 2.3** CMS content for brand A — MERGED (1a44b04)
- [x] **#142 · 2.4** SEO and i18n for brand A — CLOSED by #337 (8690267); two gates waived to #144
- [x] **#143 · 2.5** End-to-end suite browse → buy → account for brand A — CLOSED by #337 (8690267), 91/0 ×3
- [x] **#144 · 2.6** Launch checklist for brand A — CLOSED (PR #340, 976fe99; staging dry run waived to Integration 2)

## Decisions made (with reasons)
- **Brand A is designed here, not in Figma** (2.2): no Figma exists. `src/brand/DESIGN.md` is
  written before the code and the code is held to it. Calm editorial D2C apparel; five named values
  (Paper #F7F4EF, Ink #23201B, Clay #9C4A32, Sage #5F6B57, Stone **#6B6357**), all pairs measured
  against WCAG (Stone failed twice: #7A7266 at 4.32:1 on Paper, then #746C60 at 4.36:1 on `muted` — now #6B6357, 5.40 / 4.98). Newsreader + Hanken
  Grotesk, self-hosted. Explicitly not the admin's dark Medusa rail and not the AI-default look
  (no purple gradients, glassmorphism, floating cards, stock hero).
- **Fonts are wired through `tokens.ts`, not through a component slot** (2.2): the only
  always-present slots are `Header`/`Footer`, and the checkout and account layouts render neither —
  a font injected from a slot would drop out at checkout. `tokens.ts` is imported by the root
  `[locale]/layout.tsx`, so the CSS `next/font` emits for it is linked from `<head>` on every route.
- **Brand identity lives in `next.config.mjs` runtime defaults (`??=`), not src edits** (2.1): `next build/dev/start` all load the config before app code, the environment still wins, and `src/**` stays byte-identical to the starter (except `src/brand/**`) so `sync-from-starter.mjs` re-syncs produce reviewable diffs. `KEYCLOAK_CLIENT_ID` needed no override — the starter already defaults to `storefront-brand-a`.
- **The sync script is self-hosting and lives in the brand app** (`scripts/sync-from-starter.mjs`): the starter stays untouched (window 3's path), and Phase 3's "scripted re-sync" (ADR 0004) exists from day one — preserve list = the README's documented diff table.
- **No Dockerfile *authored* in the brand app**: `**/Dockerfile` is window 5's ownership row, so
  the clone still excludes it from the sync. REQUEST #197 is now CLOSED — window 5 delivered
  `apps/storefronts/brand-a/Dockerfile` and the compose build entry, so the file exists and is
  theirs to maintain. The README/CLAUDE.md wording saying it is "absent" is stale (carried nit).

## Blocked / waiting
- Nothing for #142/#143 beyond the manager's review of the re-sync PR.
- ~~REQUEST #278~~ resolved upstream; ~~#212~~ MERGED (871f086). Brand e2e in CI remains REQUEST #295 (window 5).

## Gotchas
- **After every merge of main, rebuild the workspace packages before starting a core**
  (contracts, auth-sdk, db, events, cms, ui). A stale dist looks like a product bug: on 2026-10-03
  auth-sdk/dist predated 944d217, so every token read as unverified and order history came back empty.
- Kafka for this project is Redpanda on **19092** (healthy); 9092 is not ours.
- Machine recipe: start brand A with `.env` sourced too, or the CMS is unconfigured. `gh` can
  hang: `GH_PROMPT_DISABLED=1` + `timeout`, kill gh.exe if stuck.
- **PRESERVED files never receive starter fixes.** The 2026-10-03 re-sync found next.config.mjs,
  src/brand/config.ts, playwright.config.ts and lighthouserc.json all behind (missing #274's
  htmlLimitedBots, #320's fail-closed siteUrl, the e2e readiness server). Diff every preserved
  file against the starter on every sync.
- `e2e/support/build-origin.ts` (starter) defaults SITE_URL to :3100; brand playwright config
  sets `process.env.SITE_URL` from APP_URL before workers start. learned
- **"Against the real stack" is a per-route claim, not a mode.** With `CORE_STORE_API_FALLBACK=1`
  the core proxies what it does not mount. Browse + cart reach the core; `/store/customers/me` and
  the `/store/orders` LIST are Prism (#303). This false claim survived three review rounds in three
  different files — check body, README, CHANGELOG **and** the memory file, and grep before pushing.
- **The cart and the order render quantity differently.** The cart has an editable
  `<input name="quantity">`; the order line has `× N` text. An assertion written for one silently
  returns null against the other.
- **Playwright's 5 s default is too tight for a server action** that writes through to the core.
  Add-to-cart and sort-link clicks need an explicit timeout and a wait for interactivity, or they
  flake ~1 run in 3. Fixed here, reported for the starter on #304.
- **A mutation that stays GREEN is a result, not a failure to report.** Removing the minor-units
  rounding did not break anything, because those amounts are exact in float — so the rounding is
  defensive, not load-bearing, and saying so is the honest record.
- **Never run an e2e suite unbounded.** Always `--max-failures=1 --global-timeout=<ms>` and a shell
  `timeout`. An unbounded three-pass run went 29 minutes before the owner stopped it.
- **A measurement taken while another window is building is not evidence.** My "suite contends with
  itself, cap workers at 2" conclusion was measured while window 3 ran a build + Lighthouse on the
  same machine. The cap was reverted. Ask whether the machine is quiet BEFORE a timing measurement.
- **Read one failing test's actual error, not the failure count.** Every failure in those runs was
  `Test timeout exceeded`, never an assertion and never out-of-stock — which rules out whole classes
  of cause immediately.
- **Running against the core does not mean the core answers.** With `CORE_STORE_API_FALLBACK=1` it
  proxies what it does not mount: `/store/customers/me` and the `/store/orders` LIST are Prism
  (#303), so `account.spec.ts`'s identity and order-history assertions prove nothing about the core.
  The core does answer `/store`, `/store/products*`, `/store/carts*` (real UUID) and
  `/store/orders/{id}`. Check per route before claiming "against the real stack".
- **e2e that places orders consumes a SHARED seed.** The starter's checkout spec took its target
  from ~35 units to 18. Pick by property including a stock floor, and say the run budget out loud.
- **The Store API's product LIST is a summary projection with no `variants`** — counting variants
  from it reports zero for every product and looks like a seed gap. Ask for each product's DETAIL.
  This nearly had me file a bogus `REQUEST: seed — multi-variant product`; the catalogue has plenty
  (Size:4 × Color:2, 8 variants).
- **Variant options are `<fieldset>` + toggle `<button aria-pressed>`, not ARIA radios**, and the
  PDP price is `data-testid="price-value"`. The listing card renders its title as a link INSIDE an
  `<h3>` — "a link containing a heading" matches nothing.
- **After "Add to cart" the app navigates to the cart itself** — `page.goto('/cart')` races the
  pending server action and lands on an empty cart. Wait for the URL instead.
- **Metadata placement is deterministic server-side and nondeterministic in the DOM.** 60/60
  requests put it in `<body>`, but React sometimes hoists it at hydration, so a DOM-based assertion
  flakes ~1 run in 5. Assert the served bytes. This is probably the real mechanism behind #274's
  "fails on runs 2 and 3" Lighthouse flake.
- **Always close a pg client in `finally`.** A probe that closed only on the happy path hung for
  15+ minutes with no output and had to be killed. Give direct DB commands a hard timeout.
- **A closing keyword next to an issue number closes the issue on merge**, even mid-sentence in a
  commit body ("a follow-up closes #142"). It cost the manager a manual reopen. Write "#N stays
  open; a follow-up PR finishes it".
- **`/tmp` differs between the Bash tool and Python on Windows** — a bash redirect to `/tmp/x` is
  invisible to `open('/tmp/x')`. Nearly made me write an unedited PR body back over itself. Use the
  scratchpad path for anything both touch.
- **An e2e suite that skips without its backend must be proven to FAIL when the backend is
  required**, or "skips cleanly" is indistinguishable from "never runs". `E2E_REQUIRE_CORE=1` +
  core down → exit 1 is that proof.
- **`bundle-budget --sync-readme` fills an EXISTING `<!-- bundle-budget:start/end -->` block; it
  does not create one.** After a re-sync adds that requirement, add the markers to the README by
  hand once, then run it.
- **Check a starter helper's real signature before writing a fixture for it.** `breadcrumbJsonLd`
  takes `(crumbs, env)` and already-localised paths; `productJsonLd` reads `attributes`,
  `brand_name`, `category` and guards with `=== null`, so an absent field throws.
- **Never probe one-line HTML with `sed -n '1,/<\/head>/p'`** — the whole document is line 1, so the
  range prints everything and any `grep -c` after it is a false pass. Compare byte offsets. This
  produced a wrong "server is fine" conclusion in the #274 diagnosis before I caught it.
- **hreflang outside `<head>` is ignored by Google.** Metadata landing in `<body>` is not only a
  Lighthouse point; it silently voids a multi-locale setup.
- **A test in a brand app runs in the ROOT `pnpm test` on every PR in the repo.** An assertion that
  compares against another window's file (the starter's `version`) turns *their* PRs red. Assert
  only the properties your code actually depends on.
- **A rename upstream is indistinguishable from a deletion** when you only record names. Identity
  keys must win over the deletion record, or a starter rename silently drops brand identity.
- **Write the falsifying mutation BEFORE claiming a guard works** (manager will hold future PRs to
  this). Three of mine were vacuous: a hardcoded hex Set, a 1% visual tolerance, a placeholder regex
  that matched then re-asserted the same pattern. The shape is always *asserting a property of
  things already selected for having it*. Pair every "X is removed" test with "Y survives".
- **An apostrophe inside a single-quoted JS string written via a bash heredoc breaks the parse** —
  `'` arrives literal. Reword instead.
- **Python `` in a non-raw string is a backspace, not a word boundary.** Three landed inside
  regex literals and ESLint's `no-control-regex` caught them. Use raw strings for regex text.
- **Do not invent the strings a test asserts absence of.** The 2.3 empty-state check guessed
  fallback text and collided with real copy ("Nothing here is designed to be replaced…"). Read the
  route's own message catalogue, and guard that the list is non-empty or every `not.toContain`
  passes vacuously.
- **Author the nav last, or test that links resolve.** The first 2.3 draft linked to four pages that
  did not exist. The link-resolution test is cheap and catches it.
- **`cms/<brand>/` is inside window 6's package dir but is my path.** It is outside `cms/tsconfig`'s
  include and outside the package `exports`, so content is JSON read from disk, not an import.
- **`toEqual` on parsed JSON ignores key order.** The merge-mode idempotency test passed while the
  real sync reordered a script. If the artefact is a file a reviewer diffs, assert the bytes.
- **vitest does not typecheck.** `pnpm --filter … test` was green while the root `pnpm typecheck`
  failed on an unused `@ts-expect-error`. Always run the root gate before committing.
- **Test every text token against every SURFACE, not just the page.** 2.2 shipped Stone at 4.36:1 on
  `muted` (Badge, CMS hero eyebrow) while passing on Paper. Lighthouse audits only PLP/PDP and
  scored a11y 1.00 straight through it. A per-page score is not palette coverage.
- **`border` and `input` are not the same job.** A field edge identifies a UI component (WCAG
  1.4.11, 3:1); a divider does not. The kit shares one light value for both — brand A does not.
- **A doc that praises what the code no longer does is a defect.** Three of 2.2's review findings
  were DESIGN.md claims the tokens contradicted (no-sixth-colour, the Stone rule, the avatar
  exemption). When changing a token, re-read the paragraph that justified it.
- **Setting a font token does not render the font.** Nothing in the kit/starter uses `font-serif`,
  so Newsreader loaded and styled nothing. `src/brand/theme.css` (imported from tokens.ts) is the
  brand-owned hook for element-level rules; global CSS imports DO work from any App Router module,
  but a separate file gets no `@tailwind` directives, so no `@layer`.
- **A visual-regression tolerance of 1% sleeps through a whole typeface change.** Use 0.002.
- **Read the issue's own acceptance criteria before writing the PR description.** 2.2 substituted a
  self-authored list and missed four required items.
- **The CI perf gate never runs for brand storefronts — it reports a vacuous pass in ~4 s.**
  `infra/ci/changes.sh:98` matches `apps/storefront-starter/`, not `apps/storefronts/`; and even
  when it fires, `ci.yml:229` runs `--filter @platform/storefront-starter perf`, so a brand's own
  `bundle-budget.json` / `lighthouserc.json` (:3101) are never read. REQUEST #283. **Until it
  lands, measure by hand at every brands task and quote the numbers in the PR** — do not read that
  green check as evidence. Verify a classifier claim by running it:
  `CHANGED_FILES="<paths>" bash infra/ci/changes.sh`.
- **`next/font/local` is a build-time transform with no runtime implementation.** Any vitest test
  that reaches `tokens.ts` must `vi.mock('next/font/local')`, and the import of the module under
  test has to be a dynamic `await import` so the mock is in place first.
- **`next/font` emits `<link rel="preload">` only when a `className`/`variable` is rendered.**
  Reading `.style.fontFamily` gets the @font-face CSS (in the root layout's chunk, so on every
  route) but no preload. Measured cost: CLS 0.0000 — the size-adjusted fallback absorbs the swap.
- **SEO scores ~0.58 locally until `ROBOTS_ALLOW_INDEXING=1`** — `/robots.txt` fails closed and
  returns `Disallow: /`. With it set: 0.92. Not a defect; do not chase it as one.
- **The PRESERVE list silently withholds new starter scripts**: `package.json` never takes them, so
  brand-a had missed `perf` and `bundle-budget` entirely. Diff the two package.json files after
  every sync.
- Newsreader's optical-size axis doubles the file (132 kB vs 58 kB weight-only). Check a variable
  font's axes before vendoring it.
- The clone drifts behind the starter fast (53 commits by 2.2). **Re-sync before any brand work**,
  commit the re-sync on its own, then build the brand change on top — a mixed commit is unreviewable.
- `Announcement` renders *inside* the default `Header` (`src/layouts/defaults.tsx`), not at the root,
  so it is not a document-wide injection point.
- The clone sits one directory deeper than the starter: `tsconfig.json` `extends`, `tailwind.config.ts` ui-dist glob and `playwright.config.ts` webServer `cwd` each need one more `../` — a byte-identical copy fails `next build` with TS5083 on `tsconfig.base.json`.
- Backgrounded `&` children of a Bash call can outlive the call (a stray Prism held :4010 and made the next `pnpm mock` die with EADDRINUSE while probes returned 401 = actually up). Check the port before assuming the mock is down.
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package
- `pnpm --filter "@platform/storefront-brand-a^..." build` once per fresh worktree (ui/cms/contracts dists), then `pnpm --filter @platform/storefront-brand-a build|start|dev|test|typecheck|e2e`. Mock: `pnpm mock` (:4010). App on :3101; `/health`. Against the core: `STORE_API_URL=http://localhost:9000` (core with `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010`).
- Re-sync after merging main: `pnpm --filter @platform/storefront-brand-a sync`, review the git diff.

## Later phases (do not start until Memory-main says so)
### Phase 3 — Multi-store & HQ
Brands B and C the same way, using the onboarding flow; document what still needed a developer.
- [ ] Brand B
- [ ] Brand C
- [ ] Onboarding gaps report
