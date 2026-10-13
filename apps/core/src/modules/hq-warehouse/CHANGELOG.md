# Changelog — hq-warehouse (window 11)

## Unreleased — Phase 3 (contracts-v0.4.14)

### 2026-10-12 · shared stock pool: design and proposed contract (#435)

- `README.md`: the design — `stock_item`, pool-keyed levels, store-scoped reservations, the `pool` RLS kinds.
- `proposed/0190_stock_pool.sql` (expand) and `proposed/0191_stock_pool_rekey.sql` (rekey), `stock.moved` v2 and
  the Admin API additions (`listStockItems`, `mapVariantToStockItem`), all proposed copies for the CONTRACT CHANGE.
- `proposed-migrations.test.ts`: both migrations applied over a seeded throwaway database; backfill and RLS
  assertions. No engine code yet.

### 2026-10-12 · revision 2 after the decision on #453 (accepted with four required changes)

- 0190 now carries the mapping guard (`guard_variant_stock_item`, INSERT and UPDATE, fail-closed) and the third RLS
  kind `pool_ledger`; 0191 puts `stock_movement` on it and takes the trigger's scope from the function's SET clause.
- New proposed event `stock_item.mapped` v1; `InventoryLevel` description; the README's RLS section rewritten.
- `proposed-migrations.test.ts`: 34 tests (guard with 0190 only, the ledger on a shared item, scope restoration).

### 2026-10-12 · the allocation policy engine (#435 part B)

- `allocation.ts`: `stockAwareAllocationPolicy` (pure, REQUEST #454's shape) and `rankWarehouses`; public API in
  `index.ts`, the seam's types in `types.ts` until the inventory module exports them.
- `allocation.test.ts` (24 tests, 500 seeded random cases) and `shared-pool.test.ts` (8 tests on the proposed
  schema, through a local fake of the seam: availability across brands, split, last-unit race, parallel placements).
- Not mounted: `src/wiring.ts` registers it once the seam exists.

### 2026-10-12 · 0190 is on main (db 0.3.4, contracts #455)

- `proposed/0190_stock_pool.sql` deleted; `testing/pool-database.ts` applies only the proposed 0191 on a database
  migrated by packages/db, and `proposed-migrations.test.ts` runs 0190's own backfill function over the seed.

### 2026-10-12 · cycle counts: design and proposed contract (#436)

- README section "Cycle counts and reconciliation"; `proposed/0192_cycle_count.sql` (table + RLS kind
  `organization_only`) and `proposed/admin-api.cycle-counts.yaml` (`createCycleCount`, `listCycleCounts`,
  `reconcileCycleCount`), the exact text of the CONTRACT CHANGE.
- `proposed-cycle-count.test.ts`: 13 tests on a throwaway database. No reconciliation code yet.

### 2026-10-12 · the #457 review's follow-ups

- The policy refuses NaN, infinite, fractional and unsafe-integer quantities and shelves, and two candidates for
  one warehouse on a line (RangeError: a caller's bug, never a guess).
- New property over the 500 seeded cases: a line goes whole to the FIRST ranked warehouse that covers it and is
  split only when none does. `allocation.test.ts` is 28 tests.
- Wording: the ranking is per line (the same order for every line of an order); "8 placements issued at once"
  (the test pool has 4 connections). `shared-pool.test.ts`: the recorded-rule test stands alone on its own cart.

### 2026-10-12 · cycle counts, revision 2 after the decision on #458

- `proposed/0192_cycle_count.sql`: a manual count must name its counter and a WMS pull must not (CHECK); the
  application role cannot DELETE a count. `proposed-cycle-count.test.ts` is 16 tests.

### 2026-10-12 · cycle counts and reconciliation: the code (#436)

- `cycle-counts.ts`: `createCycleCount`, `listCycleCounts`, `reconcileCycleCount` (one movement through the
  `StockMover` port, flag above the tolerance, approval, idempotent by count id, delta against on-hand as of the
  count, recomputed under the shelf's lock), `planOpenCounts`, `countTolerance`, `planReconciliation`.
- `http.ts`: `cycleCountsAdminRouter` (three operations, `operations` on `organization:hq`).
- `cli/reconcile.ts`: `--warehouse <code> --dry-run` prints the plan and writes nothing.
- `wms/`: `WmsAdapter { pullCounts(warehouse) }`, the in-memory adapter, `recordWmsCounts`.
- `cycle-counts.test.ts`: 29 tests on the proposed 0191 + 0192 with a local fake of `moveStock`.
- Not mounted: the router and the stock mover are wired once window 1's #456 is on main.

### 2026-10-12 · the pool's second step is in packages/* (0191, events, Admin API; with #456)

- The four proposed copies that landed are deleted (`proposed/0191_stock_pool_rekey.sql`, `stock.moved.v2.json`,
  `stock_item.mapped.v1.json`, `admin-api.stock-pool.yaml`); `testing/pool-database.ts` is migrate + seed.
- `proposed-migrations.test.ts` takes the seed's shared item into account (items = variants − 1, exactly one
  pooled pair) and tests the naming rule through the insert trigger instead of the backfill.
