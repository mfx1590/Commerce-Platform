# Memory 11 — Shared warehouse / WMS
Window: 11 · Key: `warehouse` · Branch prefix: `warehouse/` · Model: Sonnet
Last updated: 2026-10-15 · Contracts: contracts-v0.4.16 (Admin 0.4.14, Store 0.5.4, events 0.3.3, db 0.3.6) · Last commit: 30aa828 pushed (draft PR #462) · Status: HOLDING — #435 and #436 closed, follow-up #464 merged (bd21855); docket empty

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
- **Task 3.1 (#435) — CLOSED 2026-10-13.** PR #457 MERGED = 1869c70 (design, proposed contract, allocation engine; code commit 0c64b79). 0190 = #455 (25b0c39, db 0.3.4). The pool's second step = integration PR #460 = e9bada6 (contracts-v0.4.15; my landing commit fa50c4f cherry-picked). #461 = 7293ae5 registers `stockAwareAllocationPolicy` in `src/wiring.ts`. #453, #454 closed.
- **Task 3.2 (#436) — CLOSED 2026-10-15.** Draft PR #462 (code commit 30aa828; marked merged by GitHub) → integration PR #463 MERGED = 376e2f5 (contracts-v0.4.16: db 0.3.6 with 0192, Admin API 0.4.14; window 1 mounted `cycleCountsAdminRouter`). My landing commit 6dbe5ef and the review fix c4f6988 + b8566d9 (double application: "movements since" are PHYSICAL only, reason cycle_count excluded; new-shelf race: pool row through `ensureLevel` before it is read; tests all on the real `moveStock`). CONTRACT CHANGE #458 closed.

## In progress
- **HOLDING (manager, 2026-10-15): docket empty.** Follow-up PR #464 MERGED = bd21855 (code commit d98fc7f). main merged here (fast-forward). The Odoo adapter waits for an instance (owner item); scanner flows are window 4's.

## For window 4 — admin screens for the stock pool and cycle counts (written for the manager's brief, 2026-10-15)
All operations are in Admin API 0.4.14 (contracts-v0.4.16); permissions come from each operation's `x-permission`. Errors are `{ code, message, details }`; show `message` and use `details` as below.

**Stock items (HQ screen)**
- Read: `GET /admin/stock-items` (`listStockItems`, `viewer` on organization:hq) — filters `sku` (substring), `store_id` (items a store maps), `shared=true` (mapped by more than one store), paging. Each `StockItem` = id, sku (unique per organization; `<store code>:<sku>` when the plain sku was taken), name, barcode, `variants[]` (variant_id, store_id, the variant's own sku) and `levels[]` per warehouse (on_hand, reserved = EVERY store's reservations, incoming, available).
- Action: `PUT /admin/stock-items/{stockItemId}/variants/{variantId}` (`mapVariantToStockItem`, `operations` on organization:hq) — "pool this variant onto this item". Idempotent (already mapped → 200, nothing written). Show its 409 (`conflict`, details `stock_item_id`, `on_hand`, `open_reservations`) as "the variant's current item still holds stock or open reservations — move the stock first"; 404 for an unknown item or variant. Confirm before mapping: it changes which shelf a brand sells from.
- Store admins never see an item only another brand maps; an HQ user sees all.

**Inventory levels (store screen, existing)**
- `GET /admin/inventory/levels` rows stay one per (variant, warehouse) but carry the POOL's numbers and `stock_item_id`. `id` is the pool row's and REPEATS when two variants in one response share an item: key rows by (variant_id, warehouse_id), never sum on_hand / reserved / available across variants. Worth a "shared with N stores" badge (from `listStockItems`).
- `POST /admin/inventory/movements` (`createStockMovement`, HQ `operations`): an HQ movement is store-less. Advise against reason `cycle_count` here — a hand correction with that reason after an open count supersedes that count (see below); counts belong in the cycle-count screen.

**Cycle counts (HQ screen; `operations` on organization:hq for all three; a store admin gets 403)**
- Read: `GET /admin/cycle-counts` (`listCycleCounts`) — filters `warehouse_id`, `stock_item_id`, `status` (recorded | flagged | applied), paging, newest count first. Show sku, counted_quantity, counted_by (null = a WMS pull, `source: wms`), counted_at, status, and after reconciliation `on_hand_as_of_count`, `delta` (signed), `stock_movement_id`, `approved_by` / `approved_at`.
- Action 1 "Record a count": `POST /admin/cycle-counts` (`createCycleCount`) — warehouse_id, stock_item_id, counted_quantity (integer ≥ 0), optional counted_at (default now) and note. Changes NO stock.
- Action 2 "Reconcile": `POST /admin/cycle-counts/{id}/reconcile` with no body. Answer 200 with status `applied` (one movement of `delta`; none when delta is 0) or `flagged` (|delta| above `organization.settings.warehouse.count_tolerance`, units; unset = 0 → every non-zero discrepancy is flagged). Reconciling an applied count is a no-op 200.
- Action 3 "Approve": same route with `{ "approve": true }` — applies whatever the delta is NOW (it is recomputed at approval, so the number may differ from the flag's); the approver is recorded. Show the current delta before the button and confirm.
- Errors to show:
  - 409 `conflict` with `details.reason = 'superseded'`: "a newer count of this shelf is already applied" (`details.applied_cycle_count_id`) or "the stock was corrected by hand after this count" (`details.stock_movement_id`). The count can never be applied; it stays as a record.
  - 409 `conflict` without that reason: the inventory module refused the movement (on-hand would go negative — more shipped since the count than was counted). Re-count.
  - 422 `validation_error` with `details.field = 'counted_at'`: the count's time is in the future.
  - 404: unknown count, warehouse or stock item — and reconcile of a count in a DEACTIVATED warehouse.
  - 400 `validation_error`: malformed body or query (the Prism mock answers 422 with the counted_at example instead — mock only).
- UI advice: when a shelf has several open counts, reconcile the NEWEST (older ones then answer 409 superseded); the dry-run CLI marks this too. The delta is measured against on-hand AS OF the count (what moved physically since is accounted for), so a count reconciled the next morning is still right.

**Placements (read-only info for the order screens)**
- `reservation.allocation_rule` says why a warehouse was chosen: `store_country`, `store_default`, `same_country`, `same_region`, `priority`; `split:<rule>` for the second and later warehouse of a split line; `backorder` for a shortfall reserved anyway. Not yet exposed by an Admin API read as far as I know — a CONTRACT CHANGE if window 4 wants to show it.

## Lessons that cost time here (keep)
- A side branch the manager cherry-picks from cannot be rebased once pushed (no force-push): merge the integration head into it, then commit; say so.
- Check every scripted edit's exit BEFORE committing: one docs script failed inside an `&&` chain and a commit went out without its docs (c4f6988 + b8566d9).
- When git says "not a git repository" in a worktree: STOP, change nothing, tell the manager (2026-10-13: the worktree registry was deleted by a repo script run under WSL bash).
- `freshItem()`-style fixtures run out: size them for the whole file (cycle-counts.test.ts uses LIMIT 200).

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
- Nothing. The Odoo adapter waits for an instance (owner item).

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
