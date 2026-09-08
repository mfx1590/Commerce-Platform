# Memory 9 — Search, media, promotions
Window: 9 · Key: `search` · Branch prefix: `search/` · Model: Fable
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0) · Branch: `search/phase2` · Status: 2.1 merged, 2.2 in PR #166, 2.3 built locally (push blocked until #166 merges), 2.4 next

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
- [x] **#136 · 2.3** Cloudinary media pipeline — commit `<sha set at commit>` (local; **do not push until the #166 merge is confirmed**). CONTRACT CHANGE #168 (signed upload params + per-item media ops, alt required, server-side positions; exact YAML under `proposed/admin-api.media.yaml`; `.env.example` rows for `CLOUDINARY_API_KEY/SECRET` inside), REQUEST #169 (next/image loader in packages/ui, window 3; reference impl `cloudinary.ts` `cloudinaryImageLoader`). Tests: cloudinary.test.ts (7), media.test.ts (6).

## In progress
- (nothing — 2.4 starts next; 2.3 commit waits for the #166 merge confirmation, then `git pull` if the manager merged main into the branch, `git push`, PR "search 2.3: Cloudinary media pipeline for product media (#136)")

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [ ] **#137 · 2.4** Price lists — Admin API price-list operations per contract (check `admin-api.yaml` tag `pricing`: create, dates, customer group, currency, per-variant prices, CSV import if present), resolution order sale > group > default exposed through a public API for window 1's cart pricing. Tests: overlapping lists, expired list ignored, group list needs the customer's group; integer minor units; currency must be enabled on the store (400). Note: `price_list` / `price` / `customer_group` tables are "window 1 (pricing)" in domain.md but the issue assigns the work to me — the module lives in `modules/search`? No: put it in `apps/core/src/modules/promotions/pricing*` or ask — decide at task start (promotions is the owned path that fits pricing; `search` does not).
- [ ] **#138 · 2.5** Promotions and coupon rule engine
- [ ] After #162 / #168 land: delete `proposed/`, switch `http.ts` + `media-http.ts` to `loadSpec('admin-api.yaml')` for permissions and bodies, switch merchandising.test.ts to the real migration (#100/#101 pattern follow-up PR).

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

## Blocked / waiting
- **Push hold for 2.3** until the manager confirms the #166 merge (then push + PR). If the manager merged main into `origin/search/phase2` again, `git pull` (merge) first, `pnpm install`, re-run typecheck + module tests.
- #162 (accepted, lands after #166), #168 (CONTRACT CHANGE 2.3, main), #169 (REQUEST loader, window 3), mount lines (window 1) — all non-blocking.

## Gotchas learned
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
