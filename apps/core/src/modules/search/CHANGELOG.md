# Changelog — search module (window 9)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — search/phase2 (contracts-v0.3)

### 2026-09-08 · contracts-v0.4 landed (#162 applied by the main window)

- `proposed/` removed: `merchandising_rule` is `packages/db` migration 0130 and the operations are in
  `admin-api.yaml` 0.4.0. `merchandising.test.ts` no longer applies the SQL itself (`createTestDatabase` runs
  every migration); `http.ts` reads each operation's `x-permission` from the spec via `loadSpec` instead of
  hard-coding the relations.

### 2026-09-08 · 2.2 Merchandising rules API (#135, CONTRACT CHANGE #162)

- `proposed/admin-api.merchandising.yaml` + `proposed/0130_merchandising_rule.sql` (removed once #162 landed, see
  above): the exact contract change filed as #162 (Admin API `…/merchandising/rules[/{ruleId}]`, `…/merchandising/publish`, `store_staff` read /
  `store_admin` write; table `merchandising_rule`, RLS `store`). The module tests apply the SQL to their
  throwaway database until it lands.
- `merchandising-types.ts`: contract types, ajv body validation, scope normalisation, cross-field checks.
- `repository.ts`: `RulesRepository` with `PgRulesRepository` (the proposed table) and `MemoryRulesRepository`.
- `merchandising.ts`: `listRules`/`getRule`/`createRule`/`updateRule`/`deleteRule` (category and product ids
  validated against the store through the tenant client), `publishRules` (active rules → complete Algolia rule
  set, `published_at`), `searchRelevance` (Store API `sort=relevance` ids + total through the index).
- `algolia-rules.ts`: `toAlgoliaRule` mapping (promote / hide / optionalFilters score / validity).
- `http.ts`: `merchandisingRouter({ repository, indexFor })` — mount point requested from window 1 in #162.
- `IndexClient` gained `saveRules`, `clearRules`, `search`; `FakeIndexClient.search` applies rules
  deterministically; `AlgoliaIndexClient` maps them to `/rules/batch?clearExistingRules`, `/rules/clear`,
  `/query`.
- Reviewer nits from #160 folded in: `AlgoliaError` masks **every** occurrence of the key (`replaceAll`);
  `request` retries 429 / 5xx / network failures with exponential backoff (`retries`, `retryBaseMs`). README
  documents `--full` as the safety net for the READ COMMITTED `seq` gap and the concurrent-full-reindex race.
- Tests: `merchandising.test.ts` (7), `algolia-client.test.ts` +3 (retry, masking, rules/search shaping).

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
