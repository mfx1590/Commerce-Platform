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

## Public API (`index.ts`)

`fullReindex`, `syncFromOutbox`, `syncUntilCaughtUp`, `ensureIndexSettings`, `readCursor`, `loadSearchRecords`,
`buildRecord`, `indexNameFor`, `replicaNameFor`, `primarySettings`, `replicaSettings`, `AlgoliaIndexClient`,
`FakeIndexClient` (for other windows' tests), `algoliaCredentialsFor`, and the types `IndexClient`,
`SearchRecord`, `StoreIndexTarget`, `SyncResult`, `ReindexResult`.

## Tests

- `search.test.ts` — throwaway seeded database + `FakeIndexClient`: full reindex (200 records, replicas,
  cursor), idempotency, stale removal, store isolation (store client refused for another store; A's index has
  none of B's ids; B's archive is invisible to A's sync), incremental archive → delete / update → upsert /
  publish → insert / unsellable never indexed / re-run no-op / replay idempotent, `buildRecord` pure cases.
- `algolia-client.test.ts` — REST shaping against a fake fetch (batches of 1000, headers, URL encoding, browse
  cursor loop, 404 settings → `{}`, task polling, key never in errors).
- `search-live.test.ts` — real Algolia round trip on a throwaway index; skips without credentials.
- `merchandising.test.ts` — seeded database (migration 0130): router with dev-token principals
  (store_staff read / store_admin write, 403), validation (foreign category / product ids, pinned+buried,
  weights), one rule per scope (409), get/patch/delete, brand-b never sees brand-a's rule, publish → fake
  Algolia rules (active only, `published_at`), relevance search with pin/bury applied, 409 without an index,
  `toAlgoliaRule` mapping, in-memory repository.

Merchandising public API: `listRules`, `getRule`, `createRule`, `updateRule`, `deleteRule`, `publishRules`,
`searchRelevance`, `merchandisingRouter`, `toAlgoliaRule`, `PgRulesRepository`, `MemoryRulesRepository`.

Run: `pnpm test --filter @platform/core` (root, builds workspace deps) or `pnpm --filter @platform/core test`.
