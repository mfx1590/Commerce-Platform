# Memory 9 — Search, media, promotions
Window: 9 · Key: `search` · Branch prefix: `search/` · Model: Fable
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `search/phase2` · Status: 2.1 in PR, 2.2 next

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/search/**`
- `apps/core/src/modules/promotions/**`
- `apps/core/src/jobs/index-*.ts`
Reads:
- packages/events
Never touches:
- other core modules
- `apps/core/package.json`, `apps/core/CLAUDE.md`, `apps/core/CHANGELOG.md`, `.env.example` (window 1 / main) → REQUEST issues

## Mission — Phase 2 (Commerce complete, brand 1 live)
Algolia index per brand synced from product.published events, merchandising rules API, Cloudinary media pipeline, price lists and coupon rules with stacking/exclusion tests. Wave A — started 2026-09-08 right after contracts-v0.3.

## Done
- [x] **#134 · 2.1** Algolia index per brand with full and incremental sync — commit `d258257` (PR opened from `search/phase2`). Module `apps/core/src/modules/search` (types, algolia-client over fetch, fake-client, records, settings, sync, config, README, CHANGELOG) + `apps/core/src/jobs/index-products.ts`. Tests: search.test.ts (9, DB + fake), algolia-client.test.ts (7), search-live.test.ts (skips without ALGOLIA_APP_ID/ALGOLIA_ADMIN_API_KEY).

## In progress
- (nothing — 2.2 starts next; 2.1 PR awaits the Reviewer)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [ ] **#135 · 2.2** Merchandising rules API — check Admin API 0.3.0 for merchandising paths first; likely `CONTRACT CHANGE:` with exact YAML (pin/boost/bury per category or query) + local mock; rules → Algolia rules mapping (`/1/indexes/<name>/rules/batch`) through `IndexClient` (extend the interface: `saveRules`, `clearRules`); Store API `sort=relevance` path via the search module public API (window 1 owns store-routes.ts → REQUEST for the call site).
- [ ] **#136 · 2.3** Cloudinary media pipeline for product media
- [ ] **#137 · 2.4** Price lists
- [ ] **#138 · 2.5** Promotions and coupon rule engine

## Decisions made (with reasons)
- **No Algolia SDK; REST over Node's global fetch.** `apps/core/package.json` belongs to window 1 and the surface needed is five endpoints (batch, browse, settings get/put, delete index, task). Errors strip the API key.
- **Outbox cursor = `outbox.seq`** (bigint identity, monotonic), not the uuid `id` the issue text mentions (uuid v4 is not sortable; the column comment says so).
- **Cursor lives in the index settings `userData.outbox_cursor`**, not in a table: db schema frozen, no writes to another module's table (`store.settings` is registry's), and a dropped/rebuilt index cannot resume from a stale cursor. Incremental sync on an index without a cursor → `conflict` ("run a full reindex first"): seeded products never had an event, so replaying the outbox from 0 would miss them.
- **Full reindex never clears the index**: position read first (same transaction as the product reads), upsert all, then browse + delete stale ids. Readers see no gap; events during the reindex are replayed by the next sync.
- **Incremental sync re-reads the product from the database**; the event payload only points at `product_id`. Published + sellable → upsert, anything else (draft, archived, no price in an enabled currency) → delete. Same rule as the Store API read model (default active price list, `store_currency`, active warehouses).
- **Index name = `store.search_index` if set, else `products_<code>`.** The seed sets `search_index = '<code>_products'` (e.g. `brand-a_products`), which differs from the issue's `products_<store_code>` — flagged in the PR; the registry column wins because it is the documented "Algolia index name" (decision 9).
- **Replicas** `<index>_price_asc|_price_desc|_newest` are standard replicas ranked on the store's default currency (`asc(price_minor.EUR)`); `relevance` = primary. Settings are pushed on every full reindex.
- **Store-scope guard**: a store-scoped client indexing another store throws `forbidden` before any query; RLS is the second wall (products and outbox rows). Organization client may index any store (job runs per store through `tenantClient` anyway).
- **Credentials**: `ALGOLIA_APP_ID[_<CODE>]` / `ALGOLIA_ADMIN_API_KEY[_<CODE>]` from env (Vault-injected later, ADR 0006); per-store pair wins. `.env.example` rows requested via REQUEST issue.
- Module-level `CHANGELOG.md` inside `src/modules/search` because `apps/core/CHANGELOG.md` and the `CLAUDE.md` module table are window 1's (REQUEST issue asks for the row).

## Blocked / waiting
- (none) — REQUEST issue open for `.env.example` + `apps/core/CLAUDE.md`/`CHANGELOG.md` rows (non-blocking).

## Gotchas learned
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.
- `catalog/index.ts` does not export `loadAggregates`; the search module has its own read queries (lint forbids `../catalog/service`). Keep it that way — the index projection differs anyway.
- One `tx` = one pg client: never `Promise.all` several `tx.query` calls (pg deprecation warning, removed in pg 9). The catalog module still does it (`loadAggregates`) — the warning in the test output is theirs.
- `exactOptionalPropertyTypes` is on: spread optional fields conditionally (`...(x !== undefined ? { x } : {})`), including `body` in `fetch` init.
- Root `pnpm lint` allows only `console.warn|error|info` (no `console.log`).
- Test ordering in one file shares the seeded database: assert counts relative to a fresh reindex (`start.indexed`), not the literal 200, after any test archived a product.
- Prettier checks `apps/core/src/**/*.md` too (only `docs/**` is excluded) — run `pnpm prettier --write` on the module before the gates.
- The Bash tool occasionally fails with a "classifier unavailable" error; retry once, meanwhile use Edit/Write.

## How to run & test this package
- Build deps once per session: `pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`
- Module tests only: `cd apps/core && pnpm exec vitest run src/modules/search` (needs Postgres 5433 from the shared stack; creates its own database `core_search_*`).
- Gates: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core` (root) + `pnpm --filter @platform/core lint` (the app's own config, not picked up by the root run).
- Job dry run: `pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --store brand-a --full --fake`.
