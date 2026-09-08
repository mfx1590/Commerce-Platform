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
   quotable → 400. Stock re-checked per line → 409 `out_of_stock` (reservations arrive with task 2.4).
5. `PaymentProvider.authorize()` for the session's provider; `failed` → 402 `payment_failed`, **nothing written**.
6. `"order"` inserted with snapshots (addresses, `shipping_method {code,name,carrier,price_minor}`, totals frozen,
   `payment_status = 'authorized'`, `metadata = orderMetadataFromCart(cart.metadata)`), then `order_line_item`
   rows (`tax_minor` exact from the persisted `tax_rate_bp`, `total_minor = qty×unit − discount + tax`), then the
   `payment` row (provider, provider payment id, amount, `authorized`, the idempotency key).
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

- **2026-09-08 · Idempotency lives on `payment.idempotency_key`** (manager decision at the start of 2.2): placement
  creates exactly one payment row, the column is already UNIQUE, and the replay reads the order through it. No
  idempotency table, no key on the order row, no metadata pollution.
- **2026-09-08 · A payment session is required to complete** — `manual` is never assumed. A cart without a
  session is a 400, so a storefront that forgets the step cannot place unpaid orders by accident.
- **2026-09-08 · Display id via the existing store-row trigger** (see above); per-store serialisation accepted
  for Phase 2.
- The order read model lives here until task 2.3 creates `src/modules/orders`, which takes `renderOrder`,
  `getStoreOrder` and the state machine.

## Tests

`checkout.test.ts` (10, seeded throwaway database): shipping options per destination + RLS, manual session
stored on the cart + unknown provider, full placement (order/lines/payment/attribution/`order.placed` payload
incl. `email_hash` and no PII, cart completed, metadata copied), idempotency replay with the provider invoked
once + 409 on a second key + cross-cart key conflict, 402 with nothing written, rollback after the outbox insert,
400 not-ready + 409 out_of_stock at placement, 8 concurrent placements → consecutive display ids matching
`store.next_order_number`, RLS on complete/read, the order access rule (guest trim/case, customer by id or email).
HTTP replay of every route: `test/store-api.test.ts` "checkout routes".
