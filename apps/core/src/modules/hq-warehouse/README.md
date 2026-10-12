# hq-warehouse — the shared stock pool and stock-aware allocation (window 11, #435)

**Status: step 1 of the pool is on main; the rest is built against the proposed contract.** CONTRACT CHANGE #453
is decided: migration 0190 landed as db 0.3.4; 0191, the two event schemas and the Admin API additions (still
under `proposed/`) land with window 1's inventory rewrite (#456), which also brings the allocation seam (REQUEST
#454). #435 closes when the pool is live. Owner: window 11 (`apps/core/src/modules/hq-warehouse/**`,
`apps/wms-adapter/**`).

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

- **`packages/db/migrations/0190_stock_pool.sql` — expand, ON MAIN since db 0.3.4.** `stock_item`, the nullable column, the backfill,
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

## Allocation (`allocation.ts`, public API in `index.ts`)

`stockAwareAllocationPolicy(context, lines)` is a pure function in the shape of REQUEST #454: the inventory module
locks the pool rows, hands over each line's candidates (the locked rows' `available`), and enforces the answer.

1. **Rank each line's candidate warehouses** (the same order for every line of an order) by the fulfillment module's routing rules (its `routingSettingsFrom` and
   `regionOf`, through its public API): store override for the destination country → store default → same
   country → same region → the rest; `priority`, then `code`, then id break ties.
2. **Per line: one warehouse if one can cover the whole line** — the first in the ranking that can. One shipment
   from a farther warehouse beats a split from the nearest (manager, 2026-10-12): with 3 on the `same_country`
   shelf and 9 on a `priority` one, a line of 4 goes whole to the latter and is recorded as `priority`.
3. **Otherwise split** — only when no single ranked warehouse covers the line — greedily down the ranking. Never more than a shelf holds; what an earlier line of the same
   order took from a stock item is gone for the next (two variants of one order can map to one item).
4. **What is left is the line's `shortfall`.** Out of stock or backorder is the inventory module's call.

The rule is recorded per allocation and stored on `reservation.allocation_rule`: `store_country`,
`store_default`, `same_country`, `same_region` or `priority` for a line's first warehouse, and the same
prefixed with `split:` for every further one.

**Not mounted yet.** The seam does not exist until window 1's rekey lands; then `registerModuleSeams()` in
`src/wiring.ts` gains `setAllocationPolicy(stockAwareAllocationPolicy)`. Until then `shared-pool.test.ts` drives
the policy through a local fake of that seam, on the proposed schema.

## Cycle counts and reconciliation (#436, CONTRACT CHANGE #458)

Somebody counts a stock item on a shelf; the count is written down; reconciliation turns the difference into
**exactly one `stock_movement`** (reason `cycle_count`, no store, its `stock.moved` in the same transaction).
A level is never edited directly. Code: `cycle-counts.ts` (service), `http.ts` (`cycleCountsAdminRouter`),
`cli/reconcile.ts`, `wms/`. Contract, still proposed: `proposed/0192_cycle_count.sql`,
`proposed/admin-api.cycle-counts.yaml`. **Not mounted yet:** the router and `setStockMover` are wired when
window 1's pool-addressed `moveStock` (#456) is on main.

| Step      | Operation (`operations` on `organization:hq`) | Effect                                                                         |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| record    | `createCycleCount`                            | a `cycle_count` row, status `recorded`; no stock changes                       |
| reconcile | `reconcileCycleCount`                         | within tolerance → one movement, `applied`; above → nothing moves, `flagged`   |
| approve   | `reconcileCycleCount` with `approve: true`    | recomputes and applies whatever the delta is; approver on the row and in audit |
| read      | `listCycleCounts`                             | by warehouse, stock item, status; newest count first                           |

- **The delta is measured against on-hand as of the count, not on-hand now:** `delta = counted − (on_hand now −
movements written since counted_at)`. A count taken at 18:00 and reconciled the next morning ignores what
  shipped overnight; measuring against on-hand now would put those units back on the shelf.
- **Computed under the pool row's lock at apply time** — at reconcile and again at approval — never taken from
  an earlier read. The row keeps the final `on_hand_as_of_count` and `delta`.
- **`counted_at` may not be in the future** (422).
- **`superseded` (409, `code: conflict`, `details.reason: superseded`):** a count is refused, at record and at reconcile, when a count of the same stock item and
  warehouse with the same or a later `counted_at` is already applied. Otherwise the newer count's own adjustment
  would be read as "a movement since the old count" and the old discrepancy applied a second time.
- **Known limitation (accepted, manager 2026-10-12):** "movements since `counted_at`" compares with
  `stock_movement.created_at`, the writing transaction's start time, so a movement that began before the count
  and committed after it is treated as before the count.
- **A count is a record:** the application role cannot delete one; a manual count names who counted, a WMS pull
  names nobody.
- **Tolerance:** `organization.settings.warehouse.count_tolerance`, a non-negative integer, units of |delta|.
  Unset or malformed = 0: every non-zero discrepancy waits for an approval.
- **Idempotent by count id:** `cycle_count.stock_movement_id` (UNIQUE) is the link; reconciling an applied count
  changes nothing. A zero delta is `applied` with no movement (the ledger refuses a zero movement).
- **Who writes the movement:** the inventory module's pool-keyed `moveStock` — the only writer of `on_hand` —
  through a `StockMover` port. It arrives with window 1's #456; until then tests use a local fake.
- **RLS `organization_only`** (new kind: organization match AND organization scope): counts are an HQ record; a
  store session can neither read nor write one, not even for an item it maps.
- **CLI:** `cli/reconcile.ts --warehouse wh-eu --dry-run` prints the plan (count, on-hand as of the count, delta,
  apply or flag) and writes nothing.
- **WMS:** `wms/` holds `WmsAdapter { pullCounts(warehouse) }` and an in-memory implementation, exported through
  `index.ts`. `apps/wms-adapter` becomes a package when an Odoo instance exists (manager, 2026-10-12).

## How to run

```bash
pnpm --filter @platform/core exec vitest run src/modules/hq-warehouse
```

| File                           | What it proves                                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allocation.test.ts`           | every rule in order, single warehouse vs split, shortfall, 500 seeded random cases (never over-allocates, deterministic), bad numbers and duplicate candidates refused — 28 tests, no database                                          |
| `proposed-migrations.test.ts`  | 0190's backfill, then proposed 0191, over the seeded data: backfill, the mapping guard, every RLS rule above — 34 tests                                                                                                                 |
| `shared-pool.test.ts`          | two brands on one item: A reserves N and B's availability drops by N, the split, the last-unit race, 8 placements issued at once, no deadlock — 8 tests                                                                                 |
| `proposed-cycle-count.test.ts` | proposed 0192 on main's schema alone: the `organization_only` RLS and the CHECKs that hold a count together, no DELETE — 16 tests                                                                                                       |
| `cycle-counts.test.ts`         | count → reconcile → one movement, idempotency, tolerance and approval, on-hand as of the count and its three guards, the router (operations vs store admin), the dry-run CLI, the WMS pull — 29 tests, with a local fake of `moveStock` |

The two database files seed a throwaway database (`testing/pool-database.ts`). Outside turbo, export
`DATABASE_URL` / `DATABASE_URL_APP` on `127.0.0.1:5433` (the vitest default says `localhost`).
