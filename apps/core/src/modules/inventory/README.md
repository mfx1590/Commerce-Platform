# inventory — the shared stock pool: levels, movements, reservations, allocation (window 1; #106, re-keyed by #456)

Stock lies in a **pool**: one `inventory_level` row per (**stock item**, warehouse) — `available` is GENERATED
`on_hand − reserved` — and every variant that maps the item sells from it, whichever store the variant belongs to
(db 0190 + 0191, CONTRACT CHANGE #453). `stock_item` is organization-level (the thing that physically lies on a
shelf); a variant points at one through `product_variant.stock_item_id`. A new variant gets its own item from a
database trigger (1:1, never an automatic merge); two brands share an item only through the explicit
`mapVariantToStockItem`. Next to the pool: the append-only ledger (`stock_movement`; 0009 revokes UPDATE/DELETE
from the app role) and the reservations held by unshipped orders.

## The pool and who may reach it

A store's variants are the only way into the pool. Every function resolves variant → `stock_item_id` first
(`variantStock`, the store's own variants only), and row security does the rest:

| Table             | RLS kind      | A store session sees / writes                                                                         |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `stock_item`      | `pool_self`   | items one of its variants maps (it cannot insert one: the trigger does, in organization scope)        |
| `inventory_level` | `pool`        | the pool rows of those items — including `reserved`, the total of EVERY store's open reservations     |
| `reservation`     | `store`       | its own reservations only: a store sees how much of a shared item is reserved, never who reserved it  |
| `stock_movement`  | `pool_ledger` | movements of items it maps AND attributed to one of its stores; nothing store-less, nothing of others |

Organization scope (HQ) sees all of it. **The module never changes the scope it is given**: it takes the caller's
transaction, writes what that transaction may write, and lets the database refuse the rest (a refused ledger row
comes back as 403, an invisible item as 404, another store's variant as `unknown variant`).

## Rules

- **`on_hand` changes only through `moveStock()`**: the pool row is locked (`FOR UPDATE`, created at zero when
  missing), `on_hand += delta`, one `stock_movement` row appended, one **`stock.moved` v2** emitted, all in the
  caller's transaction. `on_hand` may go negative only through `sale` (a backorder being shipped); any other
  reason that would cross zero → 409 `conflict`. A guard test fails on `UPDATE inventory_level` or
  `INSERT INTO stock_movement` outside this module.
- **Attribution (the ledger policy).** A movement is attributed to a store AND its variant, or to neither (the
  ledger's CHECK). A movement a store caused — a sale, a return, a shipment release — carries that store's
  `store_id` + `variant_id` and is written in that store's scope. A movement **no store caused** — a receipt, a
  transfer, a cycle count, an HQ adjustment — carries neither and can only be written in organization scope; in
  store scope the database refuses it and no flow of this module attempts one. `stock.moved` v2 follows:
  required `stock_movement_id`, `stock_item_id`, `sku` (the ITEM's), `warehouse_id`, `delta`, `reason`,
  `reference_type/id`, `on_hand_after`, `reserved_after`; `variant_id` + `store_id` together when a store caused
  it, both absent otherwise (envelope `store_id` null). v1 is no longer emitted.
- **Consequence, accepted (manager, 2026-10-12):** a store admin's stock history shows the store's own attributed
  movements only. HQ receipts and adjustments move the pool row's totals — which the store does see — but their
  ledger rows are organization scope. Showing HQ movements to store admins is a later, explicit decision.
- **A reservation is not a movement.** Reserving raises the pool row's `reserved`; `on_hand` and the ledger are
  untouched, no event. A reservation records who reserved (`store_id`, `variant_id`), which pool row
  (`stock_item_id`) and why that warehouse (`allocation_rule`).
- **`reservation.stock_item_id` is the item of `reservation.variant_id` at the time of reserving.** No database
  constraint can say it (a composite key would break re-mapping: released reservations keep their history), so
  the module enforces it: the variant rows are SHARE-locked while their stock is reserved, the item is read from
  the variant IN the insert, and a mismatch fails the placement. Re-mapping takes the variant row FOR UPDATE, so
  the two queue.
- **Lock order, one for everybody (`lockStock`).** Every path that touches more than one pool row — placement,
  cancel, ship, a cancelled shipment, the returns module's restock — takes its locks UP FRONT in the same three
  steps: (1) the variant rows, `FOR SHARE`, in id order (`mapVariantToStockItem` takes its one variant
  `FOR UPDATE`); (2) where a pool row may have to be CREATED — a backorder on an item with no row, a restock into
  a warehouse the item never lay in — the missing rows are inserted first, in `stock_item_id` order: nothing
  creates a row once a lock is held; (3) every pool row of the items involved, active warehouse or not, in
  **(`stock_item_id`, `warehouse_id`)** order, in one `SELECT … FOR UPDATE`. Nothing locks pool rows one at a time
  in another order (a single-row `moveStock` has nothing to order). Two transactions on overlapping items — two
  stores placing, a shipment cancel against a placement — queue behind each other instead of deadlocking (tested:
  a shipment release and a placement that would take two shared pool rows in opposite order, made deterministic
  with a gate — it ended in `40P01` before the release locked up front; placements from two stores on two shared
  items in opposite line orders; 8 parallel placements in shuffled order; parallel backorders on items with no
  rows).

## Allocation: the policy decides, the module enforces (`setAllocationPolicy`, REQUEST #454)

WHICH warehouse serves a line is a policy; that the decision is honest is this module's job.
`reserveForOrder` (1) locks the pool rows, (2) builds the **candidates from the locked rows** — every ACTIVE
warehouse of the organization, including those where the item has no row yet (`available` 0) — (3) calls the
policy once per placement with every inventory-managed line and the order's context (destination country, the
store's `settings.fulfillment.routing` as stored), (4) **validates the decision**, (5) writes one reservation per
allocation with its `allocation_rule`.

- `setAllocationPolicy(fn)` replaces the policy and returns the previous one — a registry write like the cart's
  `setPriceResolver` / `setDiscountEvaluator`; no I/O. Window 11's stock-aware engine registers itself in
  `src/wiring.ts`. Types: `AllocationCandidate`, `AllocationLine`, `AllocationContext`, `AllocationDecision`,
  `AllocationPolicy` (pure and synchronous: no database, no clock, no randomness).
- **Default: `priorityGreedyPolicy`** — warehouses in priority order (then code), each giving what it has; the
  behaviour before the seam existed, unchanged. Rules `priority` / `split:priority`. Two lines of one placement
  that map the same item draw from one running balance.
- **A bad decision is a bug — 500 `internal`, never a customer error**, and the placement rolls back: not exactly
  one decision per line, a warehouse that was not offered, a quantity that is not a positive integer, two entries
  on one warehouse, a missing rule, `sum + shortfall ≠ quantity`, or more than a locked row had available —
  summed per (stock item, warehouse) ACROSS lines, so a unit cannot be promised twice.
- **Shortfall stays the module's**: not backorderable → 409 `out_of_stock` `{ variant_id, available }` and the
  whole placement rolls back (the checkout voids the payment authorisation on that path); backorderable → the
  shortfall is reserved on the item's first pool row in warehouse priority order (rule `backorder`) — an item
  with no row in any active warehouse gets one, at zero, in the priority warehouse before the locks are taken —
  `available` goes negative, `backorderQuantity` in the result.

## Public API (`index.ts`)

| Function                                                                                               | Who calls it                                                            | What it does                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserveForOrder(tx, { organizationId, storeId, orderId, lines })`                                     | checkout, inside the placement transaction after the order lines exist  | the stock check at placement, through the allocation policy (above). A variant that is not the store's → 400 `unknown variant` before anything is locked. `manage_inventory = false` → no reservation.                                                    |
| `releaseForOrder(tx, orderId)`                                                                         | the orders module's `cancelOrder` (its own transition — never window 8) | releases every open reservation of the order on its own pool row (`reserved −= q`, `released_at`), idempotent                                                                                                                                             |
| `consumeForShipment(tx, { organizationId, storeId, orderId, shipmentId?, lines, actor })`              | window 8 at ship time                                                   | shrinks / closes the order's reservations (preferred warehouse first, then priority) and `moveStock(reason 'sale')` per pool row, attributed to the store; more than reserved → 409 `conflict`                                                            |
| `consumeReservationsForShipment(tx, { …, shipmentId, warehouseId?, items, actor })`                    | window 8 (#191's `consumeReservations` shape)                           | by order line item; **idempotent per shipment** (the store's own `sale` movement for the shipment already exists → skipped)                                                                                                                               |
| `releaseReservationsForShipment(tx, { …, shipmentId, items, actor })`                                  | window 8 (#191's `releaseReservations` shape)                           | a planned shipment cancelled before picking: the goods go back on the SAME pool row they left (`adjustment`, `shipment_release:<id>`, attributed), the reservation re-opens. Same replay rules as before. A variant re-mapped since → 409 (see Decisions) |
| `moveStock(tx, { organizationId, storeId?, variantId?, stockItemId?, warehouseId, delta, reason, … })` | `consumeForShipment`, the returns module (`return`), HQ flows           | the only writer of `on_hand`. `storeId` + `variantId` → attributed, on the variant's item; neither → a pool movement no store caused, needs `stockItemId` and organization scope                                                                          |
| `availableByVariant(tx, variantIds)`                                                                   | cart, marketing feed items, search records                              | what each variant can sell now: `available` summed over the active warehouses of its item's pool rows. The one availability read for other modules — nobody else joins the pool tables                                                                    |
| `lockStock(tx, { organizationId, storeId, variantIds, stockItemIds?, ensureWarehouseId? })`            | this module; the returns module before its restock                      | takes the locks of a multi-row stock operation in THE lock order (Rules) and returns the store's variants with their items and the locked pool rows                                                                                                       |
| `ensureLevel(tx, { organizationId, stockItemId, warehouseId }, lock)`                                  | this module                                                             | the pool row, created at zero; 404 for an item the session cannot see (nothing written)                                                                                                                                                                   |
| `setAllocationPolicy(fn)` / `priorityGreedyPolicy`                                                     | `src/wiring.ts` (window 11's engine), tests                             | the allocation seam (above)                                                                                                                                                                                                                               |
| `listInventoryLevels` / `createStockMovement` / `listStockItems` / `mapVariantToStockItem`             | Admin API routes                                                        | see below                                                                                                                                                                                                                                                 |

## Store availability

The catalog read model computes `in_stock` / `available_quantity` from the pool rows of the variant's stock item,
summed over active warehouses — the same shape as before. A reservation by ANY store that maps the item lowers
the Store API's `available_quantity` for every variant on it immediately; `in_stock` flips at 0 (a backorderable
variant stays `in_stock` with `available_quantity: 0`).

## Admin API

- `GET /admin/inventory/levels` (`listInventoryLevels`, `viewer` on `store:{store_id}`, `store_id` an optional
  query — the permission and scoping are unchanged): **one row per (variant, warehouse)** of the variants the
  caller may see, each carrying the numbers of its item's pool row and `stock_item_id`. `id` is the pool row's:
  two variants that share an item repeat it and show the same numbers — key rows by (`variant_id`,
  `warehouse_id`) and never sum across variants. Filters `store_id`, `warehouse_id`, `variant_id`, `sku`
  (the variant's, substring), `below_available`; `sort` sku | available | on_hand + `order`.
- `POST /admin/inventory/movements` (`createStockMovement`, `operations` on `organization:hq`; organization scope
  only): body `variant_id`, `warehouse_id`, `delta`, `reason` ∈ receipt | adjustment | transfer_in | transfer_out
  | cycle_count, `note`. Addressed by variant, the movement lands on that variant's stock item and is **store-less**
  (no store caused it): ledger `store_id` / `variant_id` NULL, envelope store null. One audit row
  (`stock_movement.create`, no store) keeps the variant it was addressed by. 201 `InventoryLevel`.
- `GET /admin/stock-items` (`listStockItems`, `viewer` on `organization:hq`; organization scope): the pool by
  item sku — each item with the variants mapped to it (`variant_id`, `store_id`, the variant's own sku) and its
  level per active warehouse. Filters `sku` (substring), `store_id` (items a variant of that store maps),
  `shared=true` (items mapped by more than one store).
- `PUT /admin/stock-items/{stockItemId}/variants/{variantId}` (`mapVariantToStockItem`, `operations` on
  `organization:hq`; organization scope — the database guard refuses a mapping from any other scope): the variant
  sells from this item's pool from now on. Already mapped → 200, nothing written. Otherwise **409 `conflict`
  `{ stock_item_id, on_hand, open_reservations }` unless the variant's CURRENT item has zero on-hand at every
  warehouse and no open reservation** — quantities are never merged silently; stock is moved first, with
  movements. One audit row (`variant.stock_item_mapped`, before / after) and one `stock_item.mapped` v1 event in
  the same transaction. The item the variant leaves is kept.

## Decisions (ADR-style; the main window moves them to docs/adr)

- **2026-10-12 · The pool (#456, #453).** Levels, reservations and movements are keyed by stock item; the module's
  public shapes for its callers (checkout, orders, returns, shipping) did not change.
- **2026-10-12 · HQ movements are store-less** (manager, D4), addressed variant on the audit row; shipment consume
  and release stay attributed to the store.
- **2026-10-12 · A shipment release after a re-mapping is refused: 409 `conflict`
  `{ variant_id, stock_item_id, current_stock_item_id }`.** The goods belong to the pool row they left; if the
  variant maps another item by then, a reservation of that variant can no longer hold the old item (the rule
  above). It is decided from the order's RESERVATION rows, before the ledger is read: a store no longer sees its
  own movements on an item it stopped mapping (`pool_ledger`), so the ledger alone would answer "nothing to
  release" and the stock would never come back (#459 review). Stock is moved by hand first — the same principle
  as the mapping's own 409.
- **2026-10-12 · One lock routine (`lockStock`), rows created before locks** (#459 review): see Rules.
- **2026-10-12 · Other modules read availability through `availableByVariant`** — the marketing feed items and
  the search records were changed to call it (manager exception; they were reading this module's table).
- **2026-09-08 · Reservations are the placement stock check** (manager, 2.4): the cart's add-time check stays
  advisory (it reads `available`, which already subtracts reservations); the reservation under the row locks is
  what decides.
- **2026-09-08 · Release on cancel is the orders module's job** (through its own `cancelOrder` transition, before
  `order.cancelled`), never window 8's.
- **2026-09-08 · Deterministic lock order** instead of a serialisable retry: simpler, and the concurrency tests
  cover both the deadlock-freedom and the last-unit race. (Order since #456: see Rules.)
- `on_hand` below zero is reserved for `sale` — a backorder that ships owes stock; every other reason is a
  physical count and cannot go negative.

## Tests

- `allocation.test.ts` (pure): the default policy (priority, splits, a shared item across two lines), the
  registry, every validation rule.
- `inventory.test.ts` (seeded throwaway database): moveStock + event + append-only enforcement, greedy allocation
  across the two seeded warehouses, 409 with full rollback and the authorisation voided, backorder going negative,
  8 parallel placements on shared variants, the last-unit race, release on cancel + idempotent release, consume on
  shipment + over-consumption 409, Store availability reflecting reservations, the admin list across stores, the
  HQ movement (store-less, audit row, organization scope only), window 8's per-shipment shapes.
- `shared-pool.test.ts` (seeded throwaway database; the stores' side runs as STORE-SCOPED clients): mapping
  (409 with stock, 409 with an open reservation, organization scope only, idempotent, audit + `stock_item.mapped`,
  one availability afterwards); store A reserves N and store B's availability drops by N; neither store reads the
  other's reservations, movements or events, nor a store-less one; the last unit to exactly one of two stores;
  opposite-order placements from two stores without deadlock; a shipment release against a placement in
  opposite order (gated, deterministic); parallel backorders; a shipment release after a re-mapping → 409 in the
  store's own scope; fail closed (an unmapped item, a store-less movement
  and a movement for another store are refused by the module AND by the database); `stock.moved` v2 for a sale and
  an organization-scope receipt; the seam on the pool; variant creation in store scope.
- HTTP: `test/admin-api.test.ts` (levels, movements, stock items, mapping, permissions),
  `test/auth-live.test.ts` (levels with a real token).
