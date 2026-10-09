# Memory 10 — Brand storefronts (A, B, C…)
Window: 10 · Key: `brands` · Branch prefix: `brands/` · Model: Sonnet
Last updated: 2026-10-08 · Contracts: contracts-v0.4.12 · Branch: `brands/phase3` (at main 2e35674) · Status: **ALL MERGED, nothing open (2026-10-08).** #374 (#377), #372 (#379), #382 (#391), #348's change (#388), #386 (#408 = `dea7575`), #330's rendering (#411 = `f83073e`). **#348 remains reopened: its 30-leg count restarts at `f83073e`**, recorded on the issue, counted by the manager — `numberOfRuns: 5` and `maxNumericValue: 2500` must not move until it completes. REQUESTs **#389 and #390 are FIXED** (window 3). **Budget from 2026-10-08: manager + TWO build windows at a time** (was one).

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
- **#437 · 3.1 brand B, and #442 its review fixes — ON MAIN.** PR #442's commits landed through the
  manager's **PR #443 = `933d484`** (`integration/brand-b-images` = my `9ae927a` plus one manager
  commit `0ca819c`: the eight Dockerfile `COPY` lines, brand B's own Dockerfile on port 3102, the
  bake target and the compose build service — REQUEST **#439 items 1 and 2**). GitHub marked **#442
  merged and #437 closed**. Main's record is `088d997`.
  - **The proof is in CI, which is the whole point of #442's review fix.** The brand-b leg printed
    the funnel **RAN** line: order placed, **GBP 8719 minor**, → processing → completed, address
    country GB. That line exists because the review caught me reporting "the lifecycle spec RAN"
    from a local log, where Playwright's github reporter names no skipped test and a `test.skip()`
    reason never reaches the output. A proof has to be legible to the person reading the leg.
  - **`app images` went red on #442 exactly as predicted** (ONBOARDING-GAPS trap 10): a new
    workspace package must be `COPY`ed in every existing Dockerfile's deps stage, all eight of which
    are window 5's. A brands window cannot fix it; it is a manager integration landing. **Expect the
    same on #438's PR for brand C**, and say so in the PR body.
  - **`brands/phase3` was held from 2026-10-09 until that sha arrived** and is now unblocked:
    `git merge origin/main` **fast-forwarded** it to `088d997` (phase3 was already an ancestor of
    main), `pnpm install --frozen-lockfile` → "Already up to date", `packages/*` rebuilt **6/6**.
    Then `brands/438` merged in as **`35844e2`**, no conflicts, lockfile clean.
    Gate on the merged branch: lint, `format:check`, typecheck **23/23**, brand B **659 passed / 3
    skipped**, brand C **583 passed / 3 skipped**. #438 continues here.
- **#330 · brand A took the hero rendering** — **PR #411 MERGED as `f83073e`** (head `28d83a1` after
  a memory-only fix; reviewed MERGE on the code — 18 blobs equal, 10 preserved untouched, counts add
  up). Verified on main: `hero-loop.tsx` and `hero-video.ts` are there.
  Re-sync at main `2e35674`, 209 copied / 1 merged / 10 preserved / 4 excluded, **zero
  preserved-file drift**. Brings #403: `hero.tsx` wrapping the poster
  in `HeroMedia`, the `hero-loop` island, `hero-video.ts`'s reader policy, `media-src` in the CSP, and
  the loop's messages in both locales. **#386's placed loops now have a renderer.**
  - **Both of my REQUESTs landed in the same sync:** **#389** (`@lhci/cli` 0.14.0 → **0.15.1**, the
    six erroring audits) and **#390** (`perf.mjs` warms every measured URL via `warm-urls.mjs`).
  - **A mock run cannot show the loop, and the first reason is by design:** the island **refuses to
    mount under `E2E_LOCAL_IMAGES`**, which `scripts/e2e-env.mjs` sets on every e2e run so no request
    leaves the machine — there is a test for it. Then: no Sanity project locally (the run logs
    `SANITY_PROJECT_ID is not set`), and no Cloudinary cloud name (the video is dropped at seed time).
    **Do not go looking for the loop in an e2e or mock run — it is not supposed to be there.**
    What *is* proved is the island's behaviour by unit test: poster-first, mount after `load`, the
    pause control, removal when reduced motion turns on later, poster-alone under `reduce`, and the
    `E2E_LOCAL_IMAGES` refusal.
  - Gates: lint, `format:check`, typecheck clean; unit **764 passed / 2 skipped** (739 before);
    mock e2e **83 passed / 35 skipped**, exit 0. **Machine free.**
  - **#348's count RESTARTS at #411's merge — manager's ruling 2026-10-08, accepting the point I
    raised.** The #389 LHCI bump (0.14.0 → 0.15.1) changes the measuring tool, and legs either side
    of it are not measuring the same thing, so the same logic that freezes `numberOfRuns` and
    `maxNumericValue` mid-count applies to the Lighthouse version. The commit that carries 0.15.1
    into brand A is **#411's merge**; the manager records the restart on the issue at merge and
    counts from there. **`numberOfRuns: 5` and `maxNumericValue: 2500` still do not move** until that
    count completes; re-measuring N is a later PR with its own data. *Generalise it: any change to
    the measuring tool, the budget, or the run count invalidates an in-flight count — check for one
    before touching the perf gate.*
