# Changelog — search module (window 9)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — search/phase2 (contracts-v0.3)

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

- `proposed/admin-api.merchandising.yaml` + `proposed/0130_merchandising_rule.sql`: the exact contract change
  filed as #162 (Admin API `…/merchandising/rules[/{ruleId}]`, `…/merchandising/publish`, `store_staff` read /
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
