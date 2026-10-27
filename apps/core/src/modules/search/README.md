# search (window 9)

Algolia index per brand, synced from the catalog (issue #134). Phase 2 tasks 2.2 (merchandising rules) and the
Store API `sort=relevance` path build on this module.

## Owner

Window 9 (search). Paths: `apps/core/src/modules/search/**` (the index CLI lives at `cli/index-products.ts`), `apps/core/src/jobs/index-*.ts`.

## Index naming

One primary index per store plus three replicas for the Store API sort orders:

| Index                | Ranking                                                      |
| -------------------- | ------------------------------------------------------------ |
| `<index>`            | relevance (`ranking` default + `customRanking` newest first) |
| `<index>_price_asc`  | `asc(price_minor.<DEFAULT_CURRENCY>)`, then relevance        |
| `<index>_price_desc` | `desc(price_minor.<DEFAULT_CURRENCY>)`, then relevance       |
| `<index>_newest`     | `desc(published_at_ts)`, then relevance                      |

`<index>` = `store.search_index` when the registry set one (the seed sets `<code>_products`, e.g.
`brand-a_products`), otherwise `products_<store_code>` (`indexNameFor`). Replica settings are pushed on every
full reindex (`ensureIndexSettings`), so a settings change in `settings.ts` reaches a store on its next reindex.

## Records

One record per **published, sellable** product (`records.ts`, `SearchRecord` in `types.ts`). `objectID` =
product id, so every save is an idempotent upsert. Mirrors the Store API read model: prices from the store's
`default` active price list per **enabled** currency (`store_currency`), `min_quantity = 1`; availability summed
over active warehouses; a product with no price in any enabled currency is not indexed (deleted if present).
Money is integer minor units keyed by currency (`price_minor.EUR`, `price_max_minor`, `compare_at_minor`).
`store_id` is stored but `unretrievable`; `description` is truncated to 4000 chars. Facets: `category_path`
(handles root → leaf), `tags`, `brand_name`, `in_stock`, `currencies`, `variants.sku`.

## Full reindex vs incremental sync (`sync.ts`)

- `fullReindex(client, store, index)` — reads the store's outbox position, streams every published product in
  batches (default 500), upserts them, then deletes records that are in the index but no longer published
  (browse), and stores the position as the cursor. Never clears the index: readers see no gap.
- `syncFromOutbox(client, store, index)` — reads `outbox` rows with `topic IN (product.published,
product.updated, product.archived)` and `seq > cursor` for the store (`seq` is the outbox's monotonic column;
  uuid ids are not sortable), re-reads the touched products from the database (the event payload is only a
  pointer), upserts the published + sellable ones, deletes the rest, advances the cursor. Returns
  `processed === batchSize` when more may be waiting; `syncUntilCaughtUp` loops.
- The cursor lives in the index settings' `userData.outbox_cursor`: no schema change, no writes to another
  module's table, and a dropped or rebuilt index cannot resume from a stale position. An index without a cursor
  refuses incremental sync (`conflict`) — run a full reindex first (seeded products never had an event).
- Store isolation: a store-scoped client may only index its own store (`forbidden` otherwise); the reads run on
  the caller's tenant client, so RLS guarantees the rows — products **and** outbox events — belong to the store.
  An organization client may index any store; the SQL still filters by `store_id`.
- Both operations are idempotent (tests replay events with a rewound cursor and reindex twice).

The relay that publishes outbox rows to the bus is window 14's (Phase 4); this module only reads the table and
never sets `published_at`.

Known limits (reviewer notes on #160):

- **`--full` is the safety net for the READ COMMITTED `seq` gap.** `seq` is assigned at insert, not at commit: a
  transaction that inserted an outbox row with a lower `seq` but committed _after_ an incremental run read past
  it is never seen by the incremental path. Rare (two concurrent catalog writes straddling a sync), and the
  next full reindex repairs it — schedule one (nightly is plenty) and after any reindex-worthy incident.
- **Two concurrent full reindexes of one store race on the cursor**: each writes its own snapshot position last,
  so the earlier one may overwrite the later one's cursor and the next sync replays a few events (harmless:
  upserts are idempotent) or, if the older run's `browse + delete` lands after the newer run's upserts, drops
  records the newer run had just written until the next sync/full run. Run one full reindex per store at a time
  (the job is single-process per invocation; do not start two `--full` jobs on the same store).

## Merchandising rules (task 2.2, #135 — contract change #162)

Pin / boost / bury per **category** or **search query**, one rule per store + scope, stored in the
`merchandising_rule` table (`packages/db` migration 0130, landed with contracts-v0.4) or in
`MemoryRulesRepository` for environments without the table. The Admin API operations are the `search` area of
`admin-api.yaml` 0.4.0 (`store_staff` read, `store_admin` write); `merchandisingRouter({ repository, indexFor })`
reads each operation's `x-permission` from the spec (`loadSpec`) and validates bodies against the same schemas
(`merchandising-types.ts`). **Mounted** on main through `apps/core/src/http/module-routers.ts`
(`moduleAdminRouters()`, after `adminRouter()`), with `PgRulesRepository` and the store's index backend.

- Validation: schema (ajv), scope (`category_id` must be a category **of the store**, `query` is normalised:
  trimmed, single-spaced, lower-cased), every product id in pins / boosts / buries must belong to the store
  (400 `validation_error` with `details.product_ids`; the tenant client makes foreign ids "not found"), no
  duplicates, a pinned product cannot be buried (also checked on the merged rule when patching), `ends_at >
starts_at`, boost weight 1–100, at most 50 pins / 200 boosts / 200 buries. Duplicate scope → 409.
- Publish (`POST …/merchandising/publish`): every **active** rule (enabled and inside its window) is mapped to an
  Algolia Rule (`algolia-rules.ts`: category → `condition.filters = category_id:<id>`, query → `pattern` +
  `anchoring: is`; pins → `consequence.promote`, buries → `consequence.hide`, boosts →
  `params.optionalFilters` `objectID:<id><score=weight>`, window → `validity`) and pushed as the index's
  complete rule set (`clearExistingRules`), so disabled or deleted rules disappear on the next publish;
  `published_at` is stamped. Rules live on the primary index only (relevance); replicas are untouched.
- Store API `sort=relevance`: `searchRelevance(store, index, { q, category_id, page, limit })` runs one index
  query (category listings pass the same `category_id:<id>` filter the rules condition on) and returns product
  ids in ranking order + total; the store route (window 1) hydrates them through the catalog read model and
  keeps the ILIKE stub when the store has no credentials. `FakeIndexClient.search` applies saved rules
  deterministically so this path is tested without Algolia.

## Product media / Cloudinary (task 2.3, #136 — contract change #168, loader REQUEST #169)

- **Signed direct upload** (`POST /admin/stores/{storeId}/media/upload-params`, `store_staff`): the browser
  uploads straight to Cloudinary with parameters this server signed — `folder: products/<store_code>`, a
  readable `public_id`, `timestamp` — SHA-1 over the sorted `k=v&…` string + api secret (`cloudinary.ts`
  `signParams`). The response carries the public `api_key`, the signed params and the signature, never the
  secret (test asserts it). No credentials for the store → 409 `conflict` (URL passthrough mode: media can
  still be added by URL from any host). The product must belong to the store (404 otherwise).
- **Per-item media operations** (`GET|POST …/products/{productId}/media`, `PATCH|DELETE …/media/{mediaId}`;
  `viewer` read, `store_staff` write): `alt` is required (trimmed, non-blank) on add and on patch; `variant_id`
  must be a variant of the product; positions are **owned by the server** — every add (append or insert at
  `position`), move and delete renumbers the product's media 0..n-1 in the existing order (no gaps, no
  duplicates, whatever the client sent — window 4's Phase 1 renumbering note); `product.thumbnail_url` follows
  position 0. Each change writes `audit_log` (`product.media.add|update|delete`, before/after) and one
  `product.updated` (`changed_fields: ["media"]`) event through the outbox on the same transaction — so the
  search index picks it up on the next sync. `product_media.url` always stores the **original** URL.
- **Renditions** (`ProductMedia.variants`, `renditionUrls`): `thumb` `c_fill,w_400,h_400,g_auto,q_auto,f_auto`,
  `pdp` `c_limit,w_1200,q_auto,f_auto`, `zoom` `c_limit,w_2400,q_auto,f_auto`, inserted right after
  `/image/upload/` and chained before any transformation already in the URL; non-Cloudinary URLs (unsplash,
  picsum in the seed) pass through unchanged.
- **`next/image` loader contract** (windows 3/6/10; `packages/ui` copies `cloudinaryImageLoader` — REQUEST
  #169): `c_limit,w_<width>,q_<quality|auto>,f_auto`, passthrough for other hosts.
- Credentials: `CLOUDINARY_CLOUD_NAME[_<CODE>]`, `CLOUDINARY_API_KEY[_<CODE>]`, `CLOUDINARY_API_SECRET[_<CODE>]`
  (`cloudinaryCredentialsFor`; a store triple wins, a partial triple is ignored). `CLOUDINARY_CLOUD_NAME` is
  shared with the cms rows; all three rows are in `.env.example` (landed with contracts-v0.4.1).
- Router: `mediaRouter({ credentialsFor?, now? })` (`media-http.ts`); permissions are read from admin-api.yaml
  0.4.1 (`loadSpec`). **Not mounted yet**: the `routers.push(mediaRouter())` line in
  `apps/core/src/http/module-routers.ts` is window 1's, requested in #179 — until it lands these routes 404.
- Tests: `cloudinary.test.ts` (7: credentials, signature, params without the secret, slugs, transformations,
  passthrough, loader), `media.test.ts` (6: signed params / 409 / 404, alt required, variant check, 403 for a
  read-only role, append / insert / move / delete positions, thumbnail, audit + events, foreign product 404).

## Credentials

From the environment only (Vault-injected in deployed environments, ADR 0006; repo-root `.env` locally):

| Variable                                                | Scope                                             |
| ------------------------------------------------------- | ------------------------------------------------- |
| `ALGOLIA_APP_ID`, `ALGOLIA_ADMIN_API_KEY`               | every store                                       |
| `ALGOLIA_APP_ID_<CODE>`, `ALGOLIA_ADMIN_API_KEY_<CODE>` | one store; `<CODE>` = `brand-a` → `BRAND_A`; wins |

`algoliaCredentialsFor(code)` returns null when neither pair is complete: the job skips the store (exit 1), the
live test skips, local work uses `--fake`. Keys never appear in logs or errors (`AlgoliaError` strips them).
`.env.example` rows for these variables are requested from the main window (root config).

## Runbook

The CLI lives **under the module**, not in `src/jobs/`: Medusa's job loader scans that folder and requires
every file in it to export a `config`, so a plain script there makes the server refuse to boot with "Config is
required for scheduled jobs" (#202/#203). A real scheduled job would go back to `src/jobs/` **with** a `config`
export; this one is a CLI invoked by cron / the runbook.

```bash
# first build of every active store's index (also after a settings change or a suspected drift)
pnpm --filter @platform/core exec tsx src/modules/search/cli/index-products.ts --all --full

# catch up one store from the outbox (cron / after a deploy)
pnpm --filter @platform/core exec tsx src/modules/search/cli/index-products.ts --store brand-a

# poll every 5 s until SIGINT/SIGTERM (first pass full when --full is given, then incremental)
pnpm --filter @platform/core exec tsx src/modules/search/cli/index-products.ts --all --loop 5000

# dry run without an Algolia account (in-memory index, prints counts)
pnpm --filter @platform/core exec tsx src/modules/search/cli/index-products.ts --store brand-a --full --fake
```

The job needs `DATABASE_URL_APP` (runs as `platform_app` through `tenantClient`) and `CORE_ORGANIZATION_ID`
(default: seeded HQ). Exit code 1 when any selected store failed or was skipped. A full reindex of a 200-product
store is one batch; `--batch <n>` tunes it.

## Recommendations (task P5.8, #607 — contract change landed as db 0204 + Store API 0.5.9)

"Frequently bought together" and "popular in store", computed from ClickHouse `fct_order_line` (window 12's
#601) by `src/jobs/index-recommendations.ts`, stored in Postgres `product_recommendation`, served by the Store
API. No vendor, no embeddings (plan D10).

**Why lift and not raw co-occurrence.** A store's best seller co-occurs with everything, so raw counts recommend
the same few products on every page. Lift divides the observed co-occurrence by what independence predicts:

```
lift(a, b) = P(a and b) / (P(a) * P(b)) = baskets(a, b) * N / (baskets(a) * baskets(b))
```

**Why a minimum support as well.** Lift is loudest where the evidence is thinnest, so a pair must also appear in
at least `minSupportBaskets` baskets.

**Worked example** (the numbers in `recommendations-types.ts` and in the tests). One store, lookback window,
N = 10 baskets: tee in 6, cap in 5, 4 together; mug in 2, scarf in 2, 2 together.

| pair      | support   | lift                     | outcome                                                                      |
| --------- | --------- | ------------------------ | ---------------------------------------------------------------------------- |
| tee + cap | 4 baskets | 4 × 10 / (6 × 5) = 1.333 | **kept**, `score` 1.3333, both directions                                    |
| mug+scarf | 2 baskets | 2 × 10 / (2 × 2) = 5.0   | **dropped** — support 2 < 3, highest lift in the store and still meaningless |

Thresholds (env, defaults in brackets): `CORE_RECOMMENDATIONS_LOOKBACK_DAYS` [90],
`CORE_RECOMMENDATIONS_MIN_SUPPORT` [3], `CORE_RECOMMENDATIONS_MIN_LIFT` [1.2],
`CORE_RECOMMENDATIONS_MAX_PAIRS` [24], `CORE_RECOMMENDATIONS_MAX_POPULAR` [24],
`CORE_RECOMMENDATIONS_CRON` [`30 3 * * *`]. The two caps default to 24 because the contract's `limit` is capped
at 24, so storing more would never be read. The `.env.example` rows are window 1's (REQUEST filed with #607).

**ClickHouse side** (`clickhouse.ts`): the READ-ONLY user (`CLICKHOUSE_READONLY_USER` /
`CLICKHOUSE_READONLY_PASSWORD`; `readonly 1`, SELECT-only on `analytics.*`, 10 s and 100 000-row caps). The
aggregation happens in ClickHouse and only the counts cross the wire — pair counts, per-product basket counts,
the basket total — which is the only shape that fits those caps on a real catalogue. Every query binds its
parameters through ClickHouse's `param_*` mechanism, never string interpolation.

Two rules this client follows that are easy to get wrong, both from the Memory-main global gotchas:

- **No per-query settings.** `analytics_ro` is `readonly = 1`, which refuses any ("Cannot modify … in readonly
  mode"), so `default_format` cannot go in the URL — the format is `FORMAT JSONEachRow` in the statement, and
  only `database` plus the `param_*` bindings are sent. `apps/analytics-ingest`'s read-only client documents the
  same rule.
- **No alias may repeat a name the statement already uses.** ClickHouse resolves aliases everywhere in a query,
  so an output alias that collides with a CTE name, a table alias or a source column silently changes what the
  query means (three bugs in Phase 5, one of them a data-loss path). Every name here is distinct —
  `basket_lines`, `left_line` / `right_line`, `total_baskets` / `product_baskets` / `pa` / `pb` /
  `pair_baskets` / `sold_units` — and `clickhouse.test.ts` asserts it statically, with a mutation check that the
  assertion really catches the two shapes that bit this phase. Two filters, per the manager
  on #601: `product_id IS NOT NULL` (the variant was never published) and `order_status != 'cancelled'`. A basket
  is `order_id` as a SET, so a product on two lines of one order counts once as support; `quantity` feeds the
  popular lists only. `fct_order_line` resolves `product_id` itself through `dim_variant`, so this job needs **no
  Postgres join** for the variant → product mapping.

**Write shape.** `rebuildStoreRecommendations` is DELETE + INSERT per (store, kind, window) in one transaction,
which is what "idempotent re-run" means here: a second run on unchanged data leaves identical rows, and a pair
that fell below the threshold disappears instead of lingering (an upsert would leave it). Migration 0204
revokes UPDATE for the app role so this stays the only write shape. Same-store is guarded three times: the
INSERT joins `product` on (store_id, id), 0204's composite foreign keys make a cross-store pair impossible, and
RLS scopes the client.

**Read shape.** `listProductRecommendations` filters to published, in-stock, same-store products through
`loadSearchRecords` — the same read model the index and the Store API product list use, so a rail can never show
something the catalogue would not. Published and stock are deliberately NOT filtered at write time: they change
many times a day and the rebuild is nightly. The list can therefore come back shorter than `limit`, or empty
(the caller hides the rail). When an anchor has no usable pairs the server serves the popular list and the
response's `kind` says `popular` — that is how the rail and #609's analytics event see a fallback, with no extra
field. `product_id` / `variant_ids` outside this store or unpublished → 404, as on `getProduct`.

Not mounted yet: the Store API chain is window 1's and there is no store-side `moduleStoreRouters()` yet, so
`GET /store/recommendations` 404s until window 1 mounts `recommendationsRouter()` (REQUEST filed with #607).

```bash
# rebuild every store (nightly cron does this; needs the ClickHouse read-only credentials)
pnpm --filter @platform/core exec tsx src/jobs/index-recommendations.ts
# one store, or see the thresholds' effect without writing
pnpm --filter @platform/core exec tsx src/jobs/index-recommendations.ts --store brand-a --dry-run
```

## Public API (`index.ts`)

`fullReindex`, `syncFromOutbox`, `syncUntilCaughtUp`, `ensureIndexSettings`, `readCursor`, `loadSearchRecords`,
`buildRecord`, `indexNameFor`, `replicaNameFor`, `primarySettings`, `replicaSettings`, `AlgoliaIndexClient`,
`FakeIndexClient` (for other windows' tests), `algoliaCredentialsFor`, and the types `IndexClient`,
`SearchRecord`, `StoreIndexTarget`, `SyncResult`, `ReindexResult`.

Recommendations (P5.8): `rebuildStoreRecommendations`, `listProductRecommendations`,
`recommendationsRouter`, `RECOMMENDATIONS_PATH`, `thresholdsFromEnv`, `DEFAULT_THRESHOLDS`,
`ClickHouseClient`, `ClickHouseBasketSource`, `FixtureBasketSource`, `clickhouseCredentialsFrom`, the pure
`countsFromBaskets` / `liftOf` / `recommendPairs` / `recommendPopular`, and the types `BasketSource`,
`BasketCounts`, `Thresholds`, `RecommendationKind`, `PopularWindow`, `RebuildResult`, `FixtureLine`.

## Tests

- `search.test.ts` — throwaway seeded database + `FakeIndexClient`: full reindex (200 records, replicas,
  cursor), idempotency, stale removal, store isolation (store client refused for another store; A's index has
  none of B's ids; B's archive is invisible to A's sync), incremental archive → delete / update → upsert /
  publish → insert / unsellable never indexed / re-run no-op / replay idempotent, `buildRecord` pure cases.
- `algolia-client.test.ts` — REST shaping against a fake fetch (batches of 1000, headers, URL encoding, browse
  cursor loop, 404 settings → `{}`, task polling, key never in errors).
- `search-live.test.ts` — real Algolia round trip on a throwaway index; skips without credentials.
- `recommendations.test.ts` — the lift rule on the hand-made basket set above (both directions kept, the
  high-lift thin pair dropped, a product twice in one basket counted once), then on a seeded throwaway
  database: both kinds and both windows written, a byte-identical re-run, a pair falling below support removed,
  store isolation (one fixture holding brand A and brand B orders produces no cross-brand row either way), the
  composite keys refusing a cross-store INSERT outright, a product ClickHouse knows but Postgres does not
  skipped, and the read path — pair list, anchor never recommended back, a cart of anchors merged, the popular
  fallback reported in `kind`, the 7- vs 30-day windows, `limit`, unpublished dropped, out of stock dropped,
  404 for a foreign anchor, 400 for a currency the store does not have.
- `recommendations-http.test.ts` — the route over a tenant stub: the contract's query rules (no anchor, both
  anchors, non-uuid anchor, bad `variant_ids`, `window_days` not 7/30, `limit` above 24, unknown `kind`) and
  the answers (pair list, store-wide popular with no anchor, a cart of variant ids, 404, `limit`).
- `clickhouse.test.ts` — the client over a stubbed fetch (parameters bound through `param_*` and never
  interpolated, JSONEachRow parsing, credentials kept out of errors, 500 retried, the three aggregates, no pair
  query when the store has no baskets), the read-only credential rule, and the fixture source's filters and
  windows. The one ClickHouse-backed test **skips with a printed reason** until window 12's #601 (PR #619) is on
  main and `analytics.fct_order_line` exists; `CORE_RECOMMENDATIONS_CLICKHOUSE_TESTS=1` plus a reachable
  ClickHouse turns it on. A green local run is therefore not evidence that the ClickHouse seam works.
- `merchandising.test.ts` — seeded database (migration 0130): router with dev-token principals
  (store_staff read / store_admin write, 403), validation (foreign category / product ids, pinned+buried,
  weights), one rule per scope (409), get/patch/delete, brand-b never sees brand-a's rule, publish → fake
  Algolia rules (active only, `published_at`), relevance search with pin/bury applied, 409 without an index,
  `toAlgoliaRule` mapping, in-memory repository.

Merchandising public API: `listRules`, `getRule`, `createRule`, `updateRule`, `deleteRule`, `publishRules`,
`searchRelevance`, `merchandisingRouter`, `toAlgoliaRule`, `PgRulesRepository`, `MemoryRulesRepository`.

Run: `pnpm test --filter @platform/core` (root, builds workspace deps) or `pnpm --filter @platform/core test`.
