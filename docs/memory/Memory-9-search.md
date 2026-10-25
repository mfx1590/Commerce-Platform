# Memory 9 — Search, media, promotions
Window: 9 · Key: `search` · Branch prefix: `search/` · Model: Opus 5
Last updated: 2026-10-25 · Contracts: **contracts-v0.4.28** on main · Branch: `search/phase5` (cut from origin/main `cadaeba`) · Status: **PHASE 5 WAVE 2 OPEN — #607 step 1 done (contract diff posted), no code yet.** Phase 2 is complete and merged (2.1–2.5 via #160, #166, #188, #208, #211).

## PHASE 5 DOCKET (written by the manager, 2026-10-25, Manager session nine) — READ THIS FIRST ON RESUME
You reopen in Phase 5 wave 2 for **#607** P5.8 recommendations (plan `docs/plan/phase5-plan.md` D10; tracking #612).
Before you start: merge main into a new branch `search/phase5` (your branch is still at Phase 2; a lot has changed —
read Memory-main "Current status" first bullet and "Global gotchas", run `pnpm install --frozen-lockfile`, rebuild the
workspace packages, run `pnpm --filter @platform/auth-sdk fga:seed`).
- Read `fct_order_line` in ClickHouse (window 12's #601; read-only user) from `apps/core/src/jobs/index-recommendations.ts`;
  co-occurrence with lift + minimum support per store, popular over 7/30 days; write `product_recommendation` (RLS)
  through the tenant client; serve Store API `listProductRecommendations` filtered to published, in-stock, same-store.
- CONTRACT CHANGE first (db table + Store API op, exact diff on #607); the manager lands it on an `integration/*` branch.
- Then REQUEST window 3 for the rail (#609). Message the manager when a PR is up and when checks finish.

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/search/**`
- `apps/core/src/modules/promotions/**`
- `apps/core/src/jobs/index-*.ts`
Reads:
- packages/events
Never touches:
- other core modules
- `apps/core/package.json`, `apps/core/CLAUDE.md`, `apps/core/CHANGELOG.md`, `.env.example`, `src/http/*`, `packages/ui` (window 1 / main / window 3) → REQUEST issues

## Mission — Phase 2 (Commerce complete, brand 1 live)
Algolia index per brand synced from product.published events, merchandising rules API, Cloudinary media pipeline, price lists and coupon rules with stacking/exclusion tests. Wave A — started 2026-09-08 right after contracts-v0.3.

## Done
- [x] **#134 · 2.1** Algolia index per brand with full and incremental sync — commit `d258257`, PR #160 merged (main f2dbf54).
- [x] **#135 · 2.2** Merchandising rules API — commit `2fa93d9`, PR #166 (reviewed same day per the manager). CONTRACT CHANGE #162 ACCEPTED (Admin API 0.4.0, migration 0130, CONTRACTS_VERSION 0.3.1) — lands on main **after** #166 merges; then a small follow-up PR from me deletes `proposed/` (merchandising part) + the test-side DDL and switches `http.ts` to `loadSpec`. Router mount line → window 1 (next paste).
- [x] **#136 · 2.3** Cloudinary media pipeline — commit `097a9b5`, merged in #188 (main `899e606`); issue closed. CONTRACT CHANGE #168 ACCEPTED (lands after the 2.3 PR merges, bundled into the same version bump as #162); REQUEST #169 (next/image loader, window 3). Media writes to `product_media`/`thumbnail_url` stay in the module for Phase 2 (manager decision); catalog public media functions requested in #179, switch when they exist. Tests: cloudinary.test.ts (7), media.test.ts (6).
- [x] **#137 · 2.4** Price lists — commit `46b4cf6`, merged in #188 (main `899e606`); issue closed. Module `apps/core/src/modules/promotions/` created (placement per the manager: the pricing half the cart consumes; recorded in the module README). No contract change needed: `listPriceLists`/`createPriceList`/`upsertPrices` exist in contracts-v0.3, so `pricingRouter()` takes permissions and bodies from `loadSpec` — first spec-driven router of this window. `resolvePrices` (sale > override/group > default, priority, windows, groups, tiers, Queryable-friendly for the cart's tx). REQUEST #179 (window 1): catalog media functions, three router mounts, cart `resolvePrices` call site. Tests: pricing.test.ts (5). Not built (not in the contract): list update/delete, CSV import; no price events exist (price changes reach the index at full reindex — documented).
- [x] **#138 · 2.5** Promotions and coupon rule engine — commit `023209b`, merged inside #188 (main `899e606`); issue closed 2026-09-14. No separate 2.5 PR: the commits reached the branch via the 2026-09-09 push (see the push gotcha below); the scope correction and the corrected PR title/body landed on #188 before it merged. CONTRACT CHANGE #189 accepted, lands with Admin API 0.4.1 (migration 0150 = the promotion type-CHECK widening).

## In progress — #607 (P5.8 recommendations), Phase 5 wave 2
- [x] **Step 0 — reactivation (2026-10-25).** `.claude/CLAUDE.local.md` rewritten; `search/phase5` cut from `origin/main`
  `cadaeba` (old `search/phase2` NOT merged in — it is fully on main); `pnpm install --frozen-lockfile` clean;
  `pnpm turbo run build` for auth-sdk/db/events/contracts green (4/4); `fga:seed` reused store
  `01M5SFMYA64CWXD3THRMQ2M0FE`, wrote model `01M5SYTK0MK5KGRNZXQ9Z4YHHY`, 11 tuples already present.
  This worktree's `.env` was from 2026-09-09 and missing the Phase 5 rows: replaced with a copy of the main
  checkout's (old one kept as `.env.bak-phase2`), then `fga:seed` rewrote the two fga ids in it.
- [x] **Step 1 — CONTRACT CHANGE posted on #607** (comment 6400269668, 2026-10-25). Waiting for the manager to land
  it on an `integration/*` branch; I cut my code from that sha. Nothing written in `packages/**` by me, ever.
- [ ] **Step 2 — the job** `apps/core/src/jobs/index-recommendations.ts` + the read path in `modules/search/`.
  Blocked on the contract landing. Plan, so it survives a /compact:
  1. The job file MUST export a `config` (Medusa's job loader — see the #202/#203 gotcha below); the heavy lifting
     goes in `modules/search/recommendations/` so it is testable without booting Medusa.
  2. ClickHouse `fct_order_line` read with the READ-ONLY user; code against a fixture of #601's documented columns.
     **#601 does not publish its column list yet** (issue body + its one comment say only "documented as stable"),
     so the ClickHouse-backed tests stay behind a skip that prints the reason until the manager says #601 merged,
     and the columns I assume go in the PR body for window 12 to contradict cheaply.
  3. Co-occurrence per store with lift + minimum support, thresholds in config with a worked example in the README;
     popular over 7 and 30 days; idempotent rewrite (DELETE+INSERT per store/kind/window in one transaction)
     through the tenant client.
  4. Read time: published + in-stock + same-store only; fall back to the popular list when an anchor has no pairs.
  5. Tests: hand-made basket set with known lift; brand A orders never produce a brand B recommendation.
- [ ] **Step 3 — REQUESTs**: window 1 for the route mount + apps/core CHANGELOG/package.json/.env.example rows;
  window 3 for the rail (#609) — both filed only once my PR is merged.

## Next — only if reopened by a REQUEST
- When window 1 mounts the three pending routers (#179: `mediaRouter`, `pricingRouter`, `promotionsRouter`): update the two READMEs' "not mounted yet" lines.
- When window 1 delivers #179's catalog media functions: switch `media.ts` to them, delete its direct SQL on `product_media`/`product.thumbnail_url`.
- Known, deliberately not done (manager, #208 review): per-customer promotion limit relies on caller-supplied counts; automatic promotions (code null) never appear in `promotionReportData`.
- Local env note (manager-confirmed 2026-09-15): the shared stack can be partially down locally — OpenFGA (:8081) was, so hq-rbac + auth-live suites skipped (34 passed / 8 skipped). **CI's live job is the authoritative run** for those suites; check which files skipped before trusting a local green, and never restart the shared stack from this window.

## Decisions made (with reasons)
### Phase 5 / #607 (proposed on #607, NOT yet accepted — the manager may change any of these)
- **`product_recommendation` carries two columns the docket did not list, both forced by #607's own criteria:**
  `window_days` (0 = bought_together, 7/30 = popular) because "popular over 7 **and** 30 days" is two lists under
  one `kind` and would otherwise overwrite itself; and a **nullable `product_id`** (NULL = the store-wide popular
  list) because popular is store-wide and anchoring it per product duplicates the list once per catalogue row.
  Three CHECKs tie `kind`, `product_id IS NULL` and `window_days` together so neither can drift. Offered the
  manager the literal-column alternative (N-fold duplication, or kinds `popular_7d`/`popular_30d`).
- **RLS kind `store`** via 0192's `app.apply_rls` (ENABLE + FORCE + `tenant_isolation`) — no new kind, no new role,
  no SECURITY DEFINER. Grants come from 0009's `ALTER DEFAULT PRIVILEGES`; **UPDATE revoked** because the job
  rewrites (DELETE+INSERT) instead of upserting. If the manager prefers `ON CONFLICT DO UPDATE`, that REVOKE line
  is the one to drop.
- **`score` is `numeric`, not an integer/money column**: it is a lift ratio for pairs and a unit count for popular.
  No money, no customer/order id, nothing PII-shaped goes in this table — product ids and numbers only.
- **Two partial unique indexes, not one UNIQUE**: NULLs are distinct in a plain UNIQUE, so one index would silently
  stop deduplicating the popular rows (`…_pair_key WHERE product_id IS NOT NULL`, `…_popular_key WHERE NULL`).
- **One Store API operation for both surfaces**: `GET /store/recommendations` (PDP sends `product_id`, cart sends
  `variant_ids`), not `/store/products/{handle}/recommendations` — the cart case has no single product. Not a
  `Page`: a rail is one short list and `total` is meaningless after the published/in-stock filter. `limit` max 24.
- **The response's `kind` reports the popular fallback** (asked `bought_together`, served `popular`) so #609's rail
  and its analytics event need no extra boolean field.
- **404, not a silent popular list**, for a `product_id`/`variant_ids` outside the resolved store or unpublished —
  same as `getProduct`, so a storefront bug surfaces instead of rendering a plausible wrong rail.

### Phase 2
- **No SDKs (Algolia, Cloudinary); REST/crypto over Node built-ins.** `apps/core/package.json` belongs to window 1. Errors strip the Algolia key (every occurrence); `request` retries 429/5xx/network with backoff.
- **Outbox cursor = `outbox.seq`**; cursor lives in the index settings `userData.outbox_cursor`; no cursor → `conflict`. Full reindex never clears. Known limits in README (READ COMMITTED `seq` gap → `--full` safety net; concurrent full reindexes race).
- **Index name = `store.search_index` if set, else `products_<code>`** (manager confirmed). Replicas `_price_asc|_price_desc|_newest`; rules on the primary only.
- **2.2 storage = table `merchandising_rule`** (manager confirmed, #162); publish replaces the whole Algolia rule set; boosts → `optionalFilters objectID:<id><score=w>`, pins → `promote`, buries → `hide`, category scope → `filters: category_id:<id>`.
- **Routers import `../../http/{errors,permissions,query,staff-auth}` directly** (not the `http` index) to avoid a cycle when window 1 mounts them; relations hard-coded from the proposed YAML until `loadSpec` can read them.
- **2.3 positions are owned by the server**: every add/move/delete renumbers 0..n-1 (window 4's note: client-side renumbering leaves gaps/duplicates); `thumbnail_url` follows position 0; `product_media.url` stores the original, renditions are derived by URL (`thumb/pdp/zoom`), never stored.
- **2.3 alt required** only on the new per-item operations; `ProductInput.media[].alt` stays nullable (window 1's path) — noted in #168.
- **2.3 media changes emit `product.updated` with `changed_fields: ["media"]`** through `withEvents` + `audit_log` rows (`product.media.add|update|delete`) so the search index and the audit trail see them; the media service writes `product_media`/`product.thumbnail_url` (catalog tables) because domain.md assigns the upload pipeline to window 9 — flagged in the PR for window 1's awareness.
- **2.3 signing**: SHA-1 of sorted `k=v&…` + secret (Cloudinary's documented scheme), folder `products/<store_code>`, `public_id` = 8 chars of product id + filename slug + random; 409 without credentials (passthrough mode) rather than 503 — configuration, not an outage.
- Credentials from env only (`ALGOLIA_*[_<CODE>]`, `CLOUDINARY_*[_<CODE>]`).
- Module-level `CHANGELOG.md` because `apps/core/CHANGELOG.md` / `CLAUDE.md` rows are window 1's (#159 part 2 → core 2.3 PR).
- **2.4 placement (manager decision): price lists live in `modules/promotions/`** as the pricing half the cart consumes — recorded in that module's README. domain.md's "window 1 (pricing)" labels the tables, not the Phase 2 work.
- **2.4 router is spec-driven** (`loadSpec` permissions + bodies) because the three operations already exist in contracts-v0.3 — the pattern the 2.2/2.3 routers switch to once #162/#168 land.
- **2.4 resolution ranking**: type rank sale(3) > override(2) > default(1) — "group list" = override with `customer_group_id`; then priority DESC, then greatest `min_quantity <= quantity` within the winning list, then lower amount, then list id (deterministic). Expired/draft/out-of-window ignored regardless of priority. `resolvePrices` takes a `Queryable` so the cart calls it inside its own transaction.
- **2.4 no events**: events 0.2.0 has no price topics; price changes reach the search index at the next full reindex (documented in both READMEs); a price event would be a `CONTRACT CHANGE:` on packages/events if incremental price sync is ever needed.

## Blocked / waiting
- (none — all window-9 work is merged or in #208; #179 mount lines are window 1's and non-blocking)

## Gotchas learned
- **Phase 5 wave order vs. the budget (2026-10-25):** Memory-main has wave 1 starting after the 10-27 17:00 local
  weekly reset (all-models was at 80%, Fable 100%) and #607 is wave 2, behind window 12's #601. The contract diff
  was cheap enough to post early; asked the manager before spending anything on step 2. Owner rule: stop at 80% of
  the 5-hour limit.
- **Phase 5 rules for this window:** route mounting and `apps/core` CHANGELOG/package.json/.env.example are window 1
  via REQUEST; the rail is window 3 (#609, REQUEST only once my API is merged); **ask the manager for "the machine"
  before any live or long run and report "machine free" after** (one window measures at a time); nothing
  secret-shaped in tests (words, never hex/digit tails — gitleaks scans every branch's history); no closing keyword
  next to an issue number in a commit message unless that commit finishes the issue; merge main before pushing.
- **No docker commands from this window, ever** — the manager runs the shared stack.
- **A branch push is all-or-nothing — "hold the push" cannot be honoured per-commit** (2026-09-14). 2.5 was committed locally under a push hold; pushing an unrelated memory commit on 2026-09-09 carried it too, so 2.5 rode into PR #188 and merged with 2.3+2.4 instead of getting its own PR. The manager was still planning around "2.5 unpushed" two messages later. If a hold matters, either keep the held work on a separate branch or re-check `git log origin/<branch>..HEAD` before reporting "unpushed" — and re-verify the claim every time it is repeated, not just when first made.
- **A 2-second all-red CI run with no logs = GitHub Actions billing, not your branch** (2026-09-09, run 34359615873 on #188): every job "failed" with 0 steps; the check annotation reads "The job was not started because recent account payments have failed or your spending limit needs to be increased". Read it with `gh api repos/<owner>/<repo>/check-runs/<id>/annotations`. Re-running is pointless; the manager merges manually on billing refusal (Memory-main merge round 14 did this for #205). Local gates are the evidence to post.
- **Never put a plain CLI script in `apps/core/src/jobs/`** (#202/#203, 2026-09-09): Medusa's job loader scans that folder and requires every file to export a `config`, so the core refuses to boot with "Config is required for scheduled jobs" — and `pnpm test`/typecheck never notice because they don't boot Medusa. The index CLI lives at `src/modules/search/cli/index-products.ts`; a real scheduled job goes in `src/jobs/` **with** a `config` export. Boot proof: `pnpm --filter @platform/core dev` → `/health` 200.
- **This worktree has no `.env`** (it is gitignored and per-checkout): copy it from the main checkout (`cp ../commerce-platform/.env .env`) before `pnpm --filter @platform/core dev`, otherwise the server dies with "DATABASE_URL_APP is not set". Do NOT run `pnpm dev` at the root (shared docker stack rule).
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. Storefront against the core: `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010`). Admin uses `ADMIN_API_URL`.
- `catalog/index.ts` does not export `loadAggregates`; the search module has its own read queries (lint forbids `../catalog/service`).
- One `tx` = one pg client: never `Promise.all` several `tx.query` calls. The catalog module still does it — the warning in the test output is theirs.
- `exactOptionalPropertyTypes` is on: spread optional fields conditionally, including `body` in `fetch` init.
- Root `pnpm lint` allows only `console.warn|error|info`.
- Test ordering in one file shares the seeded database: assert counts relative to a fresh reindex (`start.indexed`), not the literal 200.
- Prettier checks `apps/core/src/**/*.md` and `.yaml` too — run `pnpm prettier --write` on the module before the gates (`.sql` has no parser and is skipped by directory expansion).
- Contract responses are `BadRequest` / `NotFound` / `Conflict`; parameters `StoreId`, `ProductId` exist; tags list has no `search` yet (added in #162).
- Mounting an extra router after `mountCoreMiddleware(app, new DevTokenVerifier())` works: the admin router has no catch-all (used by merchandising.test.ts and media.test.ts).
- A test can apply a proposed migration with `db.owner.query(readFileSync(sql))` after `seed()`.
- Dev-token relations: `seed-store-staff` = store_staff on brand-a (writes products/media), `seed-analyst` = read-only (`viewer` passes, `store_staff` → 403), `seed-store-admin` sees brand-a and brand-b.
- The seed gives every product one picsum `product_media` row and `thumbnail_url`; media tests delete it for the product under test first.
- The Bash tool occasionally fails with a "classifier unavailable" error; retry once, meanwhile use Edit/Write.

## How to run & test this package
- Build deps once per session: `pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`
- Module tests only: `cd apps/core && pnpm exec vitest run src/modules/search` (Postgres 5433 from the shared stack; creates `core_search_*` / `core_merch_*` / `core_media_*` databases).
- Gates: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core` (root) + `pnpm --filter @platform/core lint`.
- Job dry run: `pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --store brand-a --full --fake`.
