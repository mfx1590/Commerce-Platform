# Changelog — search module (window 9)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 5 — search/phase5 (contracts-v0.4.29)

### 2026-10-27 · first live run against real ClickHouse (#628 merged; the machine, granted)

- **The SQL is proven on the real engine, and the dev data cannot exercise it.** `fct_order_line` has 144 rows
  whose columns match #601's frozen set exactly, but **every row has `product_id` NULL**: all 144 carry a
  `variant_id`, `dim_variant` holds only 2 rows (built from the 5 `product.published` events in the dev data),
  the order lines reference SEEDED catalog variants that never went through the bus, and the join matches 0. The
  model behaves as documented (NULL when a variant was never published); the dev catalogue simply predates the
  bus. So the job computes 0 recommendations there — correctly.
- **Two defects the live run exposed.** (1) The live test hardcoded a store id (`30000000-…-0031`) that matches
  no row; the real one is `SEED_IDS.stores.brandA` = `00000000-…-0031`. It had been querying an empty store and
  passing on `basketCount >= 0` — a green that proved nothing. It now uses `SEED_IDS`, cross-checks the source's
  `basketCount` against an independent count, and asserts invariants that hold at any volume. (2) "It ran" was
  never proof anyway, because a shadowed alias returns WRONG results rather than an error, and zero rows cannot
  be wrong.
- **So the same statements now run against a literal row set on the real ClickHouse** (25.8, read-only, nothing
  written — `analytics_ro` could not): ClickHouse's own self-join and GROUP BY return basket total 10, tee 6,
  cap 5, the single pair tee+cap at 4 baskets with mug+scarf correctly dropped by the HAVING floor, lift
  1.3333, and both stored directions — the same numbers the pure test asserts. `basketStatements(relation)`
  exists for exactly this substitution; production always passes `fct_order_line`.
- `index-recommendations --dry-run` ran end to end through `analytics_ro` over 6 stores in 5.9 s with no errors,
  which also confirms the `default_format` fix: the first real query would otherwise have been refused.

### 2026-10-27 · #621 review fixes (Fable review = MERGE, three findings)

