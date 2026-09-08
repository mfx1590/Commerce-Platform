# Memory 9 — Search, media, promotions
Window: 9 · Key: `search` · Branch prefix: `search/` · Model: Fable
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `search/phase2` · Status: 2.1 merged-approved (#160), 2.2 built locally (commit pending push — manager holds pushes), 2.3 next

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/search/**`
- `apps/core/src/modules/promotions/**`
- `apps/core/src/jobs/index-*.ts`
Reads:
- packages/events
Never touches:
- other core modules
- `apps/core/package.json`, `apps/core/CLAUDE.md`, `apps/core/CHANGELOG.md`, `.env.example`, `src/http/*` (window 1 / main) → REQUEST issues

## Mission — Phase 2 (Commerce complete, brand 1 live)
Algolia index per brand synced from product.published events, merchandising rules API, Cloudinary media pipeline, price lists and coupon rules with stacking/exclusion tests. Wave A — started 2026-09-08 right after contracts-v0.3.

## Done
- [x] **#134 · 2.1** Algolia index per brand with full and incremental sync — commit `d258257`, PR #160 (reviewed MERGE, manager merging 2026-09-08). Module `apps/core/src/modules/search` + `apps/core/src/jobs/index-products.ts`. Tests: search.test.ts (9), algolia-client.test.ts, search-live.test.ts (skips without credentials).
- [x] **#135 · 2.2** Merchandising rules API — commit `2fa93d9` (local; PR to open when the manager lifts the push hold). CONTRACT CHANGE #162 filed with the exact YAML + SQL (`proposed/` folder in the module). Built against the proposed table (tests apply the SQL) + `MemoryRulesRepository` mock; `merchandisingRouter` awaits window 1's mount (REQUEST inside #162). Reviewer nits from #160 folded in (replaceAll masking, retry/backoff, README limits).

## In progress
- (nothing — 2.3 starts next; 2.2 commit waits for "push ok" from the manager, then `git push` + PR titled "search 2.2: Merchandising rules API (#135)")

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [ ] **#136 · 2.3** Cloudinary media pipeline — signed upload params endpoint (Admin API; check contract, else `CONTRACT CHANGE:`), transformations (thumb, PDP, zoom) by URL in `product_media`, `next/image` loader contract via `REQUEST:` to packages/ui, alt required, positions stable after delete. Signed params must never expose the secret (test); URL passthrough without credentials. Same pattern as 2.1: fetch-based Cloudinary signing (SHA-1 of sorted params + api_secret) — no SDK (package.json is window 1's).
- [ ] **#137 · 2.4** Price lists
- [ ] **#138 · 2.5** Promotions and coupon rule engine
- [ ] After #162 lands: replace the hard-coded relations/ajv schemas in `http.ts` with `loadSpec('admin-api.yaml')`, delete `proposed/`, switch the test to the real migration.

## Decisions made (with reasons)
- **No Algolia SDK; REST over Node's global fetch.** `apps/core/package.json` belongs to window 1 and the surface needed is a handful of endpoints. Errors strip the API key (every occurrence). `request` retries 429/5xx/network with exponential backoff.
- **Outbox cursor = `outbox.seq`** (bigint identity, monotonic), not the uuid `id` the issue text mentions.
- **Cursor lives in the index settings `userData.outbox_cursor`**, not in a table: schema frozen, no writes to another module's table, a rebuilt index cannot resume from a stale cursor. No cursor → `conflict` ("run a full reindex first").
- **Full reindex never clears the index**: position first, upsert all, browse + delete stale. Known limits documented in the README: READ COMMITTED `seq` gap (`--full` is the safety net) and concurrent full reindexes racing on the cursor.
- **Incremental sync re-reads the product from the database**; payload is only a pointer. Published + sellable → upsert, else delete.
- **Index name = `store.search_index` if set, else `products_<code>`** (seed sets `<code>_products`; flagged in #159/#160).
- **Replicas** `_price_asc|_price_desc|_newest` on the store's default currency; `relevance` = primary; rules live on the primary only.
- **2.2 storage = new table `merchandising_rule`** (auditable, survives an index rebuild) rather than Algolia rules as the only store; migration + Admin API paths filed as CONTRACT CHANGE #162 with the exact text; the module carries them under `proposed/` and its tests apply the SQL so the repository is proven before the migration lands.
- **2.2 publish = replace the index's whole rule set** with the active rules (`clearExistingRules`): deleted/disabled rules vanish on the next publish without tracking Algolia objectIDs.
- **2.2 boosts map to `optionalFilters` `objectID:<id><score=w>`**, pins to `promote`, buries to `hide`, category scope to `filters: category_id:<id>` (the Store API category listing must pass that same filter — documented for window 1).
- **Router imports `../../http/{errors,permissions,query,staff-auth}` directly** (not `../../http` index) to avoid a cycle once window 1 mounts it from admin-routes.
- Credentials from env only (`ALGOLIA_APP_ID[_<CODE>]` / `ALGOLIA_ADMIN_API_KEY[_<CODE>]`); `.env.example` rows requested in #159.
- Module-level `CHANGELOG.md` because `apps/core/CHANGELOG.md` / `CLAUDE.md` rows are window 1's (#159).

## Blocked / waiting
- Manager: push hold on `search/phase2` (2026-09-08, during the #160 merge) — 2.2 is committed locally (`2fa93d9`); #160 merged to main as f2dbf54; the manager's merge of main into `origin/search/phase2` (5c4023e) is already merged into the local branch (38e4614, `pnpm install` + typecheck + module tests green afterwards). Local is a clean fast-forward of origin (ahead 3). When released: `git push origin search/phase2`, then open the PR "search 2.2: Merchandising rules API (#135)" with the acceptance criteria. Manager's recorded 2.2 decision (Memory-main merge round 5) matches: table `merchandising_rule`, migration 0130, path `/admin/stores/{storeId}/merchandising/rules`, index name = `store.search_index`.
- #162 (CONTRACT CHANGE, main) and the mount line (window 1) — non-blocking, module works against the proposed table/mock.
- #159 (REQUEST: `.env.example`, CLAUDE.md/CHANGELOG rows) — non-blocking.

## Gotchas learned
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. Storefront against the core: `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010`). Admin uses `ADMIN_API_URL`.
- `catalog/index.ts` does not export `loadAggregates`; the search module has its own read queries (lint forbids `../catalog/service`).
- One `tx` = one pg client: never `Promise.all` several `tx.query` calls (pg deprecation warning). The catalog module still does it — the warning in the test output is theirs.
- `exactOptionalPropertyTypes` is on: spread optional fields conditionally, including `body` in `fetch` init.
- Root `pnpm lint` allows only `console.warn|error|info`.
- Test ordering in one file shares the seeded database: assert counts relative to a fresh reindex (`start.indexed`), not the literal 200.
- Prettier checks `apps/core/src/**/*.md` and `.yaml` too — run `pnpm prettier --write` on the module before the gates.
- Contract responses are `BadRequest` / `NotFound` / `Conflict` (no `ValidationError`); tags list has no `search` yet (added in #162).
- Mounting an extra router after `mountCoreMiddleware(app, new DevTokenVerifier())` works: the admin router has no catch-all, unknown `/admin/*` paths fall through (used by merchandising.test.ts).
- A test can apply a proposed migration with `db.owner.query(readFileSync(sql))` after `seed()` — `app.apply_rls` and `app.set_updated_at` exist in every test database.
- The Bash tool occasionally fails with a "classifier unavailable" error; retry once, meanwhile use Edit/Write.

## How to run & test this package
- Build deps once per session: `pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`
- Module tests only: `cd apps/core && pnpm exec vitest run src/modules/search` (Postgres 5433 from the shared stack; creates `core_search_*` / `core_merch_*` databases).
- Gates: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core` (root) + `pnpm --filter @platform/core lint`.
- Job dry run: `pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --store brand-a --full --fake`.