- **#386 · brand A's two hero loops placed.** Content (both locales), the `heroVideo` branch in
  `cms/brand-a/scripts/resolve-media.mjs`, 9 tests, DESIGN.md §7, both READMEs.
  **PR #408**: head `916ff01` → `BLOCK` on static review (the missing test, see the gotcha) → fixed
  and re-pushed as head `c69d6b4` (verified green myself: 14 pass / 0 fail / 0 pending, the live job
  and brand A's perf leg included). **MERGED as `dea7575`; issue #386 CLOSED.** Verified on main.
  Built on `brands/phase3`, merged with main `b5473ac`; cms is 0.5.0.
  - **The swap:** a loop is only valid over the still the manifest names as its `poster`.
    `home-hero-shirt-loop-8s`'s poster is `home-hero-02`, the hero showed `home-hero-01`, and
    `home-hero-02` was already on an `imageBlock` below — so the two stills were **swapped**, not one
    moved onto the other, and no still appears twice — **pinned by
    `shows no still twice on the home page`**, added after the review caught that it did not exist
    (see the gotcha below). The campaign hero already
    showed its poster. **Never "fix" a poster in `media/manifest.json`** to match content: that file
    mirrors media generated outside the repo, so the poster is the video's real first frame.
  - **Resolver:** `resolveVideo` runs **before** the image branch, because a `heroVideo` also carries
    a `mediaSlot` and would otherwise be refused as "is a video, not an image". `walk` now threads the
    parent object down — that is what makes the pairing checkable at all. The pairing is checked
    **even with no cloud name**, so a mis-paired loop is an authoring error rather than something that
    only appears where Cloudinary is configured.
  - **A loop has no alt text, deliberately** (`aria-hidden`; the poster's alt speaks). The content
    test exempts videos from the alt rule *and asserts they carry none*, so nobody writes alt text a
    screen reader never reaches. That pre-existing test went red on the first run — expected, and the
    right fix was the test, not the manifest.
  - Counts: resolver now places **22** (18 stills + 4 loops) and drops all 22 without a cloud name,
    both still passing `validateDocument`. Unit **738 passed / 2 skipped** (730 before).
  - **Not rendered yet** — window 3's #330. A placed loop is simply not rendered; the poster is the
    hero. `src/lib/cms`'s `hero-video.ts` and the reader change arrive by **re-sync**, not by hand.
- **#382 · took the hardened order-lifecycle spec** — one-file re-sync of
  `e2e/order-lifecycle.spec.ts` from #383, on `brands/phase3` after #379 merged (`7f4f8fe`) and #383
  merged (`e667d4e`). Only that spec and `starter-manifest.json` moved. **Keep brand A's
  `STORE_PUBLISHABLE_KEY ??=` line**: the hardened spec now *skips* with a reason when the key is
  absent, so without brand A's line #372 would silently stop being proven instead of failing loudly.
  The pair is the point — my line supplies the value, #383 makes its absence legible.
- **#372 · brand A's half — the re-sync at main `e7f2f3e`.** 202 copied, 1 merged, 10 preserved, 4
  excluded. Brings the starter's #372/#375 half **and** the card-payment work from #365/#367:
  `order-confirmation-header.tsx` + `data-order-status` + `confirmation.bodyByStatus`/`status`
  messages in both locales (the de-DE translations came through the sync in real German — the risk I
  had flagged did not materialise); `e2e/order-lifecycle.spec.ts` (place → ship → deliver, asserts
  `processing` then `completed` by hook *and* by rendered text — this IS #372's brand A assertion, so
  no hand-written spec was needed); the whole Stripe Payment Element set; CSP for Stripe;
  `e2e/card-payment.spec.ts`; and **`STOREFRONT_ALLOW_INVOICE` removed** — methods now come from
  `Store.payment.methods` (Store API 0.5.4). `pnpm install` was needed for the three merged deps
  (`@stripe/react-stripe-js`, `@stripe/stripe-js`, `jsdom`), so **pnpm-lock.yaml is in the PR**.
  - **Preserved drift ported by hand: `playwright.config.ts`.** Took `workersFromEnv()`. **Refused**
    the starter's new `import { RUNTIME_SITE_URL }` — see the Gotcha below; documented in the file,
    the README row and the README's e2e section. `sync --check` now says "manifest is current".
  - Gates: lint, `format:check`, typecheck clean; unit **730 passed / 2 skipped** (687 before — all
    43 synced tests pass); mock e2e **83 passed / 35 skipped**, exit 0. `order-lifecycle.spec.ts` and
    `card-payment.spec.ts` skip without the core by design — **the core leg on the PR is the proof**.
  - **Machine free** (no core, no Keycloak, no docker touched).
- **#348 · the perf gate measures five runs, not three.** `lighthouserc.json`: `numberOfRuns` 3→5,
  **LCP budget unchanged at 2500**. Branch `brands/348` off main (the stated exception while #379 sat
  in the queue).
  - **The issue's hypothesis was wrong.** The PLP's LCP element is the **`<h1>` text** "All products",
    not a product image — TTFB 471 ms, Load Delay 0, Load Time 0, **Render Delay 2060 ms (81%)**. So
    `fetchpriority`/preload/sizing cannot help this page. The PLP's one `<img>` is a Cloudinary
    **demo** URL that returns 506 bytes with `naturalWidth: 0` — it does not load, so there is no
    image to optimise, and **LCP will get WORSE when real imagery lands (#330)**; re-measure then.
  - **Why the budget could never hold.** From the uploaded `.lighthouseci` artifacts of **16 CI legs
    (48 runs/page)**: PLP asserted 1977–2452 (median 2168), individual runs 1977–**2970**; PDP
    asserted 2115–2443, runs 2115–2621. A single PLP run exceeds 2500 **29%** of the time; LHCI
    asserts **best of N**, so N=3 fails 2.5% per leg — **53% over 30 legs**. The acceptance bar was
    unreachable because the estimator was noisy, not because the page is slow. **N=5 → 0.21%/leg,
    6.1% over 30.** (2600 with N=3 gives 3.3% and would have cleared the worst asserted value ever
    seen, 2570.6, below the worst run 2970 — rejected because N=5 reaches the same place without
    weakening the budget. Owner chose N=5.)
  - **Rejected on measurement:** `experimental.inlineCss` does not take effect in Next 15.5 +
    webpack — served HTML still has `<link rel="stylesheet">`, zero inline `<style>`. The apparent
    LCP gain was noise. **Check the artefact, not the metric, before believing a fix.**
  - **Two REQUESTs filed to window 3** (both `scripts/perf.mjs`, the starter's): the pinned
    `@lhci/cli` 0.14.0 **errors six audits on every run**, including every audit that names the LCP
    element (`RootCauses`/`frame_sequence`, reproduced locally) — so nobody can diagnose LCP from the
    gate's own output; and `perf.mjs` **never warms the measured URLs** (CI run 1: TBT 1125 ms vs
    77/72, benchmarkIndex 1483 vs ~2400) while `e2e-server.mjs` warms twice — the likely root fix for
    the variance.
  - **Acceptance still open:** 30 consecutive green brand A perf legs, counted from CI after this
    lands. Cannot be shown in the PR that makes the change; no laptop Lighthouse substitutes.
  - **To diagnose LCP in future:** `npx -y lighthouse@12 <url> --only-categories=performance
    --chrome-flags="--headless=new" --output=json` and read
    `audits["largest-contentful-paint-element"]`. The gate's own reports cannot tell you.
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

## MANAGER (changed 2026-10-09)

The manager session is now **"Manager session five"** (repo root). The old **"Project manager
handoff" is RETIRED** — do not report there. Report to Manager session five when a PR is up and again
when every check has finished.

**New standing rules from it, beyond CLAUDE.md:**
- **ONE WINDOW MEASURES AT A TIME.** Ask the manager for the machine **before any build, e2e or
  Lighthouse run**, and say **"machine free"** after. This is new — I used to just run them.
- **No closing keyword near any issue number** in a commit message or PR-body sentence unless it
  really finishes that issue. GitHub parses "closes #N" anywhere in a body (window 4 hit this).
- **Record the PR in memory AFTER the push**, as `PR #N (code commit <sha>; head = this memory
  commit)`. This is exactly the lesson two reviews caught me on — the number and sha do not exist
  until after the push, so the record is a post-push step.
- Local gate **includes `pnpm format:check`**.
- Budget: **manager + two build slots**, one of which is mine. (CLAUDE.md still says one window;
  the owner's instruction is the current one.)

## In progress — #438 · 3.2 Brand C by script (generator + brand C generated, 2026-10-09)

### STATE: steps 1, 2 and the generator are DONE and green. Nothing pushed.

**Now on `brands/phase3`** (merged `origin/main` `088d997`, then `brands/438` as `35844e2`), not on
the side branch. Commits: `1da91b6` generator, `07c78bc` memory, `1de15cb` content + the generator
move, `66e83c8` C's docs + gaps 13-19. **Still unpushed** — one push when the machine work is done.
Gate at `66e83c8`: lint, format:check, typecheck **23/23**, brand B **660 passed / 3 skipped**,
brand C **583 passed / 3 skipped**.

Gate on `brands/438`, all green together: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`
(**23/23**), brand B **659 passed / 3 skipped**, brand C **583 passed / 3 skipped**,
`sync-from-starter --check` → "manifest is current".

`new-brand.mjs` works and all three refusals are verified (no args; missing `--jurisdiction`, naming
ONBOARDING-GAPS § 2; refusing to overwrite an existing brand). Brand C is generated and reviewed by
hand.

### THE FINDING — the one thing #438 was for

**Brand B proved nothing about cloning, because brand B's locale is one of the starter's.** The
starter serves `en-GB` and `de-DE`. Brand B sells `en-GB`, so every `en-GB` literal B inherited
happened to be right. **Brand C sells `en-US` and nothing inherited is right.** Measured by grep,
not guessed: **8 synced spec files, 43 `en-GB` occurrences**, plus
`scripts/e2e-server.mjs`'s warm-up and `lighthouserc.json`'s two collect URLs.

Three distinct consequences, and they need different answers:

1. **`lighthouserc.json`** (PRESERVED → the brand's) measured `/en-GB/products` — a URL brand C does
   not serve. A perf score computed over two 404s. **Fixed**: the file moved from
   `TEMPLATE_FILES.verbatim` to `substituted`, with a locale pair. `numberOfRuns: 5` and the 2500 ms
   LCP budget (#348) survive — tested. The port stays **3100 for every brand** because
   `scripts/perf.mjs` starts its own `next start --port ${PERF_PORT ?? 3100}`; that is not a bug.
2. **`scripts/e2e-server.mjs`** (SYNCED → window 3's) warms `/en-GB` before declaring the app ready,
   and its `timed()` returns null for any status >= 400. So the warm-up never succeeds and
   `warmUp()` **throws after 120 s — e2e fails before the first test, rather than failing a test**.
   Read from the code, **NOT yet run**: confirming it needs the machine. Do not claim it as measured.
3. **The 8 specs** (SYNCED) navigate to `/en-GB/…` and assert that URL back. Excluding them would
   **delete the suite rather than port it**, so they are left in place and reported. `localeMismatch`
   in the plan module names both files, both effects and the remedy.

**A REQUEST to window 3 is the real fix** (not filed yet — step 4): take the locale PREFIX from
`src/i18n/routing.ts`, which already reads `SUPPORTED_LOCALES`, in the synced specs and in the
warm-up path. #441 parts 1 and 3 are the same shape for the locale LIST and the address.

### THE FINDING THAT ACTUALLY STOPS THE APP — no message catalogue

The worst consequence of the locale gap is not a test, it is that **brand C could not render a single
page**. `src/i18n/request.ts` does

    messages: { ...(await import(`../../messages/${locale}.json`)).default, ... }

**unguarded** — the try/catch beside it covers only window 6's optional `content` catalogue. The
locale it resolves comes from `routing.locales`, i.e. `SUPPORTED_LOCALES`. So a brand that correctly
declares its own locale and ships no catalogue for it throws on **every page**, in dev, in
`next build` and in production. `messages/` holds only the starter's `en-GB.json` and `de-DE.json`.
Brand B sells `en-GB`, so it never met this.

**And the one test that should have caught it was vacuous.** `test/i18n.test.ts` has
`it('ships one per configured locale')` — which asserts the hard-coded set
`['de-DE.json', 'en-GB.json']` and never looks at the configured locales at all. In a brand app
vitest sets no `SUPPORTED_LOCALES`, so `routing.locales` falls back to the starter's default and the
brand's own locale is never mentioned. It passed on a brand C that could not render.

**Fixed, and the fix is proved:**

- `messageCatalogues(target)` in the plan module names the file to write and the starter catalogue to
  base it on — same language where there is one (`en-US` from `en-GB`), otherwise the starter's first
  locale with **`needsTranslation: true`**, because copying English into an `fr-FR` catalogue
  produces an app that renders and therefore reports nothing.
- The CLI writes it. **Verified on the real CLI path, not on fixtures** — a throwaway `brand-d`
  (`fr-FR`) really got `messages/fr-FR.json` and the UNTRANSLATED marker; a `--dry-run` `brand-e`
  wrote nothing. Both throwaways deleted. This mattered because the previous bug in this area
  (`readTemplateMeta` with no `locales`) passed every unit test and threw on the real path.
- Brand C's `messages/en-US.json`: 139 keys, same key set as `en-GB.json`, two strings Americanised
  ("was not authorised" → "authorized"). Those were the only two GB-flavoured strings in 139.
- `test/i18n.test.ts` is now **PRESERVED** for brand C (added to `PRESERVE` in its own
  `sync-from-starter.mjs` — note the three sync scripts are **not** starter-tracked, so that set is
  the brand's to edit; `vitest.config.ts` IS starter-tracked). Its hard-coded assertion now expects
  three catalogues, and a **new** test reads `SUPPORTED_LOCALES` out of `next.config.mjs` — where
  the brand really declares it — and fails if a catalogue is missing.
  **Proved by half-revert**: with `en-US.json` moved away the new test fails with
  "messages/en-US.json is missing — every page would throw". Not a claim.
- The sync's preserved-drift report flagged the new preservation on the next run, which is the
  mechanism working; `starter-preserved.json` now records it and `--check` is clean again.

The REQUEST to window 3 should cover this too: make that test derive its expected set from the
configured locales, after which brand C's preservation of the file can be dropped.

### THE SECOND FINDING — a substitution table cannot read prose

Rewriting `en-GB` → `en-US` everywhere produced **two false statements about the starter** in brand
C's generated files: that the starter defaults `SUPPORTED_LOCALES` to `'en-US,de-DE'`, and that
`seo-head.spec.ts` declares `['en-US', 'de-DE']`. Both false; both next to a file where the identical
rewrite was correct. A locale literal is **data** in `lighthouserc.json` and **prose** everywhere
else, and prose distinguishes "the locale this brand sells" (rewrite) from "the locale the starter
serves" (must not) — which a table cannot.

**Fixed**: `substitutions(template, target, file)` takes the file, and locale pairs apply only to
`LOCALE_DATA_FILES` (`['lighthouserc.json']`). `localeProse()` reports the two prose blocks a human
must write, and `manualSteps` names them. I hand-wrote both in brand C.

### Three smaller generator bugs, all found by reading the generated files

- `SEED_IDS.publishableKeys.brandB` survived into brand C's `next.config.mjs`: the table knew
  `brand-b` and `brand B` but not the **camelCase** form. → `camelForm()`, applied after the
  hyphenated code (longer first).
- **`readTemplateMeta` had no `locales`**, so `localePairs` threw on the real path while the unit
  tests passed on fixtures that supplied it. *A pure module's unit tests do not cover the CLI's
  adapter layer — that is exactly where this bug lived.* It now reads the template's
  `SUPPORTED_LOCALES ??=` from `next.config.mjs` and **refuses** a template that declares none.
- `manualSteps` sent brand C's author to the **onboarding wizard** for a store that is **already in
  the seed** (`SEED_IDS.*.brandC`, verified in `packages/db/src/seed/index.ts`, and
  `packages/db/CLAUDE.md` says brand-a/b/c). Following it would have created a second store for the
  same brand. → `SEEDED_BRANDS`; a seeded brand is told to CHECK the seeded store's currency and
  locale against the command line, a fourth brand is sent to the wizard.

New tests for all of it; brand B is now **653 passed** (was 582 before the generator). Two
pre-existing tests were **wrong** and were corrected, not deleted: one pinned `lighthouserc.json` to
`verbatim`, one pinned the wizard for a seeded brand.

### Two MORE findings, from the docs half (2026-10-09, later)

**The perf gate would have been red for a reason that is not about performance, twice over.**

1. **Where the generator lived broke the perf job.** `infra/ci/changes.sh` reduces every changed
   path under `apps/storefronts/` to its first two segments and reports any that is not a measurable
   storefront as `perf_unmeasured`; `ci.yml` then does `exit 1` on a non-empty list. So
   `apps/storefronts/scripts/` was reported as "storefront changed with no perf script", with advice
   to add a `lighthouserc.json` to a directory that is not a storefront. It was also **outside this
   window's documented paths** (`apps/storefronts/<brand>/**`) — `check-ownership.sh` passed, so its
   glob is looser than `docs/ownership.md` intends.
   Moved to **`apps/storefronts/brand-b/scripts/`** (the template brand, whose suite already held the
   tests). The CLI resolved the storefronts directory from its own location, so that needed fixing
   too, and the moved CLI was re-verified end to end on a throwaway `brand-d`. After the move:
   `perf_unmeasured=[]`, `perf_apps` includes brand C. Verified with
   `bash infra/ci/changes.sh origin/main`.
2. **A generated brand starts with a red perf leg no matter what.** `README.md` is one of the four
   files the sync EXCLUDES, so a generated brand has no README — and
   `scripts/bundle-budget.mjs --verify` needs a `<!-- bundle-budget:start -->` block whose route list
   and budget column match `bundle-budget.json`. The table can only be written by `--sync-readme`
   **after a completed `next build`**. So C's README carries the markers with an explicit "not
   measured yet" instead of numbers copied from brand B. **Fill it during the machine run.**

### Also corrected while in there

A stale cross-reference in BOTH brands' `playwright.config.ts`: the locale/`<head>` coverage gap is
ONBOARDING-GAPS **§ 3.12**, not § 3.9 — the numbering drifted when #442 inserted three traps above
it. Brand C's hand-written blocks cite **§ 3.13** (the new locale trap), which is correct.

### The content half — DONE (commits 1de15cb, 66e83c8)

- **`cms/brand-c/content`**: home page + four US legal drafts. **All five validate** against the
  shared schemas (`seed-content.mjs --dry-run` → _5 documents valid (1 page, 4 legal)_) — no repeat
  of #437's three wrong schema guesses. `LAUNCH_GATE=1` fails on **23 placeholders (19 distinct)**,
  naming each.
  **The US drafts are NOT brand B's translated, and three differences would be stated wrongly by a
  port:** there is **no federal right to cancel an online order** (the FTC Cooling-Off Rule is
  door-to-door, not websites — so C's thirty days is OUR promise, where B's fourteen come from the
  Consumer Contracts Regulations 2013); prices are quoted **without** sales tax, not VAT-inclusive;
  privacy is **state** law (CCPA/CPRA, NY SHIELD) not one statute. `US` is now a
  `KNOWN_JURISDICTIONS` entry pointing at brand C, so the next US brand knows where to copy from.
  The "unwritten jurisdiction" test moved to **JP** — the test is that the script never invents
  instruments, not that any particular country is missing.
- **C has no NAME**, deliberately. B got a working name ("Stonecrop"); C's is the command-line
  string "Brand C", because inventing a second fictional name gives the owner one more thing to
  notice and undo. LAUNCH.md 0.1 is the owner action.
- **Four docs**: `LAUNCH.md` (with a **§ 12** brand B does not have — the locale gap, six rows,
  three of them window 3's), `README.md`, `CHANGELOG.md`, `CLAUDE.md`.
- **ONBOARDING-GAPS traps 13-19** plus a warning on top of § 1, which was written before #438 and
  proved optimistic: "mechanical" meant "mechanical for a brand shaped like brand B".

### Still to do on #438

**Nothing machine-free is left.** What remains:

- **THREE REQUESTs, worded but not filed** — asked Manager session five whether to word them
  differently or fold them into #441, and have not heard back:
  (a) window 3: take the locale **PREFIX** from `src/i18n/routing.ts` in the synced e2e specs and in
  `scripts/e2e-server.mjs`'s warm-up path, instead of the `en-GB` literal.
  (b) window 3: make `test/i18n.test.ts` derive its expected catalogue set from the configured
  locales. Brand C PRESERVES that file until this lands.
  (c) `infra/ci/changes.sh`: ignore a directory with no `package.json` when computing
  `perf_unmeasured` (it already computes `measurable` that way), or give cross-brand tooling a home
  outside `apps/storefronts/`.
  Plus **append brand C's lines to #439** for window 5: C's Dockerfile, bake target, compose service
  and the `COPY apps/storefronts/brand-c/package.json` line that **nine** Dockerfiles are missing
  (measured with `bash infra/ci/check-image-manifests.sh`).
- **MACHINE, asked for and waiting**: brand C's `next build`, one mock render, one core e2e run,
  `bundle-budget.mjs --sync-readme` to fill the README block, and **the one claim in this work I
  have not run** — that `e2e-server.mjs` warming `/en-GB` makes `warmUp()` throw after 120 s so e2e
  fails before the first test. Read from the code. Do not report it as measured.
- Then: one push, PR **"Closes #438"**, record the PR, tell the manager "PR up", and again when the
  checks finish. **`app images` will be red** (nine Dockerfiles) — say so in the PR body.

### Budget note

This grew well past the ~20-tool-call bound mid-task: the locale discovery was not in the plan. The
generator work is finished and green; the content and docs are not started. Reported to the owner
rather than silently continuing.

---

## (the original plan, kept for the trail) #438 · 3.2 Brand C by script

**#442 LANDS VIA PR #443**, not on its own: `integration/brand-b-images` = my `9ae927a` plus one
manager commit (the eight Dockerfile `COPY` lines, brand B's Dockerfile on port 3102, the bake target
and the compose service — #439 items 1 and 2). The queue merges #443; my "Closes #437" commit reaches
main through it, and #442 is closed afterwards as landed-via-#443. **Do not push `brands/phase3`
until the manager sends the merge sha.** After it merges, `brands/phase3` is an ancestor of main:
merge main into it and continue #438 there (so `brands/438` gets merged into `phase3`, and #438's PR
comes off `phase3` as usual).

**Side branch `brands/438`**, cut from `brands/phase3` head `6c312c3` — it must include brand B,
because B is the template the script copies from. **`brands/phase3` is HELD** until the manager sends
#442's merge sha; nothing is pushed from either branch meanwhile.

**Brand C's seeded facts** (`packages/db/src/seed/index.ts`, read not assumed): `brand-c`,
**Brand C Inc.**, US, **USD**, **`en-US` only**, `America/New_York`, **NY sales tax 8.875%**
(`rateBp: 888`, `region: 'NY'`), ships **US only**, key `pk_brand-c_dev_` + twenty zeros, Keycloak
client `storefront-brand-c`, dataset `brand-c`, port **3103**.

**The script:** `apps/storefronts/scripts/new-brand.mjs <code> --currency USD --locale en-US
--port 3103`. Its specification is `apps/storefronts/brand-b/ONBOARDING-GAPS.md`, and the division
is already decided there: **§ 1 is what it does, § 2 is what it must ASK, § 6 is what it must only
POINT AT** — the script stops at the app and the content and points at the onboarding wizard for the
store, rather than duplicating `onboardStore` and bypassing its permission checks (manager agreed).

**Steps:**
1. **PART DONE (not pushed): `apps/storefronts/scripts/new-brand-plan.mjs` + 43 unit tests, all
   green on the first run.** The rules live in a module with **no filesystem access** so they can be
   tested directly — the arrangement `merge-package-json.mjs` already uses. Tests live in brand B's
   suite (`test/new-brand-plan.test.ts`) because B is the template and there is no package at
   `apps/storefronts/`; the same reach-across as `brand-media.test.ts`. Brand B is now
   **625 passed / 3 skipped** (582 + 43).
   What the module settles: `parseArgs` **refuses to default** the name, currency, locale list, port
   or jurisdiction and names ONBOARDING-GAPS § 2 when it does; `substitutions` is ordered
   **longest-source-first** so `pk_brand-b_dev_…` is rewritten whole rather than via the `brand-b`
   inside it (tested — that ordering bug would have made the key depend on iteration order);
   `runtimeDefaults` always emits **`KEYCLOAK_CLIENT_ID`** so no brand inherits brand A's client;
   `e2eExclusions` emits the locale-plural and NL-address exclusions **with their reasons and the
   #441 pointer**, states that the locale-plural one **loses** the `<head>` assertion, and says there
   are **four** NL-address tests; `manualSteps` points the store at the **onboarding wizard** and, for
   a jurisdiction no brand has been written for, **admits it does not know the law** rather than
   inventing instruments (tested: it must not emit anything matching `Act <year>` for US).
   **Still to do on the script:** the CLI half (`new-brand.mjs`) that runs the sync, writes the files
   and refuses a second run.
2. (was 1) `new-brand.mjs` CLI, with its own unit tests. **Derive from an existing BRAND, not the starter**
   (gaps § 1): the brand copies carry `numberOfRuns: 5` (#348), the `STORE_PUBLISHABLE_KEY ??=` line
   (#382), platform-keyed snapshots and the refusal to import `RUNTIME_SITE_URL` (#379). A generator
   seeded from the starter would reproduce three solved bugs.
   It must also write the two levers brand B needed and brand A never did —
   **`SUPPORTED_LOCALES`** and **`KEYCLOAK_CLIENT_ID`** — or brand C silently inherits brand A's
   Keycloak client and the starter's two locales.
   **A second run must refuse, not overwrite** (acceptance criterion). Test that.
2. Run it for brand C; review every generated file by hand before believing it.
3. `cms/brand-c/` content in B's voice-independent shape, **en-US only**, with US legal instruments
   (not B's UK ones and not A's German ones) — the gaps report calls the jurisdiction the one thing a
   generator can never supply.
4. C's placeholder gate; C's `LAUNCH.md` (with section 0's owner actions, as B has); append C's lines
   to REQUEST **#439** if it is still open, else file a new one.
5. Update `ONBOARDING-GAPS.md` with what the script could **not** do — the point of the exercise.
6. README / CHANGELOG / CLAUDE.md for C; then the machine (build, mock render, one core run) **on
   request**, and the gate: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test --filter
   @platform/storefront-brand-c`.

**Expect, from brand B's experience:** C ships US only, so the **NL-address four** will fail for C
too (#441 part 3 unfixed), and the **two locale-plural specs** likewise — the script should emit
those exclusions, not leave each brand to rediscover them. And C's store may have the same
`payment.methods: []` staleness on this laptop; the funnel spec's up-front `GET /store` skip handles
it the same way.

## In progress — nothing. #437 is PUSHED (2026-10-09)

**PR #442 (code commit `81ea1d4`; head = this memory commit)** — was `8576ff0`, re-pushed after the
review. — "Closes #437", branch
`brands/phase3` merged with `origin/main` `27733cc`. 245 files. Awaiting checks; **owed the manager a
report when every check finishes**.

**Review round (2026-10-09), four BLOCK points — two mine, both fixed in `81ea1d4`:**
- **The perf leg was red for one mechanical reason:** `perf.mjs` exits 1 without a bundle-budget
  block in `README.md`, and B's README had none. Every route was inside budget and Lighthouse passed
  with margin (LCP best **1704 ms** against 2500). **`--sync-readme` does nothing without the markers
  already present** — it replaces *between* them — so the section had to be added first.
- **CI could not tell "the funnel ran" from "the funnel skipped".** Playwright's github reporter does
  not name skipped tests and a `test.skip()` reason never reaches the log, so the load-bearing proof
  was illegible. `journey.spec.ts` now prints on **both** paths — the reason on skip (**before**
  `test.skip()`, which throws) and the order id, currency, total and status transitions on success.
  **A proof has to be legible, not merely present.** The reviewer found this, not me.
- Nits fixed: "three" → four in two files (keeping the history of how they were counted);
  **LAUNCH.md 2.2 un-ticked** — the app defaults the locale list but that column asks about a
  deployed environment, and none exists.
- **NOT mine:** `app images` is red because a new workspace package must be `COPY`ed in all eight
  existing Dockerfiles (`infra/ci/check-image-manifests.sh`, window 5's paths). The manager lands it
  with B's Dockerfile and bake target. Recorded as ONBOARDING-GAPS trap 10, with traps 11 (stale
  shared DB) and 12 (invisible skips).

**Runs, all stopped afterwards (machine free, Docker untouched):** build clean with **10 `/en-GB`
routes and 0 `/de-DE`**; mock e2e **19 passed / 9 skipped**; **core e2e 19 passed / 0 failed / 6
skipped**, the core resolving B's store from its key as `brand-b`, GBP, `['en-GB']`. Brand B unit
**582 / 3 skipped**; brand A unchanged **765 / 3 skipped**.

**Next:** #438 — brand C by script (`apps/storefronts/scripts/new-brand.mjs`), with
`apps/storefronts/brand-b/ONBOARDING-GAPS.md` as its specification. Hold the push until the manager
confirms #442 merged.

## (the plan, kept for the trail) #437 · 3.1 Brand B

Branch `brands/phase3` at main **`bc5bac9`**, contracts **v0.4.14**; `pnpm install` clean, all
`packages/*` + `@platform/cms` rebuilt, Keycloak admin dev placeholders appended to the (git-ignored)
`.env`. Well over ~20 calls, so the plan is here and with the manager for confirmation; meanwhile I
build only the parts that depend on nothing.

**Facts established before planning (do not re-derive):**
- Brand B is **already in the seed**: store, legal entity, products, domain `shop.brand-b.local`, and
  the publishable key **`pk_brand-b_dev_` + twenty zeros** (`packages/db/src/seed/index.ts:38`) —
  which the gitleaks allowlist already covers via `pk_brand-[a-c]_dev_0+`. The Keycloak client
  `storefront-brand-b` exists. **So this task clones the APP, not the store.**
- `cms/src/datasets.ts` already declares `brand-b`, and **B sells in ONE locale, `en-GB`** — A has
  two (`en-GB`, `de-DE`). **That asymmetry is the main trap:** anything in A's suite or content that
  assumes two locales must not be copied blindly into B.
- B is GBP / GB market, port **3102**.
- A's `[[…]]` legal placeholders live in `cms/brand-a/content/legal.json` (58 `[[` across
  `cms/brand-a/`, README included) — that file is what the new gate must scan.

**Steps, in dependency order:**
1. ~~**Depends on nothing**~~ — **DONE (not yet pushed).**
   (a) **REQUEST #439** filed. **Two of the five items the issue names need NOTHING**, which shrinks
   the task: the **perf leg is automatic** (`infra/ci/changes.sh` builds `perf_apps` from every
   `apps/storefronts/*` whose package.json has a `perf` script — and `perf_unmeasured` *fails* the
   check for a changed brand storefront that lacks one, so the gate enforces itself); and the **e2e
   leg is automatic** (`infra/ci/run-e2e.sh` globs `apps/storefronts/*/playwright.config.*`, and
   `E2E_INCLUDE_BRAND_STOREFRONTS` already defaults to **1** since #295). What window 5 really needs
   to do: a `docker-bake.hcl` target, B's `Dockerfile`, and three lists — Terraform `var.apps`,
   `deploy-staging.yml` `APPS:`, Helm storefront values — **all three of which are missing brand A
   too**, so #439 asks for both brands rather than re-creating A's omission.
   (b) **The placeholder gate is written and proven**:
   `apps/storefronts/brand-a/test/launch-gate.test.ts`, gated on `LAUNCH_GATE=1`, scanning **all** of
   `cms/brand-a/content/*.json` (not just the imprint; the README is excluded because it documents the
   syntax). Proven three ways — skips without the flag; **fails** with it, reporting 48 placeholders /
   19 distinct grouped by name, count and file; and **passes** with the placeholders substituted out.
   Brand A: **765 passed / 3 skipped**.
   **Two things the proving caught, both worth keeping:**
   - My first version's self-check asserted that placeholders *still exist* in the content — which
     would turn red the day the work is finished, i.e. a test designed to be deleted carelessly. It
     now validates the scanner against a **sample string**, so it keeps working after go-live.
   - `PLACEHOLDER` carries `/g`, and `.test()` on a global regex advances `lastIndex`. The assertion
     passed by luck; it now uses a fresh non-global copy.
   - And a process one: the mutation "failed" twice before I read the log — cmd.exe was rejecting
     `LAUNCH_GATE=1 npx …` and the test never ran. **An exit code is not a result; read the log.**
2. **DONE (not pushed): the clone and B's identity.** `220 copied, 0 merged, 0 preserved, 4
   excluded`; `sync --check` now says "manifest is current"; 225 files. The script needed no changes
   for a first run — `previousStarter`/`previousPreserved` fall back to `undefined`, and MERGE and
   PRESERVE both fall through to a plain copy when the target is missing. I copied only
   `sync-from-starter.mjs`, `merge-package-json.mjs` and `preserved-drift.mjs` — **not** A's
   `starter-manifest.json` / `starter-preserved.json`, which are A's records and would have made
   B's first sync think the starter had moved.
   B's identity was derived from **brand A's** preserved files, not the starter's, so B inherits what
   A earned: the path-depth fixes, `numberOfRuns: 5`, the `STORE_PUBLISHABLE_KEY ??=` line (#382) and
   the deliberate refusal to import `RUNTIME_SITE_URL`. Written: `tsconfig.json`,
   `tailwind.config.ts`, `lighthouserc.json` (identical to A — same 2500 budget, same N=5, and the
   measured URLs are the mock's on `PERF_PORT`), `scripts/start.mjs` (**3102**), `next.config.mjs`
   (B's seeded key; `SITE_URL` deliberately NOT defaulted, per #320/#298), `playwright.config.ts`
   (3102 + the key line), `package.json` (`@platform/storefront-brand-b`, dev 3102). The generator
   asserts every substitution hit and that **no `brand-a` / `Brand A` / `3101` survives** — which is
   how it caught me guessing at A's comment wording rather than reading it.
   **Verified: the perf matrix already sees B** —
   `STOREFRONTS=… CHANGED_FILES=apps/storefronts/brand-b/package.json bash infra/ci/changes.sh` →
   `perf_apps=["apps/storefronts/brand-b"]`, `perf_unmeasured=[]`. That acceptance criterion is met
   with no window-5 change and no CI round trip.
   **B's theme is written: brand name "Stonecrop".** `src/brand/tokens.ts` has B's own palette
   (Chalk / Slate / Moss / Mist / Brick — cooler and harder than A's warm paper-and-clay), a
   **system font stack** (no font binaries: no licence to track and nothing render-blocking, which
   matters given #348's finding that A's hero LCP is render-delay bound) and squarer radii.
   `src/brand/config.ts` differs from the starter in **name and description only** — exactly as A's
   does. B: **581 passed / 2 skipped**, typecheck clean.
   A new workspace package needs a **plain `pnpm install`**, not `--frozen-lockfile`: the lockfile has
   no importer for it, so `@playwright/test` and the rest do not link and typecheck dies with
   "Cannot find module". Lockfile is in the brands allowlist.

   **Two mistakes I made here, both worth keeping:**
   - **I wrote the token content into `config.ts` and clobbered it** — that file holds `brandConfig`
     plus `SiteUrlError` / `LOCAL_DEVELOPMENT_SITE_URL` / `siteUrl()`, ~100 lines of the starter's
     fail-closed origin machinery (#298/#320). It was an untracked new file, so git could not restore
     it; I re-copied from the starter. **Read a file before overwriting it, especially one the clone
     just created and git does not yet track.**
   - **I "improved" `LOCAL_DEVELOPMENT_SITE_URL` to B's port and broke six synced tests.** That
     constant and its prose belong to the **starter**, and synced starter tests assert `:3100`;
     **brand A left it alone for exactly that reason**. The app's own port lives in
     `scripts/start.mjs` and `playwright.config.ts`. So brand A's local-dev default origin is
     `:3100` while A runs on `:3101` — a genuine wart, and an ONBOARDING-GAPS item rather than
     something to fix per brand.

3. **DONE (not pushed): `cms/brand-b/`.** The document **set** mirrors A's — home, two pages
   (`about`, `made`), a campaign (`winter-weight`), navigation, footer, four legal docs. **That is
   TEN documents, not twenty:** A's twenty is ten per locale × two locales, and B sells in one. The
   set mirrors; the count does not. (Reported to the manager rather than padded.)
   All 10 **resolve and validate**: `resolved 10 / dropped 0 / media errors 0 / invalid 0` with a
   placeholder cloud name, and `dropped 10 / invalid 0` without one.
   **I guessed three schema shapes wrong and `validateDocument` caught every one** — `cta` needs
   `variant`; `footerColumn` uses `heading`, not `title`, and its links are `_type: 'link'`, not
   `navItem`; `legal.body` is a **richText object with `content`**, not a bare array. Read A's real
   document before copying its shape.
   **The media manifest deliberately omits `bytes` / `sha256` / `width` / `height`.** B's stills have
   not been generated, and a made-up size or digest is a false record. `resolve-media.mjs` does not
   read them — only A's media test asserts them — and the manifest's own `source`/`generator` fields
   say NOT YET GENERATED. This is an ONBOARDING-GAPS item: **a new brand cannot write a faithful
   manifest until its media exists.**

4. **DONE (not pushed): B's placeholder gate**, mirroring A's and locale-count-agnostic. Proven:
   skips without the flag; with `LAUNCH_GATE=1` it **fails** on **17 placeholders / 14 distinct**
   (UK statutes — Companies House number, UK GDPR/ICO, Consumer Contracts Regulations — not A's
   German ones, because B's legal entity is GB).
   **The divergence I kept is now justified by evidence:** the manager's ruling said scan
   `legal.json`; I scan all of `content/*.json`, and B's gate caught `[[COMPANY_LEGAL_NAME]]` in
   **`footer.json`** (the copyright line) as well. Following the ruling literally would have shipped
   that placeholder. Both suites green: **B 582 / 3 skipped, A 765 / 3 skipped.**

5. **DONE (not pushed): B's funnel spec, LAUNCH.md, ONBOARDING-GAPS.md, README / CHANGELOG /
   CLAUDE.md, and three REQUESTs.** The machine work is the only thing outstanding.

   **FOUR STARTER FINDINGS — none of them brand B's code, and the heart of this task.** Each is a
   place where the starter has brand A's identity or market baked into shared code, which brand B is
   the first app to expose:
   | finding | where | brand B's lever |
   | --- | --- | --- |
   | locale list defaults to the starter's two | `src/i18n/routing.ts` (synced) | `SUPPORTED_LOCALES` in `next.config.mjs` |
   | **OIDC client id defaults to `storefront-brand-a`** | `src/lib/auth/oidc.ts` (synced) | `KEYCLOAK_CLIENT_ID` in `next.config.mjs` |
   | two e2e specs hard-code `['en-GB','de-DE']` | `seo-head.spec.ts`, `checkout.spec.ts` (synced) | excluded in B's `playwright.config.ts` |
   | **shared address helper fills a NETHERLANDS address** | `e2e/support/journey.ts` (synced) | B walks the funnel itself with a GB address |

   The OIDC one is the dangerous one: the `store_code` claim is stamped **per Keycloak client**, so a
   new brand would mint customer sessions scoped to `brand-a`. It surfaced as Keycloak answering
   "Invalid parameter: redirect_uri" — which reads like a realm misconfiguration and is not. Found by
   reading the actual `Location` header the app sends, after three wrong inferences.
   The NL address is the costliest: brand B ships **GB only**, so the inherited funnel specs reach
   B's delivery step, are told "No delivery options are available for this address" — correctly — and
   time out. **REQUESTs #439 (infra), #440 (vitest locales), #441 (locale specs + OIDC default + the
   NL address, parts 1–3).**

   **The one exclusion that LOSES coverage** (the others relocate it): brand B has **no `<head>`
   metadata assertion**, because `seo-head.spec.ts` is excluded whole. Said plainly in
   ONBOARDING-GAPS § 3.9 and in `playwright.config.ts`, and it comes back with #441 part 1.

   **A fifth finding, environmental not code:** brand B's store reports
   `payment.methods: []` where brand A reports `['invoice']`. `packages/db`'s seed sets
   `payment.invoice_allowed` for every store (0.3.2) but `seed` is **ON CONFLICT DO NOTHING**, so
   this long-lived local database kept brand B's old `store.settings`. **So brand B cannot place an
   order on THIS laptop.** B's funnel spec therefore reads `GET /store` up front and **skips with the
   cause and the documented remedy** rather than timing out for three minutes on a radio that will
   never appear — an absent precondition is a skip, which is the suite's own idiom. **CI seeds fresh,
   so CI runs it.** I did NOT run the `UPDATE` from `packages/db/CHANGELOG.md` 0.3.2: it writes to the
   database every window shares, and nothing would tell the others. If the manager wants the local
   proof, that UPDATE is the recorded remedy and it is their call.

   **Mistakes I made and fixed, worth not repeating:**
   - I wrote token content into `src/brand/config.ts` and clobbered ~65 lines of the starter's
     fail-closed `siteUrl()` machinery. It was untracked, so git could not restore it.
   - I "improved" `LOCAL_DEVELOPMENT_SITE_URL` to B's port and broke six synced tests. It is the
     **starter's** constant; brand A leaves it at `:3100` for that reason.
   - My journey spec asserted `£` unconditionally; the mock serves the contract's EUR example store
     for any key, so the currency check is **core-only**. The mock run caught it.
   - Twice I read an exit code as a result: a `cmd.exe` env-prefix rejection, and a stale server that
     `reuseExistingServer` adopted after I deleted `.next` under it. **`pkill -f` does not reliably
     kill node here — use PowerShell `Stop-Process` and verify the port.**
   - Prettier normalises `\'` inside a single-quoted TS string and can break it; avoid apostrophes in
     generated string literals.


**Needs the machine (ask the manager first):** B's `build`, the mock render check, B's core e2e run,
and any Lighthouse. Everything in steps 1, 3, 6, 7 and most of 2 is editing and needs no machine.

## In progress — nothing. Every assigned task merged (2026-10-08)

Nothing of mine is open, held or half-done. The only local commit is this record.

| task | PR | merged as |
| --- | --- | --- |
| **#374** order total compared to the review step, not arithmetic | #377 | `e1e515f` |
| **#372** brand A half — order status, card payment, invoice from the store | #379 | `7f4f8fe` |
| **#382** hardened order-lifecycle spec (one-file re-sync) | #391 | `4335c0c` |
| **#348** perf gate at five runs, budget untouched | #388 | `79436fc` |
| **#386** brand A's two hero loops placed | #408 | `dea7575` |
| **#330** brand A takes the hero rendering | #411 | `f83073e` |

**Outstanding, not mine to close:**
- **#348 is reopened.** Its 30-leg count **restarts at `f83073e`** (recorded on the issue, counted by
  the manager). **Do not touch `numberOfRuns: 5` or `maxNumericValue: 2500` until it completes** — and
  see the generalised rule in the #330 entry: any change to the measuring tool, the budget or the run
  count invalidates an in-flight count.
- REQUESTs **#389** and **#390** are **FIXED** by window 3 and merged. Nothing owed.

**The loops are placed and rendered, and still cannot be SEEN anywhere.** Two owner actions stand
between here and a visible loop, both already on `LAUNCH.md`: a **Sanity project** (without
`SANITY_PROJECT_ID` there is no CMS content at all) and a **Cloudinary account** (without a cloud name
`resolve-media.mjs` drops the video at seed time). A third thing is deliberate, not a gap: the island
**refuses to mount in an e2e build** (`E2E_LOCAL_IMAGES`), so it will never appear in a mock or e2e
run. Do not treat any of these three as a bug.

**Operating budget changed 2026-10-08:** the owner now runs the **manager plus two build windows**,
where CLAUDE.md's rule says one. CLAUDE.md is the main window's file, so it may still read "one";
the owner's instruction is the current one. The ~20-tool-call check-in rule is unchanged.

**Next session:** nothing queued. Likely Phase 3 proper — the gaps below and LAUNCH.md's owner
actions.


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
- **The local gate is `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test --filter ...`.**
  CI's "lint + typecheck" job runs **`pnpm format:check` too**, and CLAUDE.md's gate line omits it —
  so lint and typecheck can both be clean and the job still red. It cost #377 one red run on two
  markdown files (prettier wants `_Place order_`, not `*Place order*`). Run it before every push,
  especially after hand-writing CHANGELOG/README prose. That job also runs `git diff --exit-code` on
  `packages/{events,contracts}/src/generated`, so rebuild those packages before pushing too.
- **A stale Docker-published Prism on :4010 silently poisons local mock e2e runs.** Two checkout
  specs failed at "Pay on invoice" after the #372 re-sync. Nothing was wrong with the code: port 4010
  on this laptop is held by `com.docker.backend` / `wslrelay` from **2026-10-01**, serving a spec
  from before `Store.payment.methods` existed, and `reuseExistingServer: !CI` made Playwright adopt
  it — so `paymentOptions()` saw a store with no `payment` and correctly rendered "no payment method
  available". **Do not kill it** ([[stack-interventions-need-prior-ok]], and the 2a brief says no
  docker): run on private ports instead —
  `MOCK_API_URL=http://127.0.0.1:4310 MOCK_STORE_PORT=4310 MOCK_ADMIN_PORT=4311 pnpm e2e`
  (set the admin port too: `mock.mjs` kills both servers if either fails to bind). CI is unaffected —
  `reuseExistingServer` is off there. **Symptom to recognise:** a mock run failing on a feature the
  contract gained recently, with no error in the app's own log.
  **The same port also makes a UNIT test flake here.** `test/brand-i18n-seo.test.ts`'s "renders
  `<html lang>` through the real layout" renders the real locale layout, which fetches `GET /store`
  from `MOCK_API_URL` (default `localhost:4010`) — and `localhost` tries `::1` first on this laptop
  ([[docker-ipv6-loopback-reset]]). It took 1630 ms on a good run and failed once in about five
  full-suite runs on 2026-10-07, while passing on its own every time. **Not a code defect and green
  in CI**, which starts its own mock: if it reddens a local run, re-run before believing it, and do
  not "fix" the test.
- **`playwright.config.ts` must never import `RUNTIME_SITE_URL`** from `e2e/support/build-origin`,
  however the starter writes it. The module computes `process.env.SITE_URL ?? ':3100'` in a
  module-level `const`; ES imports evaluate before the importing module's body; brand A's
  `process.env.SITE_URL ??= ':3101'` is in that body. Importing it would bake in the starter's port
  and send every redirect out of the brand. The sync flags this file whenever the starter touches it —
  port the change, keep the divergence.
- **NEVER quote a secret-shaped literal in prose — describe it.** Memory files, CHANGELOGs, PR
  bodies and commit messages must not contain a string that looks like a key, even when the whole
  point of the sentence is that the string is a harmless fixture. I broke this in #379: while
  recording *why* the starter's two wrong-key fixtures are benign I pasted both into
  `CHANGELOG.md` and this file, which handed gitleaks two **new** findings in two **new** paths and
  turned the secret scan red again on commits `77ab61e` and `d499ea9`. Commit messages cannot be
  rewritten, so the manager had to allowlist those files on main. Write "the secret-key and
  restricted-key fixtures in `test/payment-options.test.ts`" instead. The scanner reads prose, and
  an explanation of a false positive is indistinguishable from the real thing to a regex.
- **`scripts/check-ownership.sh` can false-positive on another window's files** when the MAIN
  CHECKOUT's `main` is stale: it prefers `merge-base main HEAD`, and `main` lives in
  `C:/Users/mehdi/Desktop/commerce-platform`. **Never move that ref** — it is another session's
  working tree. *(Happened 2026-10-07 at `13c393d`; the manager pulled it and the check is correct
  again. Kept because it will recur.)* Diagnose with:
  `OWNERSHIP_BRANCH=<branch> OWNERSHIP_FILES="$(git diff --name-only origin/main...HEAD)" bash scripts/check-ownership.sh`
  — **three dots, not two.** Two dots diff the two tips, so once `origin/main` moves ahead of your
  branch it lists files *other windows* changed and reads exactly like a violation. Three dots diff
  from the merge base, which is your side only and is what the script itself does.
  Either form covers only **committed** work, so commit first. CI uses `origin/main`, so CI is unaffected.
- **A one-off verification script is NOT a test — and must never be described as one.** #408 was
  BLOCKed for this. While writing #386's content I used a throwaway script in the scratchpad that
  asserted "no still is used twice on the home page". It passed, once, at that moment. I then wrote
  "a test pins that" into the PR body, the commit message (`a1c25eb`) **and** this file — three places
  in the permanent record claiming a standing guarantee that existed nowhere in the repo. The
  reviewer's failure mode was exact: reverting only the imageBlock half of the swap would have passed
  every one of the 8 new tests and quietly printed one still twice. **Rule:** if a claim about
  invariants goes into a PR body, a commit message or this file, the thing enforcing it must be in
  the repo first. Before writing "a test pins X", grep for the test. And when a check is worth running
  once, ask whether it is worth running always — it usually is, which is the whole point of putting it
  in the suite. (Proved the new test fails on exactly that half-revert before trusting it.)
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
