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

### 2026-10-13 · on the landed pool (contracts-v0.4.15)

- main merged (#460: 0191, `stock.moved` v2, `stock_item.mapped` v1, the inventory rewrite). `types.ts`
  re-exports the seam's input types from the inventory module.
- Reconciliation moves stock through the inventory module's real `moveStock` by default
  (`inventoryStockMover`); `setStockMover` stays as a test seam. New tests assert the store-less movement and
  its one `stock.moved` v2 outbox row.
- `testing/pool-database.ts`: migrate + seed, with `'0192'` applying the still-proposed cycle-count migration.

### 2026-10-13 · no fakes left

- `shared-pool.test.ts` places through the inventory module's real `reserveForOrder` with the policy behind
  `setAllocationPolicy` (10 tests; new: whole-line-first, the store override, the 409's details).
- The module is 118 tests: allocation 28, proposed-migrations 34, shared-pool 10, proposed-cycle-count 16,
  cycle-counts 30 — all on throwaway databases migrated by packages/db, plus the proposed 0192.
- The engine is registered at boot since #461 (window 1's `src/wiring.ts`).

### 2026-10-13 · cycle counts are in the contract (contracts 0.4.16: db 0.3.6, Admin API 0.4.14)

- The two proposed copies are deleted (`proposed/0192_cycle_count.sql`, `proposed/admin-api.cycle-counts.yaml`);
  the `proposed/` folder is gone. `testing/pool-database.ts` is migrate + seed.
- `http.ts`: permissions and body validation come from `admin-api.yaml` only; the proposed fallback is removed.
- Test files renamed: `proposed-migrations.test.ts` → `stock-pool-schema.test.ts`,
  `proposed-cycle-count.test.ts` → `cycle-count-schema.test.ts`.

### 2026-10-13 · review fixes for the cycle-count landing (PR #463)

- **Double application fixed.** "Movements since the count" now means PHYSICAL movements: reason `cycle_count` is
  excluded. Before, approving an older count after a newer one was taken made the newer count's reconciliation
  read that adjustment as stock movement and apply the same discrepancy again.
- **New-shelf race fixed.** The pool row is created (at zero) and locked through the inventory module's
  `ensureLevel` before it is read; a first receipt committing in between was counted twice.
- The dry-run plan marks an open count that has a newer open count on the same shelf.
- `recordWmsCounts`: an unknown warehouse is `not_found`, not a bare Error.
- `cycle-counts.test.ts` runs entirely on the real `moveStock` (the fake is gone), 42 tests: both orders of two
  counts, three interleaved counts in three orders, a new discrepancy between counts, the missing pool row, the
  racing receipt, the inventory module's negative on-hand refusal as a 409 through the route.

### 2026-10-15 · follow-ups from the cycle-count review (#463)

- A `cycle_count` movement entered by hand (no count record links it) AFTER a count's `counted_at` now supersedes
  that count: 409 `conflict`, `details.reason = superseded`, `details.stock_movement_id` — at reconcile, at record,
  and in the dry-run plan. Two tests (after the count: refused; before the count: no effect).
- The racing-receipt test says what it proves (the numbers) and where the lock is verified (statically).
- README: reconciling a count in a deactivated warehouse answers 404.

### 2026-10-15 · reconcile preview (CONTRACT CHANGE #469, Admin API 0.4.16)

- `previewCycleCountReconcile` (`cycle-counts.ts`) and `GET /admin/cycle-counts/:cycleCountId/reconcile-preview`
  (`http.ts`, `operations` on organization:hq from the spec): reconcile's computation and superseded rule as a
  pure read — no lock, no pool row created, nothing written. `physicalMovedSince` is now shared with `readShelf`.
- Seven tests: a flagged preview writes nothing (counts, movements, outbox, audit, levels compared) and matches the
  `CycleCountPreview` schema; the previewed delta is what reconcile then applies; an applied count answers its
  stored values; 409 superseded; a shelf with no pool row reads 0 and stays without one; 404 (deactivated
  warehouse, unknown count), 400 (malformed id); 403 for a store admin, 401 without a token.
