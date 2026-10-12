# hq-warehouse — the shared stock pool and stock-aware allocation (window 11, #435)

**Status: design + proposed contract.** CONTRACT CHANGE #453 is filed from this page (seam: REQUEST #454); no engine code exists until
the manager has decided it. Owner: window 11 (`apps/core/src/modules/hq-warehouse/**`, `apps/wms-adapter/**`).

## The problem

Warehouses are organization-level, but stock is not: `inventory_level` is UNIQUE on (variant, warehouse) and a
variant belongs to one store. Two brands selling the same physical product from the same shelf hold two unrelated
quantities. The Integration 3 gate is _a shared warehouse serves two brands from one stock pool_.

## The model

| Thing                           | Scope        | Key                                   | Notes                                                                                                     |
| ------------------------------- | ------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `stock_item` (new)              | organization | UNIQUE (organization_id, sku)         | what physically lies on the shelf                                                                         |
| `product_variant.stock_item_id` | store        | many variants → one item              | how a brand sells an item; a new variant gets its own item (trigger)                                      |
| `inventory_level`               | pool         | UNIQUE (stock_item_id, warehouse_id)  | `store_id` and `variant_id` dropped; `reserved` is every store's total                                    |
| `reservation`                   | store        | (stock_item, warehouse, order / cart) | keeps `store_id` (who reserved) and `variant_id`; gains `allocation_rule`                                 |
| `stock_movement`                | pool ledger  | append-only                           | gains `stock_item_id`; `store_id` + `variant_id` nullable together (both NULL = no store caused the move) |

Availability for a store = the pool row's `available` (`on_hand − reserved`) of the item its variant maps. Store A
reserving N lowers store B's availability by N at once, because there is one row.

## Two migrations (D1: expand, then rekey)

- **`proposed/0190_stock_pool.sql` — expand, landable alone.** `stock_item`, the nullable column, the backfill,
  the three RLS kinds and the mapping guard. Nothing reads it; the inventory and catalog modules run unchanged.
- **`proposed/0191_stock_pool_rekey.sql` — rekey, lands only with window 1's inventory rewrite.** Backfill again
  (variants created since 0190), `stock_item_id` NOT NULL, the re-keyed tables above, the new-variant trigger.
- **Backfill (D2): 1:1, never an automatic merge.** The item's sku is the variant's when unique in the
  organization, else `<store code>:<sku>`. Pooling two brands is only ever an explicit `mapVariantToStockItem`.

## Row-level security

A plain `organization` predicate would let brand A read and write the stock of an item only brand B sells, so the
pool gets its own kinds in `app.apply_rls`:

| Session            | `stock_item` (`pool_self`), `inventory_level` (`pool`)     | `stock_movement` (`pool_ledger`)                                | `reservation` (`store`) |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| organization scope | every row of the organization                              | every row, and the only scope that writes a store-less movement | every row               |
| store scope        | only rows whose item a variant of an accessible store maps | such an item's movements ATTRIBUTED TO ITS OWN STORES only      | its own stores' rows    |

The pool predicate is `organization AND (scope = 'organization' OR EXISTS (SELECT 1 FROM product_variant v WHERE
v.stock_item_id = <the row's item>))`; the ledger adds `AND app.can_access_store(store_id)` on the store branch.
`product_variant`'s own policy (the `store` kind) limits the subquery to accessible stores and names no pool
table, so there is no recursion; `product_variant (stock_item_id)` is indexed.

**The mapping is the key to the pool, so it is guarded where the column is born (0190):** only organization scope
may insert a variant that is already mapped or change a mapping (`guard_variant_stock_item`, fail-closed — an
empty scope is refused too). A store session cannot INSERT a stock item either (nothing maps a row that does not
exist yet); its new variants get their own item from a SECURITY DEFINER trigger whose organization scope is the
function's own `SET` clause, restored by Postgres on return and on error.

On a shared item a store sees the pool's `reserved` total — never another store's reservation rows, never
another store's movements, never a movement no store caused (receipts, transfers, cycle counts: HQ only).

**Known property, not a defect:** a new variant's item is named `<store code>:<sku>` when the plain sku is taken,
so a store admin can learn that another brand of the same organization already has an item with that sku. Within
one organization that is acceptable.

## What changes for readers

- **Store API: no response changes shape.** `in_stock` / `available_quantity` are derived from the pool row.
- **Admin API (with 0191, `proposed/admin-api.stock-pool.yaml`):** new `listStockItems` (`viewer` on
  `organization:hq`) and `mapVariantToStockItem` (`operations` on `organization:hq`; 409 unless the variant's
  current item has zero on-hand and no open reservation at every warehouse; audit row; idempotent).
  `InventoryLevel` gains a required `stock_item_id` — additive; a row stays one variant in one warehouse, with the
  pool's numbers. `createStockMovement` is unchanged.
- **Events (with 0191, `proposed/stock.moved.v2.json`): `stock.moved` v2** — required `stock_item_id` + the item's
  `sku`; `variant_id` and `store_id` present together only when a store caused the movement. The envelope's
  `store_id` is already nullable and `outbox` is RLS kind `store_nullable`, so a pool movement with no store is an
  envelope with `store_id: null`, written in organization scope. v1 stays valid and is what the core emits until
  the rekey. New topic **`stock_item.mapped` v1** (`proposed/stock_item.mapped.v1.json`, ids only), written by
  `mapVariantToStockItem` in its transaction; the envelope enums gain the topic and aggregate type `stock_item`.
- **Seed (packages/db, at 0191):** levels are inserted by `stock_item_id` (looked up from the variant; the trigger
  has made the items), and one brand B variant is mapped onto a brand A variant's item in `wh-eu`, with a fixed
  id in `SEED_IDS`, so the gate has a shared item to sell from.
- **Lock order** for a placement touching several items: every pool row it needs, sorted by
  (`stock_item_id`, `warehouse_id`), one `SELECT … FOR UPDATE` — two brands' placements on a shared item queue.

## Allocation (after the decision)

A pure policy behind ONE seam in the inventory module (`setAllocationPolicy`, REQUEST to window 1): per line,
store override → destination country → region → priority, splitting across warehouses when one cannot cover the
line, never more than available, deterministic, with the rule that won recorded on `reservation.allocation_rule`.

## How to run

```bash
pnpm --filter @platform/core exec vitest run src/modules/hq-warehouse
```

`proposed-migrations.test.ts` seeds a throwaway database, applies 0190 then 0191 over the seeded data and asserts
the backfill, the mapping guard and every RLS rule above (34 tests). `testing/pool-database.ts` is the helper later tests build on.
Outside turbo, export `DATABASE_URL` / `DATABASE_URL_APP` on `127.0.0.1:5433` (the vitest default says `localhost`).
