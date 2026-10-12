# Changelog — hq-warehouse (window 11)

## Unreleased — Phase 3 (contracts-v0.4.14)

### 2026-10-12 · shared stock pool: design and proposed contract (#435)

- `README.md`: the design — `stock_item`, pool-keyed levels, store-scoped reservations, the `pool` RLS kinds.
- `proposed/0190_stock_pool.sql` (expand) and `proposed/0191_stock_pool_rekey.sql` (rekey), `stock.moved` v2 and
  the Admin API additions (`listStockItems`, `mapVariantToStockItem`), all proposed copies for the CONTRACT CHANGE.
- `proposed-migrations.test.ts`: both migrations applied over a seeded throwaway database; backfill and RLS
  assertions. No engine code yet.
