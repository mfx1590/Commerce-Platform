# Memory 11 — Shared warehouse / WMS
Window: 11 · Key: `warehouse` · Branch prefix: `warehouse/` · Model: Sonnet
Last updated: 2026-10-12 · Contracts: contracts-v0.4.14 + db 0.3.4 (Admin 0.4.12, Store 0.5.4, events 0.3.2) · Last commit: 1869c70 on main (#457); local memory commits since · Status: #436 built locally against the proposed copies (115 module tests); PR HELD until #456 lands; one open question with the manager (error code for superseded)

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
- **Task 3.1 part 1 — PR #457 MERGED = 1869c70 (2026-10-12; code commit 0c64b79, head 084b94a; Refs #435, review MERGE, 14/14 checks).** Design README, proposed 0191 + `stock.moved` v2 + `stock_item.mapped` v1 + Admin API fragment (CONTRACT CHANGE #453, decided), the allocation engine (`stockAwareAllocationPolicy`, REQUEST #454's shape), 66 tests. Migration 0190 landed separately: #455 = 25b0c39, db 0.3.4. **#435 stays OPEN until the pool is live** (window 1's #456: 0191, the inventory rewrite, the seam); then: `types.ts` → re-exports, the fake in `shared-pool.test.ts` → the real `reserveForOrder`, the remaining proposed files deleted.

## In progress
- **#436 code BUILT locally (not pushed; the PR is HELD until the manager says #456 has landed):** `cycle-counts.ts`, `http.ts` (`cycleCountsAdminRouter`), `cli/reconcile.ts`, `wms/index.ts`, `cycle-counts.test.ts` (29 green, local fake of `moveStock` in the test file). Module total: 28 + 34 + 8 + 16 + 29 = 115 tests.
- **OPEN with the manager (asked 2026-10-12, no answer yet):** `superseded` is NOT a contract error code (ERROR_CODES is a closed list; `src/lib/errors.ts` maps each to a status). The code answers 409 `conflict` with `details.reason = 'superseded'` and 422 `validation_error` (status override) for a future counted_at — my recommendation (a). `proposed/admin-api.cycle-counts.yaml` still shows `code: superseded` in its 409 example: update the yaml + the #458 body once the manager rules.
- **To raise before the PR:** mounting needs ONE line each in `src/http/module-routers.ts` (`routers.push(cycleCountsAdminRouter())`) and `src/wiring.ts` (`setStockMover(...)` adapter onto the inventory module's `moveStock`, and `setAllocationPolicy(stockAwareAllocationPolicy)`) — both files are window 1's, so check-ownership fails if I edit them: a REQUEST or a manager exception is needed.
- **When #456 is on main:** merge main; `pnpm install` + rebuild packages; delete the proposed copies that landed; `types.ts` → re-exports of the inventory module's seam types; replace BOTH fakes (the seam in `shared-pool.test.ts`, `fakeMoveStock` in `cycle-counts.test.ts`) with the real functions and assert the `stock.moved` outbox row of a reconciliation; drop the spec fallback in `http.ts` once admin-api.yaml carries the three operations; full local gate; ask before pushing.
- **#458 DECIDED 2026-10-12: ACCEPTED WITH TWO SMALL REQUIRED CHANGES, both done (revision 2, local commit):** `CHECK ((source = 'manual') = (counted_by IS NOT NULL))` and `REVOKE DELETE ON cycle_count FROM platform_app`, each tested (16 tests); the created_at limitation is in the README. Everything else accepted as written. 0192 + the Admin API additions land WITH the #436 PR, after #456. **Reconciliation code may now be written.** Window 1 had NOT yet commented the `moveStock` signature on #456 (only the manager's D1–D4 there: an HQ `createStockMovement` is store-less); build the `StockMover` port to the signature in the manager's ruling and re-check #456 before the PR.
- **#436 step 1 DONE (local commit, not pushed): CONTRACT CHANGE #458 filed 2026-10-12** — `proposed/0192_cycle_count.sql` (table + RLS kind `organization_only`), `proposed/admin-api.cycle-counts.yaml` (`createCycleCount`, `listCycleCounts`, `reconcileCycleCount`), README section, `proposed-cycle-count.test.ts` (13 green; applies 0192 WITHOUT 0191). `createPoolDatabase('0192')` = 0191 + 0192 for the code tests. Waiting for the manager's decision on #458; window 1's `moveStock` comment on #456 was not there yet at filing time — read it before coding the `StockMover` port. My own points 1–11 on #458 (three operations; flagged = 200; superseded at record time too; no fourth status; zero delta applied with no movement; `source` + nullable `counted_by`; movements since = `created_at > counted_at`).
- **#436 (task 3.2) — plan CONFIRMED by the manager 2026-10-12 with rulings (below). Order: design section + `proposed/0192_cycle_count.sql` + ONE CONTRACT CHANGE issue, message the manager when filed; code against the proposed copies. HOLD the #436 PR until the manager says #456 has landed** (an Admin API operation may not be on main before its route answers, and the routes need window 1's real `moveStock`). Then: merge main, replace the fake with the real `moveStock`, mount the router AND wire the allocation engine into the #454 seam in that same PR; the manager lands 0192 + the Admin API additions with it.
- **#436 rulings:**
  - D1 = build against a `StockMover` port with a local fake in TEST code. Window 1 is asked to export `moveStock(tx, { organizationId, stockItemId, warehouseId, delta, reason, referenceType?, referenceId?, note?, actor, storeId?, variantId? })` (storeId + variantId both or neither; returns the movement id and on_hand_after) and to confirm or correct it as a COMMENT ON #456 — build to what that comment says (read it before coding the port). A count's movement is store-less: reconcile runs in organization scope.
  - D2 = delta against on-hand AS OF the count: counted − (on_hand now − sum of movements after counted_at). Three guards: (1) recomputed under the pool row's lock at APPLY time — at reconcile AND again at approval — never from an earlier read; the row stores the final on_hand_as_of_count and delta; (2) counted_at in the future = 422; (3) 409 `superseded` when a LATER count for the same stock item + warehouse has already been applied. Tests for all three, plus: count at T, shipment after T, reconcile next morning → on-hand = counted − shipped. "On-hand equals the count" is asserted for the no-movement case only.
  - D3 = `organization.settings.warehouse.count_tolerance`: non-negative integer, absolute units of |delta|; unset or malformed = 0 (every non-zero discrepancy flagged until approved). Approval by `operations` on organization:hq; approver on the row and in the audit row.
  - D4 = new RLS kind `organization_only` (organization match AND organization scope) for cycle_count. Tests, each its own assertion: a store session cannot SELECT or INSERT a count even for an item it maps; organization scope can; another organization sees none.
  - D5 = NO new workspace package: `WmsAdapter { pullCounts(warehouse) }` + its in-memory implementation live in `hq-warehouse/wms/`, exported through index.ts. apps/wms-adapter is created when an Odoo instance exists (owner item); the manager amends #436.
  - Also: reconcile idempotent by count id; the six #457 follow-ups in the same PR.
- **The six #457 review follow-ups are DONE (local commit, rides with the #436 PR):** bad numbers and duplicate candidates refused with RangeError, the whole-line-first property, the "8 placements issued at once" wording, ranking described per line, the recorded-rule test on its own cart. allocation.test.ts = 28, shared-pool.test.ts = 8.
- **FROZEN: `proposed/0191_stock_pool_rekey.sql`, `proposed/stock.moved.v2.json`, `proposed/stock_item.mapped.v1.json`, `proposed/admin-api.stock-pool.yaml`** — window 1 builds #456 against them; a change is a message to the manager first, then window 1.
- Standing rulings (manager, 2026-10-12): the 4 hq-rbac live failures in a local full run are this worktree's environment (the core's vitest does not load the root .env; no `fga:seed` here) — CI decides, do not dig, do not touch the stack.

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
- #436 PR: held until the manager says #456 (window 1) has landed. The exact `moveStock` signature = window 1's comment on #456.
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
