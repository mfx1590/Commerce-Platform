# inventory — levels per warehouse, movements, reservations (window 1, task 2.4, issue #106)

Stock of a variant in a warehouse (`inventory_level`, migration 0007: `available` is GENERATED `on_hand − reserved`),
the append-only ledger (`stock_movement`; 0009 revokes UPDATE/DELETE from the app role) and reservations held by
unshipped orders. Warehouses are organization-level and shared by stores; every level row carries the variant's
`store_id`, so RLS keeps store A's rows invisible to store B even inside the same warehouse.

## Rules

- **`on_hand` changes only through `moveStock()`**: the level row is locked (`FOR UPDATE`, created at zero when
  missing), `on_hand += delta`, one `stock_movement` row appended, one `stock.moved` v1 emitted (`stock_movement_id`,
  `variant_id`, `sku`, `warehouse_id`, `delta`, `reason`, `reference_type/id`, `on_hand_after`, `reserved_after`),
  all in the caller's transaction. `on_hand` may go negative only through `sale` (a backorder being shipped);
  any other reason that would cross zero → 409 `conflict`. A guard test fails on `UPDATE inventory_level` or
  `INSERT INTO stock_movement` outside this module.
- **A reservation is not a movement.** Reserving raises `reserved`; `on_hand` and the ledger are untouched, no event.
- **Placement lock order is deterministic**: variant id, then warehouse priority, then warehouse code — one
  `SELECT … FOR UPDATE` per placement in that order, so two placements for overlapping variants queue behind
  each other instead of deadlocking (tested with 8 parallel placements on shared variants in shuffled line order).

## Public API (`index.ts`)

| Function                                                                                                                           | Who calls it                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserveForOrder(tx, { organizationId, storeId, orderId, lines })`                                                                 | checkout, inside the placement transaction after the order lines exist           | the stock check at placement: greedy allocation across active warehouses in priority order, one `reservation` row per (variant, warehouse), `reserved += q`. Non-backorderable shortfall → 409 `out_of_stock` `{ variant_id, available }` and the whole placement rolls back (the checkout voids the payment authorisation on that path). Backorderable → reserves anyway, the rest on the priority warehouse, `available` goes negative (`backorderQuantity` in the result). `manage_inventory = false` → no reservation. |
| `releaseForOrder(tx, orderId)`                                                                                                     | the orders module's `cancelOrder` (its own transition — never window 8)          | releases every open reservation of the order (`reserved −= q`, `released_at`), idempotent                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `consumeForShipment(tx, { organizationId, storeId, orderId, shipmentId?, lines: [{ variantId, quantity, warehouseId? }], actor })` | window 8 at ship time                                                            | shrinks/closes the order's reservations (preferred warehouse first, then priority) and `moveStock(reason 'sale', reference shipment                                                                                                                                                                                                                                                                                                                                                                                        | order)`per (variant, warehouse); more than reserved → 409`conflict` |
| `moveStock(tx, { organizationId, storeId, variantId, warehouseId, delta, reason, referenceType?, referenceId?, note?, actor })`    | Admin `createStockMovement`, `consumeForShipment`, task 2.5's restock (`return`) | the only writer of `on_hand`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `listInventoryLevels(client, query)` / `createStockMovement(client, input)`                                                        | Admin API routes                                                                 | see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ensureLevel(tx, { … }, lock)`                                                                                                     | this module, task 2.5                                                            | the level row for (variant, warehouse), created at zero                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Allocation policy is "priority order, greedy" for Phase 2; window 11 (warehouse/WMS) owns a smarter policy later
and plugs it in behind `reserveForOrder` — callers never see warehouses.

## Store availability

The catalog read model already computes `in_stock` / `available_quantity` from `available` summed over active
warehouses, so a reservation lowers the Store API's `available_quantity` immediately and `in_stock` flips at 0
(a backorderable variant stays `in_stock` with `available_quantity: 0`). The Store contract 0.3.0 has no quantity
buckets; nothing to add.

## Admin API

- `GET /admin/inventory/levels` (`listInventoryLevels`, x-permission `viewer` on `store:{store_id}` where
  `store_id` is an optional query): **with `store_id`** the permission object is that store and the client is
  store-scoped; **without it** the check runs against `store:*` (any visible store: ListObjects for real tokens,
  any-relation for the dev stub) and the list is limited to the principal's visible stores by RLS. Filters
  `store_id`, `warehouse_id`, `variant_id`, `sku` (substring), `below_available` (available < n); `sort`
  sku | available | on_hand + `order` (0.2.0); `Page<InventoryLevel>`.
- `POST /admin/inventory/movements` (`createStockMovement`, `operations` on `organization:hq`): body
  `variant_id`, `warehouse_id`, `delta`, `reason` ∈ receipt | adjustment | transfer_in | transfer_out | cycle_count
  (`sale` / `return` are system reasons), `note` → `moveStock` → 201 `InventoryLevel`.

## Decisions (ADR-style; the main window moves them to docs/adr)

- **2026-09-08 · Reservations are the placement stock check** (manager, 2.4): the cart's add-time check stays
  advisory (it reads `available`, which already subtracts reservations); the reservation under the row locks is
  what decides. The checkout's earlier re-check (`assertLinesInStock`) is gone from placement.
- **2026-09-08 · Release on cancel is the orders module's job** (through its own `cancelOrder` transition, before
  `order.cancelled`), never window 8's.
- **2026-09-08 · Deterministic lock order** (variant id → warehouse priority → warehouse code) instead of a
  serialisable retry: simpler, and the concurrency tests cover both the deadlock-freedom and the last-unit race.
- `on_hand` below zero is reserved for `sale` — a backorder that ships owes stock; every other reason is a
  physical count and cannot go negative.

## Tests

`inventory.test.ts` (seeded throwaway database): moveStock + event + append-only enforcement, greedy allocation
across the two seeded warehouses, 409 with full rollback and the authorisation voided (provider call log),
backorder going negative, 8 parallel placements on shared variants, the last-unit race (one 201, one 409), release
on cancel + idempotent release, consume on shipment with `sale` movements + over-consumption 409, Store availability
reflecting reservations, admin list filters/sort/RLS across the shared warehouse, movement adjust. HTTP:
`test/admin-api.test.ts` (levels + movements, permissions), `test/auth-live.test.ts` (levels with a real token).
