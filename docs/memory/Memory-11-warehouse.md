# Memory 11 — Shared warehouse / WMS
Window: 11 · Key: `warehouse` · Branch prefix: `warehouse/` · Model: Sonnet
Last updated: 2026-10-13 · Contracts: contracts-v0.4.15 (Admin 0.4.13, Store 0.5.4, events 0.3.3, db 0.3.5) · Last commit: 30aa828 pushed (draft PR #462) · Status: 3.1 (#435) closed; 3.2 = DRAFT PR #462, waiting for the manager's 0192 + Admin API commit and window 1's router mount

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
- **Task 3.1 (#435) — CLOSED 2026-10-13.** PR #457 MERGED = 1869c70 (design, proposed contract, allocation engine; code commit 0c64b79). Migration 0190 = #455 (25b0c39, db 0.3.4). The pool's second step = integration PR #460 MERGED = e9bada6 (contracts-v0.4.15: db 0.3.5 with 0191, events 0.3.3, Admin API 0.4.13; window 1's inventory rewrite #456/#459; my landing commit fa50c4f cherry-picked). Window 1's #461 MERGED = 7293ae5 registers `stockAwareAllocationPolicy` in `src/wiring.ts`. CONTRACT CHANGE #453 and REQUEST #454 closed.

## In progress
- **NEXT, on the manager's signal (2026-10-13): the manager assembles `integration/cycle-counts` on top of 83b7324 (0192 with a new header, Admin API 0.4.14 / contracts 0.4.16, db 0.3.6, RLS tests) and sends me its sha.** Then ONE commit on a side branch `warehouse/phase3-cycle-counts` CUT FROM THAT SHA (pushed, no PR): delete `proposed/0192_cycle_count.sql` and `proposed/admin-api.cycle-counts.yaml`; drop the spec fallback in `http.ts` (`specHas`, `PROPOSED_PERMISSION`; `validated` just calls `validateBody`); `testing/pool-database.ts` = createTestDatabase + seed with no `'0192'` option (and `createPoolDatabase('0192')` callers in the two cycle tests → `createPoolDatabase()`); run the module; report the sha (as the last turn if messages are blocked). UNTIL the signal: the machine is the manager's — run NO suites; no push to warehouse/phase3; no db:migrate, pnpm dev, docker. (This memory commit is local only.)
- **#436 (task 3.2) — DRAFT PR #462 (code commit 30aa828; head = this memory commit), "Refs #436", pushed 2026-10-13 on the manager's word.** It is a draft because it needs two things from others, named in its body: (1) the manager's contracts commit — migration 0192 + the Admin API additions (CONTRACT CHANGE #458; exact text in `proposed/0192_cycle_count.sql` and `proposed/admin-api.cycle-counts.yaml`); (2) window 1's mount in `src/http/module-routers.ts`: `import { cycleCountsAdminRouter } from '../modules/hq-warehouse'` + `routers.push(cycleCountsAdminRouter())`. Nothing else: reconciliation calls the inventory module's real `moveStock` by default (`inventoryStockMover`; `setStockMover` is a test seam).
- **When both are on the branch / on main:** delete the two proposed copies, drop the spec fallback in `http.ts` (`specHas`, `PROPOSED_PERMISSION`), remove the `'0192'` option from `testing/pool-database.ts` (and the name `proposed-*.test.ts` is then history — rename or leave, ask), re-run the module + gate, push only when the manager says.
- **Local gate on 30aa828 (2026-10-13, one detached run):** lint, format:check, typecheck green; core tests 1042 passed, 4 FAILED, 8 skipped; all 118 hq-warehouse tests passed (allocation 28, proposed-migrations 34, shared-pool 10, proposed-cycle-count 16, cycle-counts 30). The 4 failures are window 2's live hq-rbac suites again (role assign → 503) — ruled this worktree's environment on #457; sourcing .env before the run and `fga:seed` did NOT change it (turbo passes only DATABASE_URL* to the test task). CI decides.
- **No fakes left:** `shared-pool.test.ts` goes through the real `reserveForOrder` + `setAllocationPolicy` (orders are bare fixture rows inserted by the owner role); `cycle-counts.test.ts` keeps `fakeMoveStock` for most tests and has a block on the real `moveStock` (store-less movement, one `stock.moved` v2 outbox row).
- **HARD RULES (manager, 2026-10-13):** no `db:migrate`, no `pnpm dev`, no docker commands — the shared dev database has NOT run 0191 (owner's OK pending); the manager runs the first migrate, then says so. `warehouse/phase3-rekey` is spent. Report to "Manager session six"; if outgoing session messages are blocked (the app pauses them after ~10 in a row until the owner types here), write the report as the last turn — the manager reads it there.
- Facts from window 1's work: `lockStock(tx, { organizationId, storeId, variantIds, stockItemIds?, ensureWarehouseId? })` is THE lock order (variants FOR SHARE by id, missing pool rows created first, then pool rows by stock_item_id, warehouse_id) — a reconciliation locks one pool row, so no ordering issue today; never `INSERT ... ON CONFLICT DO NOTHING` into product_variant (0191's trigger leaves an orphan item); 0191 on main refuses an insert whose product is not the variant's own store's (42501).

## Next — Phase 3
- [x] Allocation policy engine (#435, registered at boot since #461)
- [ ] Cycle counts + reconciliation (#436, draft PR #462)
- [ ] WMS adapter (Odoo Inventory) — interface + in-memory only (in #462); the real adapter and the `apps/wms-adapter` package wait for an Odoo instance (owner item)
- [ ] Scanner flows — admin UI, window 4, later

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
- #462 (draft): the manager's 0192 + Admin API commit, and window 1's router mount. Then the cleanup listed under In progress.
- CI on #462: report to the manager when every check has finished (read with the app's PR status; do not poll).

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
