# Memory 11 — Shared warehouse / WMS
Window: 11 · Key: `warehouse` · Branch prefix: `warehouse/` · Model: Sonnet
Last updated: 2026-10-12 · Contracts: contracts-v0.4.14 + db 0.3.4 (Admin 0.4.12, Store 0.5.4, events 0.3.2) · Last commit: local only, nothing pushed · Status: #435 PR up as Refs #435 (engine + design + proposed 0191); 0190 on main (db 0.3.4); waiting for CI and for window 1's #456

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
- **#435 (task 3.1) — PR going up as "Refs #435" (the manager gave the word to push 2026-10-12).** It carries the design README, the proposed 0191 + two event schemas + Admin API fragment, the engine (`allocation.ts`, `types.ts`, `index.ts`) and 66 tests. #435 itself closes only when the pool is live (after window 1's #456). PR number + code commit: see the line added after the push.
- **0190 is ON MAIN: #455 = 25b0c39, db 0.3.4.** main merged here; `proposed/0190_stock_pool.sql` deleted; `testing/pool-database.ts` applies only proposed 0191 on a database migrated by packages/db; `createTestDatabase` runs the real 0190 BEFORE the seed, so seeded variants have no item until the backfill (0191's first statement, or `SELECT app.backfill_stock_items()`).
- **FROZEN since 2026-10-12: `proposed/0191_stock_pool_rekey.sql`, `proposed/stock.moved.v2.json`, `proposed/stock_item.mapped.v1.json`, `proposed/admin-api.stock-pool.yaml`.** Window 1 builds #456 against them. Any change = a message to the manager FIRST, then to window 1. (0191's header comment still says the tests apply 0190 + 0191; left as is for that reason.)
- **Manager rulings on the engine (2026-10-12):** one shipment from a farther warehouse that covers the line beats a split from the nearest — CONFIRMED; the seeded 500-case property test without a new dependency is fine; the 4 failing hq-rbac live tests in the local gate are this worktree's environment (the core's vitest does not load the root .env, and this worktree never ran `pnpm --filter @platform/auth-sdk fga:seed`) — CI decides, do not dig, do not touch the stack; name them in the PR body.
- **Next:** (1) message the manager when every check on the PR has finished; (2) after #456 lands: `types.ts` becomes re-exports of the inventory module's seam types, the fake in `shared-pool.test.ts` is replaced by the real `reserveForOrder`, the remaining proposed files are deleted; (3) then #436 (cycle counts + reconciliation on the pool; WMS adapter interface, in-memory only).

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
- **#453 decision (2026-10-12), required changes, all done in revision 2:** R1 + R2 = `guard_variant_stock_item` in 0190 (INSERT and UPDATE OF stock_item_id; only organization scope maps; fail-closed, an empty scope refused — so the SEED must set app.scope = 'organization' to map the shared item); R3 = third RLS kind `pool_ledger` for stock_movement (a store session reads/writes only movements attributed to its own stores; store-less and other stores' movements are organization scope only); R4 = the SECURITY DEFINER trigger takes its scope from the function-level `SET app.scope = 'organization'` clause (Postgres accepts a custom parameter there), EXECUTE revoked. Additions: `stock_item.mapped` v1 event written by `mapVariantToStockItem` (envelope enums gain the topic + aggregate type `stock_item`); `InventoryLevel.id` is the pool row's and can repeat (key by variant_id + warehouse_id); the sku-existence property is recorded in the README. Not a DB constraint: `reservation.stock_item_id` = the variant's item at reserving time — window 1's module enforces it.
- **Accepted as I wrote them (points on #453):** kinds `pool_self` / `pool`; new-variant insert trigger; `inventory_level.variant_id` dropped with store_id; `reservation.allocation_rule`; stock_movement store_id + variant_id nullable together (CHECK); v2 payload carries store_id next to variant_id; `InventoryLevel` per (variant, warehouse) + required `stock_item_id`; `createStockMovement` unchanged.

## Blocked / waiting
- #453: 0190 landed (#455 = 25b0c39). 0191 + stock.moved v2 + stock_item.mapped v1 + Admin API land with window 1's #456.
- #454 (REQUEST: `setAllocationPolicy`) — bundled into window 1's #456; the engine is not mounted until then.

## Gotchas learned
- Local gate 2026-10-12 on aef9f51: lint, format:check, typecheck green; core tests 959 passed, 4 FAILED, all in window 2's live suites (hq-rbac roles.test.ts x3, scope.test.ts x1: `expected 503 to be 201` on a role assign) in this worktree with a fresh .env copy while OpenFGA and Keycloak answer 200. Not ours (nothing in hq-warehouse is imported there); reported to the manager, stack untouched. Every hq-warehouse test (66) passed in that run.
- The seed has NO orders: a test reservation needs a bare `cart` row (organization, store, sales_channel, currency, locale, country).
- The seed's skus carry the store code, so no two brands share one; to test the collision rule a variant must be inserted BEFORE 0190 is applied (`createPoolDatabase('seeded')`, then `applyProposed`).
- With `pool_ledger`, a store-scoped session cannot write a store-less movement: the local fake of the seam and any test fixture must attribute a store's movement to that store (store_id + variant_id together) or write it in organization scope.
- Trigger order is by NAME: `guard_variant_stock_item` must sort before `variant_stock_item` so the guard sees the value the session sent, not the one the trigger filled in.
- A policy column cannot be dropped: 0191 drops `tenant_isolation` on inventory_level / stock_movement first and re-applies the `pool` kind after.
- `apps/core/test/guards.test.ts` fails on `UPDATE inventory_level` / `INSERT INTO stock_movement` outside the inventory module in NON-test files: the local fake of the seam must live in a `*.test.ts` file or under a path the guard skips — check before writing it.
- Long shell heredocs with backticks or quotes break the Bash tool here: write scripts and test files with the Write tool, run them by path.
- The catalog read model (window 1) sums `inventory_level.available` per variant (`catalog/service.ts:165`); after 0191 it must join through the stock item — window 1's change.

## How to run & test this package
- Setup (done 2026-10-12): `pnpm install --frozen-lockfile`; `pnpm -r --filter './packages/*' build`; `cp .env.example .env`. Never `pnpm dev` / docker here: the stack is shared.
- One file, outside turbo (~15 s): export DATABASE_URL and DATABASE_URL_APP with the two values from .env.example (127.0.0.1:5433), then `pnpm --filter @platform/core exec vitest run src/modules/hq-warehouse`.
- Gate: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test --filter @platform/core`. Live suites: ask the manager for the machine first, say "machine free" after.
