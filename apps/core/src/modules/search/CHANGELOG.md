# Changelog — search module (window 9)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — search/phase2 (contracts-v0.3)

### 2026-09-08 · 2.1 Algolia index per brand with full and incremental sync (#134)

- `types.ts`: `SearchRecord` (one per published, sellable product; prices per currency in integer minor units),
  `IndexClient` abstraction, `StoreIndexTarget`, `SYNC_TOPICS`.
- `algolia-client.ts`: `AlgoliaIndexClient` over Node's global `fetch` (batch upsert/delete in chunks of 1000,
  browse, settings get/set with `forwardToReplicas`, delete index, optional task polling). No SDK dependency
  (`apps/core/package.json` is window 1's). Errors never carry the API key.
- `fake-client.ts`: `FakeIndexClient`, in-memory with Algolia semantics + call log; exported for other windows.
- `records.ts`: `loadSearchRecords` / `buildRecord` from `product`, `product_variant`, `price` (+ default active
  `price_list`), `inventory_level` (active warehouses), `product_category` (path), `store_currency`.
- `settings.ts`: `indexNameFor` (`store.search_index` else `products_<code>`), primary settings, three replicas
  (`_price_asc`, `_price_desc`, `_newest`) ranking on the store's default currency.
- `sync.ts`: `fullReindex` (no clear; stale records removed via browse; cursor = outbox position read before
  the products), `syncFromOutbox` / `syncUntilCaughtUp` (outbox `seq > cursor`, per store, topics
  `product.published|updated|archived`, products re-read from the database), cursor in the index's
  `userData.outbox_cursor`, store-scope guard.
- `config.ts`: `algoliaCredentialsFor` — `ALGOLIA_APP_ID[_<CODE>]` / `ALGOLIA_ADMIN_API_KEY[_<CODE>]`.
- `src/jobs/index-products.ts`: `--store <code>` | `--all`, `--full`, `--loop <ms>`, `--fake`, `--batch <n>`.
- Tests: `search.test.ts` (database + fake client), `algolia-client.test.ts` (fake fetch),
  `search-live.test.ts` (skips without credentials).
