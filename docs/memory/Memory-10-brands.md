# Memory 10 — Brand storefronts (A, B, C…)
Window: 10 · Key: `brands` · Branch prefix: `brands/` · Model: Sonnet
Last updated: 2026-09-28 · Contracts: contracts-v0.4.6 · Branch: `brands/phase2` · Status: 2.3 content half in PR #289 — BLOCK fixes pushed. 2.4 next

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
- **#141 · 2.3 CMS content** — 20 documents in `cms/brand-a/content/` (home, about, cloth, 4 EU
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

## In progress
- **2.3 content half in PR** (660bfbf) closing #141. Awaiting verdict.

## Carried nits
### From the #289 review (parked — do in 2.4 or a cleanup PR)
- `productStory` block is never asserted after the harness-artefact fix — add a positive assertion.
- Hero and campaign **CTA** hrefs are outside the link-resolution test, which only walks navigation
  and footer. README now says so explicitly; widen the test.
- `lastReviewed` dates sit on legal documents the PR calls unreviewed — reconcile the two.
- The Impressum footer link is doubled per locale (`col-help` *and* `legalLinks`).
- **`CMS_DATASET` is set nowhere in `.github`**, so the content axe scans never run in CI.
- `seed-content.mjs` without `--dry-run` overwrites Studio edits with no confirmation — add one.
- The en-GB imprint cites German statutes (a lawyer item, not mine — carry to the legal review).

### From the #288 review
- **Merge mode cannot REMOVE.** A script or dependency the *starter deletes* looks brand-only to
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
- [x] **#139 · 2.1** Clone the starter into apps/storefronts/brand-a (in PR)
- [ ] **#140 · 2.2** Theme and layout overrides from the brand design
- [ ] **#141 · 2.3** CMS content for brand A
- [ ] **#142 · 2.4** SEO and i18n for brand A
- [ ] **#143 · 2.5** End-to-end suite browse → buy → account for brand A
- [ ] **#144 · 2.6** Launch checklist for brand A

## Decisions made (with reasons)
- **Brand A is designed here, not in Figma** (2.2): no Figma exists. `src/brand/DESIGN.md` is
  written before the code and the code is held to it. Calm editorial D2C apparel; five named values
  (Paper #F7F4EF, Ink #23201B, Clay #9C4A32, Sage #5F6B57, Stone #746C60), all pairs measured
  against WCAG (Stone was darkened from #7A7266 after it measured 4.32:1). Newsreader + Hanken
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
- 2.3 part 1 (re-sync + merge mode) in PR; the CMS content half follows in its own PR.
- **REQUEST #278** (window 3): the starter's `test/slots.test.ts` asserts the brand's own override
  files are empty — false by construction in a clone. Until it lands, that file deviates and is on
  the clone's PRESERVE list; drop it and re-sync afterwards.
- CI brand-storefront journeys stay opt-in (`E2E_INCLUDE_BRAND_STOREFRONTS=1`) until window 2
  lands #212; brands opts in at 2.5 (#143) after that.

## Gotchas learned
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
