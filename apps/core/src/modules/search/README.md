# search (window 9)

Algolia index per brand, synced from the catalog (issue #134). Phase 2 tasks 2.2 (merchandising rules) and the
Store API `sort=relevance` path build on this module.

## Owner

Window 9 (search). Paths: `apps/core/src/modules/search/**`, `apps/core/src/jobs/index-*.ts`.

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

```bash
# first build of every active store's index (also after a settings change or a suspected drift)
pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --all --full

# catch up one store from the outbox (cron / after a deploy)
pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --store brand-a

# poll every 5 s until SIGINT/SIGTERM (first pass full when --full is given, then incremental)
pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --all --loop 5000

# dry run without an Algolia account (in-memory index, prints counts)
pnpm --filter @platform/core exec tsx src/jobs/index-products.ts --store brand-a --full --fake
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

Run: `pnpm test --filter @platform/core` (root, builds workspace deps) or `pnpm --filter @platform/core test`.
