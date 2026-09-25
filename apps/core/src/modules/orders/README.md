# orders — state machine, edits, Admin/Store order reads (window 1, task 2.3, issue #105)

The order after placement (task 2.2 writes it): lifecycle transitions with one event each, the public functions
windows 7 (payments) and 8 (shipping) call, order edits before fulfilment, the Admin API order routes' services,
the Store API order read (moved here from checkout), and a pure projection that replays an order from its outbox
stream (reused by 2.5 and 2.6).

## Transition table (source of truth: `transitions.ts`; `orders.test.ts` asserts this README shows the same maps)

`status`

| From         | To                        |
| ------------ | ------------------------- |
| `pending`    | `confirmed`, `cancelled`  |
| `confirmed`  | `processing`, `cancelled` |
| `processing` | `completed`, `cancelled`  |
| `completed`  | — (terminal)              |
| `cancelled`  | — (terminal)              |

`payment_status`

| From                 | To                               |
| -------------------- | -------------------------------- |
| `awaiting`           | `authorized`, `failed`           |
| `authorized`         | `captured`, `failed`             |
| `captured`           | `partially_refunded`, `refunded` |
| `partially_refunded` | `refunded`                       |
| `refunded`           | — (terminal)                     |
| `failed`             | `authorized`                     |

`fulfillment_status`

| From                  | To                                 |
| --------------------- | ---------------------------------- |
| `unfulfilled`         | `partially_fulfilled`, `fulfilled` |
| `partially_fulfilled` | `fulfilled`, `partially_returned`  |
| `fulfilled`           | `partially_returned`, `returned`   |
| `partially_returned`  | `returned`                         |
| `returned`            | — (terminal)                       |

Events per legal transition (exactly one outbox row per `transition()` call):

| Change                                                                                   | Event                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `status → confirmed`                                                                     | `order.confirmed`                                                                     |
| `status → cancelled`                                                                     | `order.cancelled` (`legal_entity_id`, `currency`, `totals`, `reason`, `cancelled_at`) |
| `status → completed`                                                                     | `order.completed`                                                                     |
| `status → processing`, any `payment_status` / `fulfillment_status` change, an order edit | `order.updated` with `changed_fields`                                                 |

An illegal move → 409 `conflict` with `details: { field, from, to }`. A `transition()` that names no status field
must carry `changed_fields` (an edit) — otherwise 400. The guard test (`test/guards.test.ts`) fails on any
`UPDATE "order"` outside this module.

## `transition(tx, orderId, change)` — the one mutation path

Locks the row (`FOR UPDATE`), validates every requested field against its table, applies the UPDATE (plus
`cancelled_at` / `cancel_reason` / `completed_at`), writes the one event through `withEvents`, returns the row.
Test seams `hooks.afterUpdate` / `hooks.afterEvents` throw inside the transaction (compensation test: row
unchanged, no event).

## Public functions for windows 7 and 8 (`index.ts`)

Scoped client + ids, never provider objects. Each wrapper is **idempotent on its target state** (a webhook retry
is not a 409) and returns the Admin `Order`.

| Function                                                                                                      | Transition                                                                                               | Caller                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `confirmOrder(client, orderId, actor)`                                                                        | `pending → confirmed`                                                                                    | operator, or window 7 on capture. The checkout does **not** auto-confirm: `pending` is a real state.                   |
| `markPaymentAuthorized / markPaymentCaptured / markPaymentFailed`                                             | `payment_status`                                                                                         | window 7. A failure changes only `payment_status`; cancelling stays an explicit call.                                  |
| `markPaymentPartiallyRefunded / markPaymentRefunded`                                                          | `payment_status`                                                                                         | window 7 (2.5 returns)                                                                                                 |
| `setFulfillmentStatusIn(tx, orderId, status, actor)` / `setFulfillmentStatus({ tx, orderId, status, actor })` | `fulfillment_status` on the caller's transaction, idempotent                                             | window 8 (#191's `setFulfillmentStatus` shape): the status it derives from live shipments; illegal per the table → 409 |
| `markShipmentCreated(client, orderId, actor)`                                                                 | `confirmed → processing`                                                                                 | window 8 (`pending → processing` is illegal: confirm first)                                                            |
| `markShipped(client, orderId, [{ lineItemId, quantity }], actor)`                                             | `order_line_item.fulfilled_quantity` (capped at the line quantity) → `partially_fulfilled` / `fulfilled` | window 8                                                                                                               |
| `markDelivered(client, orderId, actor)`                                                                       | `processing → completed` (409 unless fulfilled)                                                          | window 8                                                                                                               |
| `markReturned(client, orderId, [{ lineItemId, quantity }], actor)`                                            | `returned_quantity` (capped at fulfilled) → `partially_returned` / `returned`                            | task 2.5                                                                                                               |
| `movePaymentStatusIn(tx, orderId, to, actor)` / `mergeOrderMetadataIn(tx, orderId, patch)`                    | a payment_status move / a metadata merge on the caller's transaction                                     | the returns module (refund outcome, exchange link)                                                                     |
| `cancelOrder(client, orderId, { reason, actor })`                                                             | `→ cancelled`                                                                                            | Admin API `cancelOrder`, module callers                                                                                |

