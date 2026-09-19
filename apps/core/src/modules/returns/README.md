# returns — returns and exchanges (window 1, task 2.5, issue #107)

`"return"` + `return_item` (migration 0006) after shipment: a customer sends goods back, the warehouse receives
them, the order's returned quantities move, resellable goods go back on the shelf, and the refund is handed to the
payments side through a seam. Both tables are window 1's (docs/domain.md); the `refund` table and the
`refund.issued` / `refund.failed` events are **window 7's** and are never written here.

## Lifecycle (`RETURN_TRANSITIONS`, `transitionReturn` is the one status mutation)

| From        | To                                 |
| ----------- | ---------------------------------- |
| `requested` | `approved`, `received`, `rejected` |
| `approved`  | `received`, `rejected`             |
| `received`  | `refunded`                         |
| `refunded`  | — (terminal)                       |
| `rejected`  | — (terminal)                       |

Receiving is reachable straight from `requested` (receiving implies approval). `approved` / `rejected` are module
functions for window 16's support flows (`approveReturn`, `rejectReturn`); the contract has no route and no event
for them. Events: `return.requested` (on request), `return.received` (on receipt) — exactly one each, in the same
transaction as the rows.

## Public API (`index.ts`)

| Function                                                                                                        | Contract operation                                                                                                                                       | Notes                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestReturn(client, orderId, { items: [{ order_line_item_id, quantity }], reason?, actor })`                 | `POST /admin/stores/{storeId}/orders/{orderId}/returns` (`support`) → 201 `Return`                                                                       | unshipped order → 409; per line `quantity ≤ fulfilled − returned − open requested/approved` → 409 `{ order_line_item_id, requested, returnable }` otherwise; unknown line → 404 |
| `receiveReturn(client, returnId, { warehouseId, items: [{ order_line_item_id, quantity, condition }], actor })` | `POST /admin/stores/{storeId}/returns/{returnId}/receive` (`operations` on HQ; the store in the path must be the return's, 404 otherwise) → 200 `Return` | see "Receiving"                                                                                                                                                                 |
| `approveReturn` / `rejectReturn`                                                                                | —                                                                                                                                                        | support flows                                                                                                                                                                   |
| `markReturnRefunded(client, returnId, refundId, actor)`                                                         | —                                                                                                                                                        | window 7: a `pending` refund settled (webhook)                                                                                                                                  |
| `linkExchange(client, returnId, newOrderId)`                                                                    | —                                                                                                                                                        | exchange = this return + a linked new order                                                                                                                                     |
| `getReturn` / `renderReturn`, `projectReturn` / `applyReturnEvent`, `refundAmountFor`                           | —                                                                                                                                                        | read model, pure projection, the amount rule                                                                                                                                    |
| `setRefundRequester` / `manualRefundRequester` / `refundKeyFor`                                                 | —                                                                                                                                                        | the refund seam                                                                                                                                                                 |

## Receiving — one transaction

1. Received quantities ≤ requested (409 otherwise); items' `condition` set; requested items not received are
   dropped from the return.
2. `return` → `received` (`received_at`, `warehouse_id`).
3. Orders module `markReturnedIn` on the same transaction: `order_line_item.returned_quantity` (capped at the
   fulfilled quantity) and `fulfillment_status` partially_returned | returned — one `order.updated`.
4. Inventory module `moveStock(reason 'return', reference return)` for every **resellable** item into
   `warehouse_id` — one `stock.moved` each, append-only ledger; damaged goods are not restocked.
5. `return.received` (`items[{ order_line_item_id, quantity, condition }]`, `warehouse_id`, `received_at`).
6. The refund through the seam (below); on `succeeded` → `refunded` and the order's `payment_status`
   partially_refunded | refunded against the captured amount.

Any throw rolls all of it back (tested with a failure injected after the outbox insert).

## Refund seam (`RefundRequester`; window 7 registers its requester at boot)

`request({ tx, organizationId, storeId, orderId, returnId, paymentId, provider, providerPaymentId, amountMinor, currency, reason: 'return', idempotencyKey, actor })`
→ `{ status: 'succeeded' | 'failed' | 'pending', refundId, failureReason? }`.

- **Default `manualRefundRequester`**: calls the checkout's `PaymentProvider.refund` for the captured payment's
  provider and returns `refundId: null` — it writes no `refund` row and emits no `refund.*` event (window 7's).
  Window 7's requester writes its row + events and returns the id, which the return stores in `refund_id`.
- **Idempotent per return**: `idempotencyKey = return:<return_id>`, and the outcome is recorded on the return
  (`metadata.refund = { status, amount_minor, currency, payment_id, refund_id, failure_reason, at }`) in the same
  transaction — a retry finds a `succeeded` / `pending` outcome and never asks twice (tested with a counting
  requester); a `failed` outcome is retried through `requestRefundFor` under the same key. Requesters honour the
  key on their side too. **A requester that throws** (provider timeout, SDK crash) is a `failed` outcome, not a lost
  receipt: the call runs under a savepoint, whatever it wrote is rolled back to it, the receipt + restock + event
  stay committed and `failure_reason` records `requester threw: <name>: <message>` (tested with a literal
  throwing requester that first writes its refund row — the row is gone, the retry succeeds).
- **Amount** = Σ over received items of the item's share of its line total by cumulative floor —
  `floor(total × (returned_before + qty) / quantity) − floor(total × returned_before / quantity)` — so separate
  partial returns of one line add up to the line total exactly (100 over 3 units → 33, 33, 34; the remainder lands
  on the last unit returned, never on the merchant). Shipping is not refunded. Goodwill refunds are window 7's `createRefund`.
- Requires a **captured** payment (`payment.status = 'captured'`): an order that is only authorised cannot be
  refunded → 409 with a clear message; window 7's capture (`markPaymentCaptured`) comes first.
- `failed` → the return stays `received` with the failure recorded; `pending` → stays `received` until window 7
  calls `markReturnRefunded`.

## Exchange

`linkExchange(client, returnId, newOrderId)`: `return.metadata.exchange = { order_id }` and
`order.metadata.exchange_for = { return_id, order_id }` on the new order. No money coupling in Phase 2 (the return
refunds, the new order charges). Module function only — the contract has no exchange operation; a CONTRACT CHANGE
follows if window 16 wants an endpoint.

## Projection (`projectReturn`, pure)

Folds `return.requested` → `return.received` → `refund.issued` (window 7's event, matched on `return_id`) into
`{ status, warehouse_id, refund_id, items }`. `approved` / `rejected` have no event and are not replayable
(documented). The order side replays through the orders module's projection (`order.updated` carries the
fulfillment change). Task 2.6's whole-lifecycle suite chains both.

## Decisions (ADR-style; the main window moves them to docs/adr)

- **2026-09-08 · The refund is a seam, not a write** (manager, 2.5): the returns module never touches window 7's
  table or events; the manual default only calls the provider. Per-return idempotency lives on the return row.
- **2026-09-08 · Received quantities cap at requested; unreceived items are dropped** — a return records what came
  back, the customer keeps the rest.
- **2026-09-08 · Shipping is not refunded; damaged goods are not restocked.**
- The returns module calls the orders and inventory modules on the caller's transaction (`markReturnedIn`,
  `movePaymentStatusIn`, `moveStock`) — no nested transactions, no second connection while the order row is locked.

## Tests

`returns.test.ts` (seeded throwaway database): request within / over shipped quantities (409), unfulfilled order
(409), receive → `returned_quantity` + `fulfillment_status`, resellable restock through the inventory API
(`return` movement + `stock.moved`), damaged → no restock, refund seam called once with the computed amount and
never twice on a retry, `refunded` + `payment_status`, failed / pending paths + `markReturnRefunded`, no captured
payment → 409, every transition one event in the same transaction (rollback after `return.received`), replay of
both projections, RLS (store B → 404), exchange link. HTTP: `test/admin-api.test.ts` (createReturn / receiveReturn,
permissions, spec-validated), `test/auth-live.test.ts` (createReturn with a real token).
