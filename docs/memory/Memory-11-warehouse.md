# Memory 11 — Shared warehouse / WMS
Window: 11 · Key: `warehouse` · Branch prefix: `warehouse/` · Model: Sonnet
Last updated: 2026-10-12 · Contracts: contracts-v0.4.14 (Admin 0.4.12, Store 0.5.4, events 0.3.2, db 0.3.3) · Last commit: local only, nothing pushed · Status: #435 design done, CONTRACT CHANGE #453 + REQUEST #454 filed, WAITING for the manager to decide #453 (no engine code before that)

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/hq-warehouse/**`
- `apps/wms-adapter/**`
Reads:
- packages/events
- inventory module public API
Never touches:
- inventory internals

## Mission — Phase 3 (Multi-store & HQ)
Multi-brand allocation rules over shared stock locations, Odoo Inventory (or WMS) integration, scanner pick/pack flows, cycle counts.

## Done
- (nothing yet)

## In progress
- **#435 (task 3.1) — waiting for the manager's decision on #453.** Done so far (local commit, NOT pushed, no PR yet): design README, `proposed/0190_stock_pool.sql` + `proposed/0191_stock_pool_rekey.sql`, `proposed/stock.moved.v2.json`, `proposed/admin-api.stock-pool.yaml`, `testing/pool-database.ts`, `proposed-migrations.test.ts` (20 tests green on a seeded throwaway database), module CHANGELOG.
- **After the decision (in this order):** (1) fold any changes the manager makes to #453 into the proposed copies and the test; (2) the engine: pure `allocate()` behind index.ts in the #454 shape (store override → destination country → region → priority → split; rule per allocation), unit + property tests (never over-allocates, deterministic); (3) a LOCAL FAKE of the #454 seam (lock pool rows sorted by (stock_item_id, warehouse_id), build candidates, call the policy, validate, write reservations with `allocation_rule`) for the shared-pool integration test: two stores on one stock_item, A reserves N, B's availability drops by N, the last unit goes to exactly one of two racing placements; (4) README + CHANGELOG, local gate, merge main, ask before pushing, PR, then record "PR #N (code commit <sha>; head = this memory commit)".

## Next — Phase 3
- [ ] Allocation policy engine
- [ ] WMS adapter (Odoo Inventory)
- [ ] Scanner flows
- [ ] Cycle counts + reconciliation

## Decisions made (with reasons)
- **Manager rulings 2026-10-12 (plan confirmed):**
  - D1 = expand then rekey, TWO migrations in one issue. 0190 (landable alone): `stock_item`, nullable `product_variant.stock_item_id`, the backfill, nothing else. 0191 (lands ONLY with window 1's inventory rewrite): backfill again, NOT NULL, `inventory_level` keyed (stock_item_id, warehouse_id) with store_id dropped, `reservation` gains stock_item_id and keeps store_id, `stock_movement` gains stock_item_id with store_id nullable. Admin API additions land with 0191, not before.
  - D2 = 1:1 backfill, never an automatic merge; item sku = the variant's when unique in the organization, else `<store code>:<sku>`. `mapVariantToStockItem`: `operations` on `organization:hq`; 409 unless the variant's current item has zero on-hand and no open reservation at every warehouse; audit row; idempotent.
  - D3 = `stock.moved` v2 with 0191 (required stock_item_id + the item's sku; optional variant/store attribution); v1 stays what the core emits until the rekey. Envelope needs no diff (store_id already nullable; outbox is `store_nullable`).
  - RLS: plain `organization` kind REFUSED for the pool. Store scope reaches a pool row only when one of its stores maps the item; reservation stays `store` kind.
  - The manager files window 1's rekey task after deciding #453 and bundles #454 into it.
- **Mine, inside the rulings (listed as points 1–12 on #453 for the manager to overrule):** two RLS kinds `pool_self` / `pool`; a SECURITY DEFINER insert trigger gives a new variant its own item (the catalog creates variants in store scope, which may not insert a stock_item); a trigger refuses a store-scoped re-map; `inventory_level.variant_id` dropped with store_id; `reservation.allocation_rule` added; stock_movement store_id + variant_id nullable together (CHECK); v2 payload carries store_id next to variant_id; `InventoryLevel` stays per (variant, warehouse) + required `stock_item_id`; `createStockMovement` unchanged.

## Blocked / waiting
- #453 (CONTRACT CHANGE: db 0190 + 0191, stock.moved v2, Admin API) — the manager decides; engine code waits for it.
- #454 (REQUEST: `setAllocationPolicy` in the inventory module) — window 1, bundled into its rekey task; local fake meanwhile.

## Gotchas learned
- The seed has NO orders: a test reservation needs a bare `cart` row (organization, store, sales_channel, currency, locale, country).
- The seed's skus carry the store code, so no two brands share one; to test the collision rule a variant must be inserted BEFORE 0190 is applied (`createPoolDatabase('seeded')`, then `applyProposed`).
- A policy column cannot be dropped: 0191 drops `tenant_isolation` on inventory_level / stock_movement first and re-applies the `pool` kind after.
- `apps/core/test/guards.test.ts` fails on `UPDATE inventory_level` / `INSERT INTO stock_movement` outside the inventory module in NON-test files: the local fake of the seam must live in a `*.test.ts` file or under a path the guard skips — check before writing it.
- Long shell heredocs with backticks or quotes break the Bash tool here: write scripts and test files with the Write tool, run them by path.
- The catalog read model (window 1) sums `inventory_level.available` per variant (`catalog/service.ts:165`); after 0191 it must join through the stock item — window 1's change.

## How to run & test this package
- Setup (done 2026-10-12): `pnpm install --frozen-lockfile`; `pnpm -r --filter './packages/*' build`; `cp .env.example .env`. Never `pnpm dev` / docker here: the stack is shared.
- One file, outside turbo (~15 s): export DATABASE_URL and DATABASE_URL_APP with the two values from .env.example (127.0.0.1:5433), then `pnpm --filter @platform/core exec vitest run src/modules/hq-warehouse`.
- Gate: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test --filter @platform/core`. Live suites: ask the manager for the machine first, say "machine free" after.