`cancelOrder` is allowed only while `fulfillment_status = unfulfilled` (409 otherwise — use a return). Every
**authorised, uncaptured** payment is voided through its `PaymentProvider.void()` (checkout module; `manual` is a
no-op that always succeeds; a `failed` void → 402 `payment_failed`, nothing written) and the `payment` row goes
`cancelled`; a captured payment is window 7's to refund on `order.cancelled`. Reservations are released here
(`releaseForOrder`, inventory module) before the transition — through this module's own cancel, never from
window 8's side. The wrappers' idempotency read happens under the row lock (`FOR UPDATE`) so a concurrent change
cannot turn an intended no-op into a 409 (#174 review).

### Transaction-taking twins (window 8, #191)

Every marker also exists as `…InTx(tx, …)` — `confirmOrderInTx`, `markPaymentAuthorizedInTx`,
`markPaymentCapturedInTx`, `markPaymentFailedInTx`, `markPaymentPartiallyRefundedInTx`, `markPaymentRefundedInTx`,
`markShipmentCreatedInTx`, `markShippedInTx`, `markDeliveredInTx`, `markReturnedInTx`, `cancelOrderInTx`,
`setFulfillmentStatusIn` (also as #191's object shape `setFulfillmentStatus({ tx, orderId, status, actor })`) — with
the same semantics on the caller's transaction and no return value (render the
order yourself if you need it). Use them when your transaction already holds a lock the order row participates in:
window 8's `INSERT INTO shipment` takes `FOR KEY SHARE` on the order (FK), and a marker opening its own
transaction on another connection would deadlock behind it (tested in `orders.test.ts`).

## Order edits before fulfilment (`edits.ts`)

`decreaseLineQuantity(client, orderId, lineItemId, quantity, actor)` and `cancelLine(client, orderId, lineItemId, actor)`
(the last line cannot be cancelled — cancel the order). Allowed while `status ∈ {pending, confirmed}` and
`fulfillment_status = unfulfilled`. Line `tax_minor` / `total_minor` and the order totals are recomputed with the
**same `TaxCalculator`** the cart used (cart module seam — window 7's Stripe Tax included); shipping is unchanged.
Money is untouched: the difference is appended to `order.metadata.edits[]` as
`{ at, line_item_id, sku, from_quantity, to_quantity, delta_minor }` (positive = owed to the customer; window 7
refunds from it), and one `order.updated` carries `changed_fields` (`line_items`, `subtotal_minor`, `tax_minor`,
`total_minor`, `metadata`).

Admin API 0.3.0 has **no order-edit operation**: these are module functions (tested) until the CONTRACT CHANGE for
`PATCH /admin/stores/{storeId}/orders/{orderId}/line-items/{lineItemId}` lands (filed with the 2.3 PR).

## Read models (`read-model.ts`)

- Store API: `renderStoreOrder(tx, id)`, `getStoreOrder(client, id, { customerId?, email? })` (200 or 404 only —
  see the checkout README "Order read access"; the route lives in `src/http/store-routes.ts`),
  `customerIdForSubject`.
- Admin API: `listAdminOrders(client, storeId, { status, payment_status, fulfillment_status, q, placed_from, placed_to, sort, order, page, limit })`
  (`q` = `#display_id` / display id exact, otherwise email substring; `sort` placed_at | display_id | total |
  status per 0.2.0), `getAdminOrder(client, id)` / `renderAdminOrder(tx, id)` (payments, refunds, shipments +
  items, returns + items, `cancel_reason`, metadata). Routes in `src/http/admin-routes.ts` with the spec's
  `x-permission` (`viewer`, `viewer`, `store_admin`) through the real `requirePermission`.

## Projection (`projection.ts`, pure)

`applyOrderEvent(state | null, { topic, payload })` and `projectOrder(events)` fold `order.placed`,
`order.confirmed`, `order.updated`, `order.cancelled`, `order.completed` into
`{ status, payment_status, fulfillment_status, totals, display_id, cancelled_at, completed_at, cancel_reason }`.
The replay test reads the order's outbox rows (ordered by `occurred_at, id`), folds from `null` and compares with
the row — for the happy path and the cancel path. Task 2.5 extends it with `return.*`; task 2.6's whole-lifecycle
suite reuses it as is.

## Decisions (ADR-style; the main window moves them to docs/adr)

- **2026-09-20 · An order edit scales the frozen promotion discount pro rata (#230 PR B).**
  `decreaseLineQuantity` sets the line's discount to `floor(placed_discount × new_quantity / placed_quantity)` —
  the cumulative-floor rule of returns, always from the line AS PLACED (`metadata.discount_base`, written on the
  first edit), so 3 → 2 → 1 gives what 3 → 1 gives and the rounding never drifts. No re-evaluation: the
  customer's deal is frozen even if the promotion has ended. `cancelLine` removes the line with its discount.

- **2026-09-19 · The order carries a MIRROR of a fraud review; held orders cannot be confirmed (#231).**
  `flagOrderForReview(tx, orderId, { reasonCode, provider, actor })` and
  `resolveOrderReview(tx, orderId, { status: 'cleared' | 'confirmed_fraud', resolution, actor })` (+ the
  client-taking `…With` twins) write `order.metadata.fraud = { status, reason_code, provider, flagged_at,
resolved_at?, resolution? }` and emit ONE `order.updated` through `transition()`; both are idempotent on the
  target status, and resolving an order that was never flagged returns null. The payment row stays the source of
  truth (window 7). The reason code travels as `changed_fields` entries (`fraud`, `fraud.reason_code=<code>`,
  `fraud.status=<status>`): `order.updated` v1 has no reason field and a real one waits for the Phase 4 events
  window. `transition()` refuses `→ confirmed` with 409 while the status is `review` or `confirmed_fraud`;
  `cleared` lifts the hold. **The key never crosses the Store API**: order metadata is rendered there since #100,
  so `renderStoreOrder` strips `INTERNAL_ORDER_METADATA_KEYS` (`fraud`); the Admin read keeps it (HTTP leak test).

- **2026-09-19 · Order edits re-price in the mode frozen at placement (#221).** `decreaseLineQuantity` /
  `cancelLine` pass the mode read from the order lines' `metadata.tax` to the TaxCalculator and apply the same
  total rule as the cart (tax on top only for exclusive prices) — a store that flips `prices_include_tax` later
  never re-prices a placed order. Lines placed before #221 have no record and stay exclusive.

- **2026-09-08 · One transition function, table-driven** (manager requirement): no code path updates `"order"`
  status fields except `transition()`; the tables are data, the README is checked against them.
- **2026-09-08 · Wrappers are idempotent on the target state**; `transition()` itself is strict (a self-move is
  illegal because the tables have no self-loops). Windows 7/8 get safe retries without losing the 409 for real
  mistakes.
- **2026-09-08 · No auto-confirm at placement**; `pending` waits for an operator or window 7's capture.
- **2026-09-08 · Edits leave money alone** and record the delta for window 7; no order-edit endpoint until the
  contract has one.
- The Store API order read moved here from checkout; checkout imports `renderStoreOrder` back (a benign module
  cycle: both use each other's functions inside functions only, never at load time).

## Tests

`orders.test.ts` (seeded throwaway database): README ⇄ tables, illegal moves per field → 409 `{ field, from, to }`,
full lifecycle through the wrappers with one event per call and idempotent re-calls, replay of the happy and the
cancel streams, `cancelOrder` (void called once, payment row cancelled, `order.cancelled` payload, 409 after
shipping, fail-closed on a failed void), compensation after update and after event, edits (totals, delta,
`order.updated`, 409 after fulfilment, last line), admin list/detail/filters/sort/pagination + RLS. HTTP:
`test/admin-api.test.ts` (list/get/cancel spec-validated, permissions), `test/auth-live.test.ts` (one order route
with a real token through OpenFGA), `test/store-api.test.ts` (order read).
