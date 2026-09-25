# checkout — shipping options, payment session, placement, order read (window 1, task 2.2, issue #104)

The checkout half of the Store API (`store-api.yaml` 0.3.0, tags `checkout` and `orders`) on top of the cart
module: `GET /store/carts/{cartId}/shipping-options`, `POST …/payment-session`, `POST …/complete` and
`GET /store/orders/{orderId}`. Routes live in `src/http/store-routes.ts`; this module never sees Express.

## Public API (`index.ts`)

| Function                                                  | Contract operation                           | Notes                                                                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listShippingOptions(client, cartId)`                     | `GET /store/carts/{cartId}/shipping-options` | the cart module's `ShippingRateProvider.list()` for the cart's destination, currency and channel; 404 for an invisible cart                                      |
| `createPaymentSession(client, cartId, { provider })`      | `POST /store/carts/{cartId}/payment-session` | provider must be registered (400 otherwise); the session is stored on `cart.payment_session` as the contract `PaymentSession` (ids and amounts, never card data) |
| `completeCart(client, { cartId, idempotencyKey, actor })` | `POST /store/carts/{cartId}/complete` → 201  | placement, see below; returns `{ order, replayed }`                                                                                                              |
| `getStoreOrder(client, orderId, { customerId?, email? })` | `GET /store/orders/{orderId}`                | access rule below; 200 or 404, nothing else                                                                                                                      |
| `customerIdForSubject(client, storeId, subject)`          | —                                            | `customer.id` for a verified customers-realm `sub` (the route calls it after `verifyCustomerToken`)                                                              |
| `setPaymentProvider(provider)` / `paymentProvider(name)`  | —                                            | provider registry, see below                                                                                                                                     |
| `renderOrder(tx, orderId)`                                | —                                            | contract `Order` for an id (moves to the orders module in 2.3)                                                                                                   |
| `emailHash(email)`                                        | —                                            | sha256 hex of the trimmed, lowercased email — the events' `email_hash`                                                                                           |

## Placement — one transaction on the locked cart

`completeCart` runs entirely inside one transaction of the store-scoped client:

1. **Replay**: a `payment` row with this `Idempotency-Key` (`payment.idempotency_key`, UNIQUE in migration 0006 —
   placement creates the one money movement, so that column is the idempotency record; no extra table) → the
   stored order is returned, the provider is **not** called again. The same key on a different cart → 409
   `conflict`.
2. `cart` locked `FOR UPDATE`; a non-active cart → 409 `cart_completed` `{ order_id }`.
3. Preconditions → 400 `validation_error` listing what is missing: items, `email`, `shipping_address`,
   `billing_address`, `shipping_option_id`, `payment_session`.
4. Totals refreshed through the cart module (`recalculate`, providers included); a shipping option no longer
   quotable → 400. (The stock check is the reservation in step 6b since task 2.4.)
5. `PaymentProvider.authorize()` for the session's provider; `failed` → 402 `payment_failed`, **nothing written**.
6. `"order"` inserted with snapshots (addresses, `shipping_method {code,name,carrier,price_minor}`, totals frozen,
   `payment_status = 'authorized'`, `metadata = orderMetadataFromCart(cart.metadata)`), then `order_line_item`
   rows (`tax_minor` exact from the persisted `tax_rate_bp`, `total_minor = qty×unit − discount + tax`), then the
   `payment` row (provider, provider payment id, amount, `authorized`, the idempotency key).
   6b. **Reservations** (`reserveForOrder`, inventory module): the stock check at placement under the level rows'
   locks — greedy allocation across warehouses by priority; a non-backorderable shortfall → 409 `out_of_stock`
   and the whole placement rolls back.
   6c. **Void on failure**: every step after a successful `authorize` runs under a guard — any throw (out_of_stock,
   a shipping-option race, a database error) rolls back AND calls `PaymentProvider.void` for the authorisation
   before rethrowing, so no dangling hold survives (#174 review; tested on the manual provider's call log).
7. `recordAttribution()` from `src/lib/attribution.ts` (Integration 1): one `attribution` row + one
   `attribution.recorded` per touch in `cart.metadata.attribution` — called, not reimplemented.
8. `order.placed` v1 through `withEvents` (validated against `packages/events/schemas/order.placed/v1.json`;
   `email_hash` only, no address, no raw email).
9. `cart` → `status = 'completed'`, `order_id`, `completed_at`, payment session marked `authorized`.

Any throw at any step rolls the whole thing back (tests: provider refusal, and an injected failure after the
outbox insert — no order, no payment, no attribution rows, no event, cart still active).

**Display id.** `display_id` comes from migration 0006's trigger `app.assign_order_display_id()`, which does
`UPDATE store SET next_order_number = … RETURNING` inside the insert. That is a row lock on the **store** row:
concurrent placements on one store serialise there and can never collide (tested with 8 parallel placements →
8 distinct consecutive numbers). It also means placements of one store are serialised for the duration of the
transaction — fine for Phase 2, a Phase 3 scaling concern to revisit (per-store sequences), not now.

## PaymentProvider (public API; window 7 implements `stripe` against it, #127)

Since task 2.5 the seam itself (types, the process-wide registry, the `manual` provider) lives in
`src/lib/payment-seam.ts` so the orders and returns modules can use the registry without importing the checkout
module (no checkout ↔ orders cycle; a guard test enforces it). This module re-exports everything unchanged:
keep importing `setPaymentProvider` / `PaymentProvider` from `../checkout`.

```ts
import { setPaymentProvider, type PaymentProvider } from '../checkout'; // from another module: '../modules/checkout'
setPaymentProvider(stripeProvider); // at boot; returns the previous provider under that name
```

- `createSession({ tx, cart }) → { sessionId, clientSecret, status }` on `POST …/payment-session`; `cart` is
  `{ cartId, organizationId, storeId, currency, amountMinor, email }` — ids and money, never card data (hosted
  fields, ADR 0004). The storefront renders hosted fields with `client_secret`.
- `authorize({ tx, cart, session, idempotencyKey }) → { status: 'authorized' | 'failed', providerPaymentId, failureReason? }`
  inside the placement transaction; `failed` aborts the placement with 402. Must be idempotent on
  `idempotencyKey` (the replay path never reaches it, but a provider may be retried after a crash).
- `void({ tx, organizationId, storeId, cartId?, providerPaymentId, idempotencyKey, reason }) → { status: 'voided' | 'failed' }`
  — carries the **store** (per-store PSP credentials are resolved from it) because on the placement failure path
  the transaction is being rolled back and may already be aborted: a provider must never run queries on `tx`
  there (2.6, window 7's gap). `refund` carries `organizationId` / `storeId` for the same reason: called by the
  orders module when an order with an **authorised, uncaptured** payment is cancelled (`cancelOrder`, 2.3); a
  `failed` void aborts the cancellation with 402. `manual` is a no-op that always succeeds (nothing was ever
  captured); Stripe cancels the PaymentIntent.
- `refund({ tx, providerPaymentId, amountMinor, currency, idempotencyKey, reason })` for task 2.5's returns.
- `manual` (`manualPaymentProvider`): authorises everything at once, `client_secret: null`, ids `man_…` /
  `manpay_…`. It is the default registration and what the storefront uses in Phase 2 until Stripe lands.

`POST …/payment-session` can be called again (the storefront does, right before completing): the new session
replaces the old one and carries the current total. The session stored on the cart is the contract shape, so
`GET /store/carts/{id}` returns it unchanged.

## Order read access (`GET /store/orders/{orderId}`)

The contract allows only 200 or 404, so an order id can never be confirmed by probing:

- `Authorization: Bearer <customers-realm token>` → `verifyCustomerToken(header, store.code)` (auth-sdk) →
  `customer` by `(store_id, keycloak_subject)` → the order is visible when `order.customer_id` is that customer
  **or** the order's email equals the customer's (case-insensitive). An invalid token is treated like no token.
- Guest: `?email=` (validated as an email → 400 otherwise) compared to the checkout email **trimmed and
  case-insensitively**.
- Neither, a mismatch, or another store's order → 404 `not_found`.
- Nothing in this path logs the email or the query string (tested: the console output of an order lookup
  contains neither).

`order.customer_id` at placement is `cart.customer_id` (set by window 13's customer flows); guest carts place
guest orders. The storefront's client never sends the customer token to cart paths.

## Decisions (ADR-style; the main window moves them to docs/adr)

- **2026-09-20 · Promotions at placement: re-evaluated under the lock, counted before authorisation, frozen on the
  order (#230 PR B).** `completeCart` re-runs `recalculate` with the placement clock; a discount — or a
  free-shipping grant — that is no longer what the customer saw follows the price rule: rollback, re-quote in a
  transaction of its own, 409 `price_changed` whose `details` carry `discount_minor` / `shipping_minor`
  `{ previous, current }` (when they moved) and `total_minor` next to `items`. Then, still before `authorize`,
  `DiscountEvaluator.recordUse` counts ONE use per applied promotion inside the placement transaction: a race
  lost on the last use is window 9's 409 `conflict`, nothing was authorised so nothing is voided, and any later
  failure (a decline, out of stock) rolls the use back — a failed placement never burns one. The order freezes
  the line and order discounts, `promotion_codes` = the APPLIED codes only (a conditional code that sat on the
  cart is not the order's), and `metadata.promotions = [{ promotion_id, code, discount_minor }]` — what
  per-customer limits count later. `order.placed` carries the same codes and amounts.
- **2026-09-20 · The storefront cannot pre-write the core's order metadata.** Order metadata starts as the cart's
  (storefront-owned) metadata; the keys the core writes itself — `fraud`, `promotions` — are dropped from that
  copy at placement. Without this a storefront could hold its own order in a fake review or spoof applied
  promotions.
- **2026-09-20 · A fraud block is recorded AFTER the rollback, through an opt-in hook (#241, window 7).**
  `placeOrder` signals a block out of the transaction (the `PriceChangedSignal` pattern); `completeCart`'s catch
  calls `FraudCheck.recordBlocked(facts + decision)` — never the transaction handle — once the placement's
  connection is released, best effort (a throw is swallowed), then answers the unchanged plain 402. The hook fires
  only for a check that sets `recordsBlockedAfterRollback`: window 7's check still queues and flushes its blocks by
  itself (the approved interim), so calling it unconditionally would record every block twice. The day their
  check opts in and stops its own flush, nothing changes here.

- **2026-09-19 · Fraud is evaluated before authorization, through a seam (#231, window 7).** `setFraudCheck()`
  (types and registry in `src/lib/fraud-seam.ts`, re-exported here) — `completeCart` calls the registered check
  inside the placement transaction, after the cart is re-priced and BEFORE `PaymentProvider.authorize`, with facts
  and codes only (`emailHash`, the two countries, amount, provider + session id — never the email or an address).
  **`block`** answers 402 `payment_failed` with the generic message and `details.provider` — byte-identical to a
  decline (tested against a real decline): a distinct answer would tell a probing fraudster which attempt tripped a
  rule. Nothing is written and nothing was authorised, so there is nothing to void. **`review`** places the order:
  the payment row is inserted with `metadata.fraud` (the source of truth, window 7's aggregate) and the orders
  module writes the mirror (`flagOrderForReview`). **A check that throws is a `review`**
  (`reason_code: provider_unavailable`): an outage never blocks a customer and never passes silently. No check
  registered = every placement allowed, as before.

- **2026-09-19 · Placement never charges a price the customer did not see: 409 `price_changed` (#179 part 3,
  CONTRACT CHANGE #228).** Under the cart lock `completeCart` re-resolves every line at one clock (`at`); any
  difference rolls the placement back (nothing placed, nothing authorized), the cart is re-priced in a transaction
  of its own so the storefront reads the new prices, and the answer is 409 with
  `details: { currency, items: [{ line_item_id, variant_id, previous_unit_price_minor, unit_price_minor | null }] }`
  (`null` = no longer sellable: the storefront removes the line). The same Idempotency-Key may be retried — no
  order exists for it; the payment session is created again for the new total. The code comes from
  `@platform/contracts` (`ERROR_CODES`, contracts-v0.4.3 / Store API 0.3.1).

- **2026-09-19 · Placement freezes the calculator's per-line tax (#221).** `completeCart` reloads the lines
  after its `recalculate` and writes `lineTaxOf(line)` into `order_line_item.tax_minor` / `total_minor` (and the
  record into the order line's metadata) instead of recomputing from the rate; with
  `prices_include_tax` the order and line totals carry no tax on top. `order.placed` carries the same numbers:
  Σ `line_items[].tax_minor` + shipping tax = `totals.tax_minor`.

- **2026-09-08 · Idempotency lives on `payment.idempotency_key`** (manager decision at the start of 2.2): placement
  creates exactly one payment row, the column is already UNIQUE, and the replay reads the order through it. No
  idempotency table, no key on the order row, no metadata pollution.
- **2026-09-08 · Idempotency keys are per store.** `payment.idempotency_key` is UNIQUE table-wide (migration 0006)
  while RLS hides other stores' rows from the replay lookup — so the stored value is `<store_id>:<Idempotency-Key>`.
  The same key sent to two stores places two orders, never collides on the constraint and never returns another
  store's order (tested; the per-store test caught the unique-violation 500 before the fix). Keys are generated per
  storefront, so this is the intended scope; window 7 reads the composite when it needs the raw key (split on the
  first `:`).
- **2026-09-08 · A payment session is required to complete** — `manual` is never assumed. A cart without a
  session is a 400, so a storefront that forgets the step cannot place unpaid orders by accident.
- **2026-09-08 · Display id via the existing store-row trigger** (see above); per-store serialisation accepted
  for Phase 2.
- The order read model (`renderStoreOrder`, `getStoreOrder`, `customerIdForSubject`) moved to
  `src/modules/orders` in task 2.3; the access rule above is implemented there. `GET /store/orders/{orderId}`
  also answers 404 for a malformed id or email (never a 400 that would confirm the id exists).

## Tests

`checkout.test.ts` (10, seeded throwaway database): shipping options per destination + RLS, manual session
stored on the cart + unknown provider, full placement (order/lines/payment/attribution/`order.placed` payload
incl. `email_hash` and no PII, cart completed, metadata copied), idempotency replay with the provider invoked
once + 409 on a second key + cross-cart key conflict, 402 with nothing written, rollback after the outbox insert,
400 not-ready + 409 out_of_stock at placement, 8 concurrent placements → consecutive display ids matching
`store.next_order_number`, RLS on complete/read, the order access rule (guest trim/case, customer by id or email).
HTTP replay of every route: `test/store-api.test.ts` "checkout routes".