- **`clickhouse.ts` alias shadowing (the review's finding, and it was wider than the line flagged).** The pair
  query aliased its outputs `a` / `b`, the same names as its two table aliases, and all three CTE queries
  aliased a count to `baskets` — the CTE's own name. ClickHouse resolves aliases everywhere in a statement, so
  none of this meant what it reads as (Memory-main: three bugs in Phase 5, one a data-loss path). Every name is
  now distinct: `basket_lines`, `left_line` / `right_line`, `total_baskets` / `product_baskets` / `pa` / `pb` /
  `pair_baskets` / `sold_units`. A static test asserts no output alias repeats a CTE name, a table alias or an
  `fct_order_line` column, in every statement the source builds — with a mutation check that the assertion
  catches both shapes from the gotcha. None of this SQL has executed yet, so a static guard is the only guard.
- **`clickhouse.ts` sent a per-query setting** (found while auditing for the above, not in the review).
  `default_format` is a ClickHouse _setting_, and `analytics_ro` is `readonly = 1`, which refuses any — the
  first real query would have failed. The format moved into the statement (`FORMAT JSONEachRow`); only
  `database` and the `param_*` bindings remain in the URL, matching `apps/analytics-ingest`'s read-only client.
- **`CORE_RECOMMENDATIONS_MIN_LIFT` ≤ 1 is now a configuration error** with a message that says why (1.0 means
  "no more likely than chance", so such a floor recommends pairs carrying no signal). Was: only ≤ 0 refused.
- **The dry run reported the raw candidate count**, not what a run would write, and hard-coded the popular
  windows to 0. It now reports post-threshold rows for both kinds, so `--dry-run` is comparable with a real run.

### 2026-10-27 · P5.8 recommendations (#607)

- `recommendations-types.ts` — thresholds and the pure maths: co-occurrence counts from baskets, lift, the
  minimum-support rule, both directions per pair, the popular ordering. No I/O, so the rule is testable from a
  hand-made basket set. Worked example in the README and in the file header.
- `clickhouse.ts` — a SELECT-only ClickHouse HTTP client (no SDK, parameters bound through `param_*`,
  credentials never in an error) plus two basket sources behind one interface: `ClickHouseBasketSource`
  (aggregates in ClickHouse, only counts cross the wire) and `FixtureBasketSource` (the stand-in until window
  12's #601 is on main, and what the unit tests use). Reads `fct_order_line` per the interface fixed on #601:
  `product_id` comes from `dim_variant`, so no Postgres join; `product_id IS NULL` and
  `order_status = 'cancelled'` lines are skipped.
- `recommendations.ts` — `rebuildStoreRecommendations` (DELETE + INSERT per store/kind/window in one
  transaction through the tenant client; the INSERT joins `product` so a product this store does not have is
  skipped) and `listProductRecommendations` (published / in-stock / same-store through `loadSearchRecords`, the
  popular fallback reported in the response's `kind`, 404 for a foreign or unpublished anchor, 400 for a
  currency the store does not have).
- `recommendations-http.ts` — `recommendationsRouter()` for Store API 0.5.9 `GET /store/recommendations`.
  **Not mounted**: the Store API chain is window 1's and has no store-side router seam yet (REQUEST filed).
- `src/jobs/index-recommendations.ts` (window 9's path) — the Medusa scheduled job (`config` + `default`, as
  every file in `src/jobs` must export) and a CLI with `--store` / `--dry-run`. With no ClickHouse credentials
  it logs why and exits without writing.
- Tests: 20 + 12 + 11 (one skipped with a printed reason until #601 lands).

## Phase 2 — search/phase2 (contracts-v0.3)

### 2026-09-15 · docs cleanup after contracts-v0.4.1 (last Phase 2 change)

- README and router headers now state the real mount state on main: `merchandisingRouter` is mounted through
  `src/http/module-routers.ts`; `mediaRouter` is not yet (window 1, #179) and its routes 404 until it is.
- README: the Cloudinary key/secret rows are in `.env.example` (landed with 0.4.1), no longer "requested".

### 2026-09-14 · contracts-v0.4.1 landed (#168 applied by the main window)

- `proposed/admin-api.media.yaml` removed: the media operations are in `admin-api.yaml` 0.4.1 and
  `media-http.ts` reads each operation's `x-permission` via `loadSpec` instead of hard-coding the relations.

### 2026-09-09 · core boot regression fixed (#202/#203)

- The index CLI moved `src/jobs/index-products.ts` → `src/modules/search/cli/index-products.ts`. Medusa's job
  loader scans `src/jobs/` and requires every file there to export a `config`; the CLI exports none, so the core
  refused to boot ("Config is required for scheduled jobs") from main since #160. README runbook commands
  updated. A genuine scheduled job would live in `src/jobs/` **with** a `config` export.

### 2026-09-08 · contracts-v0.4 landed (#162 applied by the main window)

- `proposed/` removed: `merchandising_rule` is `packages/db` migration 0130 and the operations are in
  `admin-api.yaml` 0.4.0. `merchandising.test.ts` no longer applies the SQL itself (`createTestDatabase` runs
  every migration); `http.ts` reads each operation's `x-permission` from the spec via `loadSpec` instead of
  hard-coding the relations.

### 2026-09-08 · 2.3 Cloudinary media pipeline for product media (#136, CONTRACT CHANGE #168, REQUEST #169)

- `proposed/admin-api.media.yaml`: the exact contract change filed as #168 — `POST
/admin/stores/{storeId}/media/upload-params` (signed direct upload), `GET|POST …/products/{productId}/media`,
  `PATCH|DELETE …/media/{mediaId}`; schemas `MediaUploadRequest`, `MediaUploadParams`, `ProductMediaInput`
  (alt required), `ProductMediaPatch`, `ProductMedia` (+ `variants: { thumb, pdp, zoom }`). No db change.
- `cloudinary.ts`: `cloudinaryCredentialsFor` (per-store triple wins), `signParams` (SHA-1, sorted params +
  secret), `buildUploadParams` (folder `products/<code>`, readable `public_id`; never the secret), `transformUrl`
  / `renditionUrls` (thumb / pdp / zoom, chained before existing transformations, passthrough for other hosts),
  `cloudinaryImageLoader` — the `next/image` loader reference for packages/ui (REQUEST #169).
- `media-types.ts`: contract types + ajv validation (alt trimmed and non-blank; empty patch → 400).
- `media.ts`: `listProductMedia`, `addProductMedia` (append or insert at position), `updateProductMedia` (alt /
  variant / move), `deleteProductMedia` — positions renumbered 0..n-1 by the server after every change,
  `product.thumbnail_url` = position 0, `audit_log` + `product.updated` (`changed_fields: ["media"]`) through the
  outbox on the same transaction; `createUploadParams` (product must belong to the store; null without
  credentials).
- `media-http.ts`: `mediaRouter({ credentialsFor?, now? })` — mount line → window 1 (in #168).
- Tests: `cloudinary.test.ts` (7), `media.test.ts` (6).

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
