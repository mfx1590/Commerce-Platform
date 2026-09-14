# Memory 9 — Search, media, promotions
Window: 9 · Key: `search` · Branch prefix: `search/` · Model: Opus 5
Last updated: 2026-09-14 · Contracts: Admin API 0.4.0 on main (0.4.1 pending: #168 + #189) · Branch: `search/phase2` · Status: **PHASE 2 COMPLETE — 2.1–2.5 all merged to main.** #134–#138 closed. Last action left: the docs-only cleanup once Admin API 0.4.1 lands (delete both `proposed/` folders + their test-side DDL, switch the merchandising/media/promotions routers to `loadSpec`). Then the window goes QUIET until a REQUEST reopens it.

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

## In progress
- (nothing — Phase 2 is complete and merged; the window is quiet until Admin API 0.4.1 lands or a REQUEST arrives)

- [x] **#138 · 2.5** Promotions and coupon rule engine — commit `023209b`, merged inside #188 (main `899e606`); issue closed 2026-09-14. No separate 2.5 PR: the commits reached the branch via the 2026-09-09 push (see the push gotcha below); the scope correction and the corrected PR title/body landed on #188 before it merged. CONTRACT CHANGE #189 accepted, lands with Admin API 0.4.1 (migration 0150 = the promotion type-CHECK widening).

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [ ] After contracts 0.4.0 (#185, carries #162 + #180) lands on main: `git merge main` — #185 itself deletes `proposed/` (merchandising) and switches the merchandising router to spec-driven permissions, so the follow-up is **docs only** (README references to proposed/, memory). #168 + #189 land after the 2.5 PR merges, bundled into Admin API 0.4.1 (migration 0150 = the promotion type-CHECK widening); same docs-only cleanup for the media/promotions proposed/ files then. (#166 nits: folded into the branch 2026-09-08, commit `56ccb75`.)
- [ ] When window 1 delivers #179's catalog media functions: switch `media.ts` to them, delete its direct SQL on `product_media`/`product.thumbnail_url`.

## Decisions made (with reasons)
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
- **Push hold for 2.3** until the manager confirms the #166 merge (then push + PR). If the manager merged main into `origin/search/phase2` again, `git pull` (merge) first, `pnpm install`, re-run typecheck + module tests.
- #162 (accepted, lands after #166), #168 (CONTRACT CHANGE 2.3, main), #169 (REQUEST loader, window 3), mount lines (window 1) — all non-blocking.

## Gotchas learned
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
