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
