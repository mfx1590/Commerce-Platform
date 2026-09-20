# Changelog — @platform/core

## Unreleased — Phase 2 (window 1, contracts-v0.3)

### 2026-09-20 · promotions at placement, order freeze, pro-rata edits; fraud block hook (#230 PR B, #241)

- **Placement re-evaluates promotions under the cart lock** at its own clock. A changed discount or a lost/gained
  free-shipping grant → 409 `price_changed` (`details.discount_minor` / `shipping_minor` `{ previous, current }`,
  `total_minor`), the cart re-quoted, nothing placed; the retry places what the customer now sees.
- **Uses counted inside the placement transaction, before `authorize`** (`DiscountEvaluator.recordUse` →
  window 9's `recordPromotionUse`): a lost race on the last use = 409 `conflict` with nothing authorised; a
  decline or any later failure rolls the use back.
- **Order freeze**: line + order discounts, `promotion_codes` = applied codes only,
  `metadata.promotions = [{ promotion_id, code, discount_minor }]`; `order.placed` agrees. **Reserved keys**:
  `fraud` and `promotions` are dropped from the cart metadata copied onto the order.
- **Order edits** scale the frozen line discount pro rata from the line as placed (cumulative floor).
- **Adapter rulings**: "orders that count" (not cancelled, payment at least authorised, not fraud-held) for
  first-order state and per-customer uses; stacking = each promotion gets the headroom left on a line;
  `mulDivRound` (BigInt) for the blended conversion; no carrier quote for a free-shipping cart unless the request
  picks the option.
- **#241**: `FraudCheck.recordBlocked` is called by `completeCart` after the rollback (facts + decision, never
  the transaction), best effort, for a check that opts in with `recordsBlockedAfterRollback`; the 402 is
  unchanged. The redundant fraud bridge line in `src/wiring.ts` is gone.
- Tests: `test/placement-promotions.test.ts` (8), checkout +2 (#241), cart-discounts +2 (free-shipping skip,
  stacking in both tax modes).

### 2026-09-19 · promotions quote: discounts, free shipping, code rejection (#230 PR A); pick/pack routes mounted

- **`DiscountEvaluator` seam** in the cart (`setDiscountEvaluator`, default `noDiscounts`); `recalculate` now runs
  discounts → shipping → tax on the discounted base → totals and returns the quote. `src/wiring.ts` registers
  `promotionsDiscountEvaluator` over window 9's `loadCandidatePromotions` + `evaluatePromotions` (groups,
  first order, prior uses; one clock per mutation).
- **Code rule**: a code that can never apply to the cart → 400 with the reason per code, the PATCH rolls back;
  a conditional rejection keeps the code stored.
- **Tax-inclusive stores**: the adapter converts to tax-exclusive money for the engine and back to the cart's
  gross base (same `taxOn` rounding); window 9's engine is unchanged. Fixed amounts and `min_subtotal`
  thresholds are GROSS figures: "5.00 off" is exactly 5.00 off the displayed total, "spend 100" compares the
  displayed subtotal (#243 ruling). `not_started` is a conditional rejection: a launch code stays stored. The
  fixed-amount conversion clamps every share to its line's displayed subtotal and spreads the rounding drift only
  over eligible lines with headroom, so the discount is exactly `min(configured, eligible displayed subtotal)`
  even on tiny lines (#243 re-review).
- **`fulfillmentAdminRouter()` mounted** (window 8, #133: pick, pack, pick lists) — those routes were dead on the
  running server; the "pending on #235" notes are gone, router count 8.
- **#236 review nits**: an unattributable fraud outage is booked on `rules` (inside the provider-name set) and a
  review without a code on `provider_unavailable` (inside the closed code set); no redundant `trim()` before
  `emailHash`.
- Tests: `test/cart-discounts.test.ts` (6, with the server's evaluator), store-api +1 (the 400 over HTTP),
  admin-api (fulfillment acceptance, 8 routers), wiring (the evaluator is registered). Not yet: placement
  re-evaluation, use counting and order freezing — PR B.

### 2026-09-19 · fraud seam before authorization, order review mirror, confirm hold (#231, window 7's REQUEST)

- **`setFraudCheck()`** (`src/lib/fraud-seam.ts`, re-exported by the checkout): `completeCart` evaluates the
  registered check inside the placement transaction before `authorize`, with facts and codes only. `block` → 402
  `payment_failed`, byte-identical to a provider decline, nothing written, nothing to void. `review` → the order is
  placed, the payment row carries `metadata.fraud` (source of truth) and the order gets the mirror. A check that
  throws → `review` with `provider_unavailable`. No check registered → unchanged behaviour.
- **Orders**: `flagOrderForReview` / `resolveOrderReview` (+ `…With` twins), idempotent on the target status, one
  `order.updated` each with `fraud`, `fraud.reason_code=<code>`, `fraud.status=<status>` in `changed_fields`;
  `transition()` refuses `→ confirmed` (409) while the review is open or confirmed as fraud.
- **Boot**: `registerModuleSeams()` calls window 7's `registerFraudCheck()` and hands the registered check to the
  checkout's seam (their registration still targets the module's stand-in registry). `module-routers.ts` names
  window 8's `fulfillmentAdminRouter()` as pending (PR #235).
- **Store API**: `order.metadata.fraud` never leaves — `renderStoreOrder` strips internal metadata keys; the Admin
  read keeps it. Tests: checkout +3 (block vs a real decline, review end to end, outage), store-api +1 (HTTP leak
  test + the plain 402), guards +1 (checkout and orders never import the fraud module).

### 2026-09-19 · cleanup: tax boot line, refunds router, guard + wiring tests (#127, #126 on main)

- **`price_changed` comes from the contract** (contracts-v0.4.3, #228 landed): the local `CoreErrorCode` union in
  `src/lib/errors.ts` is deleted; `AppError` is typed on `ErrorCode` again.
- **Store order read vs contracts-v0.4.3**: window 8's `picking` / `packed` shipment statuses pass straight through
  the read model; a Store API test inserts both and validates the response against `Order`.
- **`paymentsAdminRouter()` mounted** (window 7, #176 part 4): `POST /admin/stores/{storeId}/orders/{orderId}/refunds`
  answers on the running server (support → 404 on an unknown order, 400 without `Idempotency-Key`, store staff →
  403). `module-routers.ts` header rewritten: nothing is pending, boot registrations live in `src/wiring.ts`.
- **Guard widened**: cart and checkout may not reach `modules/promotions` by any spelling — deep path, roundabout
  path, `import()` or `require()` — with a self-test of the pattern. **`test/wiring.test.ts`**:
  `registerModuleSeams()` registers `stripe`, the payments refund requester, carrier rates, the tax calculator
  and the price-list resolver without any configuration, and is idempotent.

- `src/wiring.ts` → `registerModuleSeams()` now also calls window 7's `registerTaxProvider()`: the cart's
  `TaxCalculator` is the tax module's (table or Stripe Tax per `store.settings.tax`). With default store settings
  it answers exactly like the built-in table calculator; both read the same `prices_include_tax` setting and the
  same `taxOn` rounding, so the per-line record of #221 stays consistent.

### 2026-09-19 · cart unit prices through price lists, 409 `price_changed`, boot wiring (#179 part 3, #228, #226)

- **`PriceResolver` seam** (`setPriceResolver`, default `defaultListPriceResolver`: default list, tiered by
  quantity). `addLineItem` / `updateLineItem` / `removeLineItem` re-price the whole cart through
  `repriceLines`; the unit price follows the line quantity (tiers) up and down.
- **`src/wiring.ts` → `registerModuleSeams()`**, called once by `createServer()`: `priceListResolver` over window
  9's `resolvePrices` (sale > group/override > default, windows at the mutation's clock, channel, customer group)
  **and the two boot calls that were never wired although #176 is closed — `registerPaymentProviders()` and
  `registerCarrierProviders()`**: until now the running server had no `stripe` provider, no payments
  `RefundRequester` and no live carrier rates.
- **409 `price_changed`** at placement (CONTRACT CHANGE #228; local `CoreErrorCode` union in `src/lib/errors.ts`
  until it lands): nothing placed or authorized, the cart re-priced, `details` lists the changed lines
  (`unit_price_minor: null` = no longer sellable); the retry places at the new price.
- **#224 review nits**: order edits re-price each line in the mode frozen on THAT line (one calculator call per
  mode present; tax on top only for the exclusive part); cart README totals table and the `providers.ts` header
  no longer say prices are only tax-exclusive. **#220 nits**: the EasyPost mount test asserts exactly 404 (a 401
  would mean staff auth fronts the webhook); the over-long CLAUDE.md line is reflowed.
- **Docs (#226, window 8's text)**: `CLAUDE.md` rows and Public API bullets for `src/modules/shipping` and
  `src/modules/fulfillment`. Tests: `test/cart-pricing.test.ts` (5, with the server's resolver), store-api +1
  (the 409 over HTTP, validated against the `Error` schema), guards +1 (cart/checkout never import promotions).

### 2026-09-19 · per-line tax from the calculator + `prices_include_tax` (#221, window 7's REQUEST)

- **No more per-line recompute**: `recalculate` stores each line's calculation in
  `cart_line_item.metadata.tax = { amount_minor, mode, bp }`; the cart line, `order_line_item.tax_minor` /
  `total_minor` and `order.placed` read it through `lineTaxOf` instead of `taxOn(base, tax_rate_bp)`. A provider
  whose per-line rounding differs from ours (Stripe Tax) no longer makes Σ line tax drift from the order tax.
  `completeCart` reloads the lines after its `recalculate` so it freezes what was just priced.
- **Tax-inclusive stores**: `store.settings.tax.prices_include_tax` (default false = unchanged behaviour) →
  `PricingContext.pricesIncludeTax` (additive, optional). Totals: tax is reported but not added on top, for the
  cart, its lines, the order and its lines. `taxOn(base, bp, included)` is the single half-up rounding for both
  modes; `tableTaxCalculator` returns the contained tax when the flag is set.
- **Order edits** re-price in the mode frozen on the order lines, whatever the store's setting is by then.
- New cart exports: `lineTaxOf`, `lineTotalWith`, `pricesIncludeTaxFor`, types `LineTaxRecord`, `TaxMode`.
  One changed expectation: the 2.1 seam test asserted the old recompute (line tax from the rate); it now asserts
  the calculator's amount. Pending boot line: `registerTaxProvider()` — window 7's `src/modules/tax` is not on
  main yet. Tests: cart +2, checkout +2, store-api +1 (the record never appears in a Store API response).

### 2026-09-19 · quiet-state wiring batch (#179 amendment, #176 part 3, #159 part 2)

- **Admin router mounts** (`src/http/module-routers.ts` → `moduleAdminRouters()`): window 9's `mediaRouter()`
  (#168: `…/media/upload-params`, `…/products/{productId}/media/**`), `pricingRouter()` (#137: `…/price-lists/**`)
  and `promotionsRouter()` (#138 / #189: `…/promotions/**`) next to merchandising and marketing — promotion and
  price-list routes were 404s on the running server until now. Window 8's `shippingAdminRouter()` (#131:
  `POST …/orders/{orderId}/shipments`, `PATCH /admin/shipments/{shipmentId}`) joins them.
- **Webhook mount point**: `moduleWebhookRouters()` + the `webhookRouters` option of `mountCoreMiddleware`
  (opt-in like `moduleRouters`; `createServer()` passes it). Mounted outside the `/store` and `/admin` chains and
  before any JSON body parser: window 7's `paymentsWebhookRouter()` — `POST /webhooks/stripe/:storeCode`, raw
  body, the Stripe signature is the authentication (stale signature → 400 `timestamp_out_of_tolerance`, unknown
  store → 404) and window 8's `shippingWebhookRouter()` — `POST /webhooks/easypost/:storeCode` (HMAC over the
  raw body; no secret → 503 naming the variable). Pending until its export reaches main, one line: window 7's
  `paymentsAdminRouter()` (#126). Both webhook receivers record into `webhook_event` (migration 0140, #187): until
  that migration is on main a correctly signed delivery cannot be stored.
- **Payment seam (additive, pre-approved by the manager for window 7)**: `RefundResult.status` gains
  `'pending'` (`src/lib/payment-seam.ts`) for providers that settle refunds asynchronously; the default
  `manualRefundRequester` passes it through as a pending outcome (return stays `received`, never asked twice).
- **Docs**: `CLAUDE.md` gains the `src/modules/promotions` row and the webhook mount rule; the
  `src/modules/search` row (there since 2.2, #159 part 2) now names merchandising + media and the CLI path.
  Tests: `admin-api.test.ts` +2 (five admin routers answer behind staff auth; the webhook answers without it).

### 2026-09-15 · #214 follow-up (returns dust, throwing requester, release items, #191 shape, docs)

- **Returns — no floor dust across partial returns**: `refundAmountFor` allocates a line total by cumulative
  floor over the line's units (`returned_quantity` before the receipt as the base), so three returns of one unit
  from a 100-minor line refund 33 + 33 + 34; the signature now reads `returned_quantity` from the lines.
- **Returns — a throwing `RefundRequester` is a failed outcome**: `requestRefundFor` runs the requester under
  a savepoint; a throw rolls back to it, keeps the receipt + restock + `return.received`, records
  `{ status: "failed", failure_reason: "requester threw: …", idempotency_key: "return:<id>" }` and a later
  `requestRefundFor` (now exported) retries under the same key. `metadata.refund` carries `idempotency_key`.
- **Inventory — `releaseReservationsForShipment` honours `items`**: per variant the release target is
  `min(consumed, asked)` minus what earlier calls released under the shipment, spent across the variant's
  warehouse rows in canonical order — priority, then code (same call twice = once, larger
  call = the difference, empty `items` = everything still held).
- **Orders — `setFulfillmentStatus({ tx, orderId, status, actor })`**: #191's object shape, exported next to
  the positional `setFulfillmentStatusIn` (kept for window 8's current adapter).
- **Docs**: `CLAUDE.md` `src/jobs` row lists only `abandoned-carts.ts`; window 9's CLI path corrected to
  `src/modules/search/cli/index-products.ts`. Tests: returns +2, inventory +1, orders +1.

### 2026-09-15 · declare `@medusajs/draft-order` (#207)

- `apps/core/package.json` declares `@medusajs/draft-order` at the `@medusajs/medusa` version (2.20.1). Medusa 2.20
  resolves a default plugin set from the app directory, and pnpm's isolated `node_modules` only links direct
  dependencies — without the declaration the built server died in the plugin loader (`Unable to resolve plugin
"@medusajs/draft-order"`) right after the bootstrap check. Verified: `pnpm --filter @platform/core start` reaches
  `GET /health` → 200.

### 2026-09-09 · 2.6 `cart.abandoned` job, lifecycle replay, module docs (issue #108) — Phase 2 core complete

- Cart: `markAbandonedCarts` / `markAllAbandonedCarts` (injected clock; idle active carts with lines → `abandoned`
  - one `cart.abandoned` v1, `email_hash` only; `FOR UPDATE SKIP LOCKED`; empty carts skipped). **Reactivation**:
    a mutation on an abandoned cart flips it back to `active` and restarts the idle clock; a later abandonment is a
    new event; `completed` stays 409. Job `src/jobs/abandoned-carts.ts`: Medusa scheduled job (`config.schedule`
    from `CORE_ABANDONED_CART_CRON`, default hourly; threshold `CORE_ABANDONED_CART_AFTER_HOURS`, default 6) running
    one organization-scoped pass under `MEDUSA_WORKER_MODE = shared | worker`, plus a one-shot CLI.
- `test/lifecycle-replay.test.ts`: place → confirm → capture → shipment created → shipped (reservation consumed
  through window 8's port shape) → delivered → return → received (restock + refund) — one event per transition
  asserted end to end, and the order, return and stock projections folded from the outbox equal the rows; the
  cancel branch (reservations released) and the abandoned branch.
- #191 (window 8's port shapes): `setFulfillmentStatusIn(tx, orderId, status, actor)` (orders),
  `consumeReservationsForShipment` / `releaseReservationsForShipment` (inventory; by order line item, idempotent
  per shipment via the movement reference).
- #179 part 1: catalog `addMedia` / `updateMedia` / `deleteMedia` (positions contiguous, thumbnail = position 0,
  audit + `product.updated` `["media"]`).
- Window 7's gap: the placement failure path's `PaymentProvider.void` now carries `organizationId` / `storeId` /
  `cartId` (per-store credentials without touching the rolled-back transaction); `RefundInput` carries the store
  too. Tested on the manual provider's call log.
- #191: `…InTx(tx, …)` twins of every order marker (`confirmOrderInTx`, `markPayment*InTx`,
  `markShipmentCreatedInTx`, `markShippedInTx`, `markDeliveredInTx`, `markReturnedInTx`, `cancelOrderInTx`) so
  shipping runs them on its own transaction (a shipment insert's `FOR KEY SHARE` on the order row deadlocked the
  client-taking ones); tested with a shipment row inserted in the same transaction.
- Docs: module table complete (cart … returns, jobs), READMEs with the ADR-style decisions, "What is real" jobs row.
- Tests: `abandoned.test.ts` (3), `lifecycle-replay.test.ts` (3), catalog media +1, inventory ports +1.

### 2026-09-08 · 2.5 returns and exchanges (issue #107)

- `src/modules/returns` (new): `requestReturn` (per line ≤ shipped − returned − open requests, 409 otherwise;
  unshipped order 409; `return.requested`), `receiveReturn` in one transaction (received ≤ requested, unreceived
  items dropped; `received`; orders `markReturnedIn` → returned quantities + fulfillment_status; inventory
  `moveStock(reason 'return')` for resellable goods only; `return.received`; the refund through the seam),
  `approveReturn` / `rejectReturn` (support flows, no event), `markReturnRefunded` (window 7 settles a pending
  refund), `linkExchange` (return + linked order, no money coupling), `renderReturn` / `getReturn`, pure
  `projectReturn`. **Refund seam** `RefundRequester` + `setRefundRequester`: the manual default calls
  `PaymentProvider.refund` and returns no id; window 7's requester writes the `refund` row + `refund.*` events and
  returns the id the return stores. Idempotent per return (`return:<id>`, outcome recorded on the row: a retry
  never refunds twice). Amount = received items' share of the line total (floor), shipping excluded; requires a
  captured payment (409 otherwise). Order `payment_status` follows (partially_refunded | refunded).
- Orders: `markReturnedIn`, `movePaymentStatusIn`, `mergeOrderMetadataIn` — transaction-level variants for the
  returns module (no nested transactions while the order row is locked).
- Admin API: `POST /admin/stores/{storeId}/orders/{orderId}/returns` (support) → 201, `POST
/admin/stores/{storeId}/returns/{returnId}/receive` (operations on HQ; the store in the path must be the
  return's → 404) → 200; live suite: createReturn through OpenFGA.
- Wiring batch: `payment.authorized` emitted in `completeCart` next to `order.placed` (#176 part 2);
  `enumParam` / `sortParams` exported from `src/http/index.ts` (#181 part 2). The mount lines (#176 part 1,
  #179 part 2, #181 part 1) land in `src/http/module-routers.ts` as each module's export reaches main.
- Tests: `src/modules/returns/returns.test.ts` (6: request rules, receive + restock + seam once + amount rule +
  replay, full refund, failed/pending + markReturnRefunded + retry never twice, captured-only + rollback after the
  outbox insert, RLS + exchange), `test/admin-api.test.ts` +2, `test/auth-live.test.ts` +1.

### 2026-09-08 · 2.4 inventory: levels per warehouse, reservations at placement, backorders (issue #106)

- `src/modules/inventory` (new): `moveStock` — the only writer of `on_hand` (locked level, append-only
  `stock_movement`, one `stock.moved` v1; negative `on_hand` only through `sale`), `reserveForOrder` — the stock
  check at placement (deterministic lock order variant id → warehouse priority → code; greedy allocation across
  active warehouses; non-backorderable shortfall → 409 `out_of_stock` with full rollback; backorderable reserves
  anyway and `available` goes negative; a reservation is never a movement), `releaseForOrder` (cancel, idempotent),
  `consumeForShipment` (window 8: reservation → `sale` movement per warehouse; over-consumption 409),
  `listInventoryLevels` / `createStockMovement` for the Admin API. Guard: no `UPDATE inventory_level` /
  `INSERT INTO stock_movement` outside the module; the app role cannot UPDATE/DELETE movements (tested).
- Checkout: `reserveForOrder` replaces the advisory re-check at placement; **void on failure** — any throw after a
  successful `authorize` voids the authorisation before the rollback (#174 review; manual provider call log tested).
- Orders: `cancelOrder` releases the order's reservations through its own transition; the wrappers' idempotency
  read now happens under the row lock (#174 review).
- Admin API: `GET /admin/inventory/levels` (with `store_id` → that store; without → `store:*` and the caller's
  visible stores; filters, `below_available`, sort/order), `POST /admin/inventory/movements` (`operations`;
  reasons receipt | adjustment | transfer_in | transfer_out | cycle_count) → 201 `InventoryLevel`; one levels route
  in the live suite.
- Wiring batch (#176 / #179 / #181, manager decision — travels with 2.4): `src/http/module-routers.ts` mounts window 9's
  `merchandisingRouter({ repository: new PgRulesRepository(), indexFor })` (#162 part 3) and window 17's
  `marketingAdminRouter()` (#181 part 1); `completeCart` emits `payment.authorized` v1 next to `order.placed` (#176
  part 2); `enumParam` / `sortParams` exported from `src/http/index.ts` (#181 part 2). Not yet mountable (module not on
  main): `registerPaymentProviders()` (#176 part 1), `mediaRouter()` (#168), `pricingRouter()` + the cart's
  `resolvePrices` call site (#179 parts 2/3); #179 part 1 (catalog media functions) = a later core PR.
- Tests: `src/modules/inventory/inventory.test.ts` (9: movement + event + append-only, greedy allocation, 409 +
  rollback + void, backorder negative, 8 parallel placements on shared variants in shuffled order, last-unit race,
  release/consume, Store availability, admin list/RLS across the shared warehouse, adjust), `test/admin-api.test.ts`
  +2, `test/auth-live.test.ts` +1, guards +1.

### 2026-09-08 · 2.3 order state machine, wrappers for windows 7/8, edits, Admin API order routes (issue #105)

- `src/modules/orders` (new): `transitions.ts` (one map per status field — the README tables are asserted equal),
  `transition(tx, orderId, change)` (locks the row, validates against the tables, applies, writes exactly one
  event: `order.confirmed` / `order.cancelled` / `order.completed` for `status`, `order.updated` with
  `changed_fields` otherwise; illegal → 409 `conflict` `{ field, from, to }`), wrappers `confirmOrder`,
  `markPaymentAuthorized/Captured/Failed/PartiallyRefunded/Refunded`, `markShipmentCreated`, `markShipped`,
  `markDelivered`, `markReturned` (scoped client + ids, idempotent on the target state), `cancelOrder` (only while
  unfulfilled; voids authorised payments through `PaymentProvider.void`, payment row → `cancelled`), order edits
  `decreaseLineQuantity` / `cancelLine` (totals via the cart's `TaxCalculator`, delta on `order.metadata.edits`,
  no money moved; CONTRACT CHANGE #172 filed for the Admin API endpoint), read models (Store order read moved here
  from checkout; Admin `listAdminOrders` with filters / `q` / sort / pagination, `getAdminOrder` with payments,
  refunds, shipments, returns), pure projection `projectOrder` for replay. Guard: no `UPDATE "order"` outside
  the module.
- Admin API routes: `GET /admin/stores/{storeId}/orders` (filters, `q`, `sort`/`order`, `placed_from/to`),
  `GET …/orders/{orderId}`, `POST …/orders/{orderId}/cancel` with the spec's `x-permission` through the real
  `requirePermission`; one order route in the live suite (real token, OpenFGA). `dateParam` in `src/http/query.ts`.
- `src/http/module-routers.ts` + `mountCoreMiddleware({ moduleRouters })`: the named mount point for other
  modules' Admin routers (window 9's `merchandisingRouter`, #162 part 3), after `adminRouter()`.
- Checkout (#165 review fold-ins): `PaymentProvider.void` (manual no-op); `GET /store/orders/{orderId}` → 404 for
  a malformed id or email; idempotency keys are per store — stored as `<store_id>:<key>` because
  `payment.idempotency_key` is UNIQUE table-wide while RLS hides other stores' rows from the replay lookup (the
  new per-store test caught the unique-violation 500 before the fix).
- #159 part 2: window 9's `src/modules/search` row in CLAUDE.md's module table (Algolia index per store, outbox
  sync, `src/jobs/index-products.ts`; reads `product.*` from the outbox).
- Tests: `src/modules/orders/orders.test.ts` (9), `test/admin-api.test.ts` +3, `test/auth-live.test.ts` +1,
  `checkout.test.ts` +1 (per-store key), `store-api.test.ts` (404 on malformed lookups), guards +1.

### 2026-09-08 · 2.2 checkout completion: shipping options, payment session, placement, order read (issue #104)

- `src/modules/checkout` (new): `listShippingOptions` (cart module's `ShippingRateProvider.list`),
  `createPaymentSession` (stored on `cart.payment_session` as the contract shape), `completeCart` — ONE transaction
  on the locked cart: preconditions (400 with the missing fields), totals refreshed, stock re-checked (409
  `out_of_stock`), `PaymentProvider.authorize` (402 `payment_failed`, nothing written), `"order"` (display_id from
  the 0006 store-row trigger — serialises placements per store, never collides), `order_line_item` (exact
  `tax_minor`/`total_minor`), `payment` (carries the `Idempotency-Key` — the idempotency record, no new table),
  `recordAttribution` from `src/lib/attribution.ts`, `order.placed` v1 through `withEvents` (`email_hash` only),
  cart `completed` + `order_id`. Replay with the same key returns the stored order without calling the provider;
  another key on a completed cart → 409 `cart_completed` `{ order_id }`; the same key on another cart → 409
  `conflict`. `getStoreOrder`: customer token (`verifyCustomerToken` + `customer.keycloak_subject`) or guest
  `?email=` (trimmed, case-insensitive); 200 or 404 only. `PaymentProvider` interface + `setPaymentProvider`
  (window 7's Stripe seam, #127) with the built-in `manual` provider (authorises immediately, `client_secret: null`).
- Cart module: `loadCart`, `lockActiveCart`, `loadLines`, `recalculate`, `renderCart`, `assertLinesInStock` and the
  row types are exported for the checkout module (same tables, same transaction).
- Store API routes: `GET /store/carts/{cartId}/shipping-options`, `POST …/payment-session`, `POST …/complete` → 201,
  `GET /store/orders/{orderId}`; the fallback proxy now only covers `/store/customers*`.
- Review nits from #157: `GET /store/products/{handle}?currency=X` → 404 when no variant is priced in X;
  `test/store-fallback.test.ts` proves a body parsed by `express.json` upstream reaches the mock intact.
- Tests: `src/modules/checkout/checkout.test.ts` (10: placement contents, idempotency with the provider called
  once, 402 + rollback-after-outbox with nothing written, 8 concurrent placements → consecutive display ids,
  RLS, order access rule) and `test/store-api.test.ts` +5 (contract replay of every route, guest lookup, no PII
  in log lines).

### 2026-09-08 · 2.1 cart module + `currency` on product reads (issue #103)

- `src/modules/cart` (new): `createCart`, `getCart`, `updateCart`, `addLineItem`, `updateLineItem`,
  `removeLineItem` over `cart` / `cart_line_item` (packages/db 0006) on the store-scoped client — every row carries
  `organization_id` + `store_id`, another store's cart is a 404. Totals recomputed on every change in the same
  transaction (cart row locked): subtotal, discount (0 until window 9's promotions API; codes stored normalised),
  shipping through a `ShippingRateProvider` (default: `shipping_option` table), tax through a `TaxCalculator`
  (default: `tax_rate` table, tax-exclusive prices, per-line `tax_rate_bp` persisted), integer minor units.
  409 `out_of_stock` when a tracked, non-backorderable variant cannot cover the quantity; 409 `cart_completed` for
  mutations on a non-active cart; `metadata` round-trips unchanged (replaced whole on PATCH).
  `setTaxCalculator` / `setShippingRateProvider` are the seams for windows 7 (#127) and 8 (#130).
  **Decision:** carts bypass Medusa's cart module; no Medusa mirror of stores/keys is needed (README "Decisions").
- Store API routes (`src/http/store-routes.ts`): `POST /store/carts`, `GET`/`PATCH /store/carts/{cartId}`,
  `POST /store/carts/{cartId}/line-items`, `PATCH`/`DELETE /store/carts/{cartId}/line-items/{lineItemId}` mounted
  ahead of Medusa and of the fallback proxy; JSON bodies validated against store-api.yaml 0.3.0 (`express.json` on
  `/store/carts` only); `cartId` / `lineItemId` must be uuids (400). Store API 0.3.0 `currency` query on
  `GET /store/products` and `/store/products/{handle}`: one of the store's currencies (`resolveCurrency`), default
  the store default currency, 400 `validation_error` `{ currency: "one of …" }` otherwise; products without a price
  in that currency are not listed. `coreErrorHandler` renders body-parser errors (malformed JSON) as 400
  `validation_error` instead of 500.
- `scripts/db-medusa-migrate.ts` sets `TS_NODE_TRANSPILE_ONLY=1`: Medusa's loaders register ts-node behind tsx and
  ts-node type-checked tsx's transpiled `medusa-config.ts` (TS7006 noise + a reported failure after the migrations
  had succeeded — Integration 1 finding). The script exits 0 again.
- Tests: `src/modules/cart/cart.test.ts` (14) and `test/store-api.test.ts` +9 (currency fixture: USD added to
  brand-a in the test database only; every cart operation replayed and spec-validated; RLS 404; 409s).

## Unreleased — Integration 1 (integration/phase1)

### 2026-09-08 · attribution at placement (`src/lib/attribution.ts`)

- `parseCartAttribution`, `orderMetadataFromCart`, `recordAttribution(tx, …)`: `cart.metadata.attribution` →
  `order.metadata` copy + one `attribution` row per touch (`first`/`last`, migration 0120) + one
  `attribution.recorded` v1 event per row through the outbox, on the placement transaction. Referrers are reduced
  to their origin, values capped at 200 chars, malformed metadata yields no rows (never fails a placement).
  Window 1 calls it from `POST /store/carts/{id}/complete` in Phase 2 task 2.2 (#104). Tests: `test/attribution.test.ts` (8).

### 2026-09-08 · real staff auth, OpenFGA permissions, hq-rbac mounted, Store API fallback

- `src/http/staff-auth.ts`: `KeycloakStaffTokenVerifier` — staff-realm JWT (JWKS, `aud: core-api`) →
  `staff_user` → OpenFGA scope through hq-rbac's `createStaffScopeMiddleware` (`@platform/auth-sdk`); the
  principal carries `scope: StaffScope` (`storeIds`, `organizationRelations`, `scope`) and `stores[]` lists every
  visible store with its direct `role_assignment` relations, so `storeClientFor` / `visibleStoresClientFor` keep
  working. `composeStaffTokenVerifier`: `dev:<subject>` → `DevTokenVerifier` only with `CORE_DEV_TOKENS=1` outside
  production; any other bearer → Keycloak. `src/server.ts` `buildStaffAuth()` builds it by default from
  `KEYCLOAK_URL`, `KEYCLOAK_REALM_STAFF`, `OPENFGA_API_URL`, `OPENFGA_STORE_ID`, `OPENFGA_MODEL_ID`; a missing
  `OPENFGA_STORE_ID` aborts the boot in production and logs a warning locally. Real tokens are the default; dev
  tokens are opt-in.
- `src/http/permissions.ts`: `requirePermission` asks OpenFGA (auth-sdk `can()`, `store:*` via ListObjects) for
  principals with a scope; the `role_assignment` stub stays for dev-token principals. 403 carries
  `details: { relation, object }` for real tokens; OpenFGA unreachable → 503 `internal` (`AppError` gained a
  status override, `fromApiError` maps auth-sdk's `ApiError`).
- `src/http/hq-rbac-adapter.ts`: window 2's `createHqRbac({ pool, fga, onRoleChange }).handle(...)` mounted ahead
  of `adminRouter()` with the principal/scope the middleware resolved (dev-token principals get a synthesised
  scope); `null` → `next()`. `/admin/users*`, `/admin/audit-log`, `/admin/finance/ping` are live.
- `src/http/store-fallback.ts` + `CORE_STORE_API_FALLBACK=1` (explicit opt-in, same pattern as `CORE_DEV_TOKENS`) with `CORE_STORE_API_FALLBACK_URL`; refused unconditionally in production before either variable is read (owner requirement, Int 1 review):
  every `/store/*` request the four real routes do not answer is proxied verbatim to the Prism mock with Node's
  `fetch`; one log line per request (method + path). `mountCoreMiddleware(app, verifier?, { fga, onRoleChange,
storeApiFallbackUrl })`.
- Tests: `test/auth-live.test.ts` (real Keycloak tokens, throw-away OpenFGA store; skips without the stack) and
  `test/store-fallback.test.ts` (local http server as the mock, production refusal). Existing dev-token suites
  unchanged and green.
- Known blocker for `pnpm dev` (not for tests): `@platform/auth-sdk`'s export map has no `default`/`require`
  condition, so the CommonJS core cannot `require()` it (`ERR_PACKAGE_PATH_NOT_EXPORTED`) — needs the same
  one-line change `@platform/db` got in #40.

## Unreleased — Phase 1 (window 1, contracts-v0.2)

### 2026-09-07 · customer PII gate proven for window 1 (contracts 0.2.1, issue #77)

- `test/admin-api.test.ts`: the frozen spec gates `listCustomers` / `getCustomer` / `updateCustomer` with
  `support` (not `viewer`); an `analyst` gets **403** on a route carrying that permission while keeping the
  viewer-gated aggregates (products) — and `hasPermission` denies `analyst` `support` on every store, including
  `store:*`. The customers routes themselves belong to window 13 and stay on the Prism mock in Phase 1; the probe
  route mounts the spec permission on our guard so the gate is proven for everything window 1 owns.

### 2026-09-07 · follow-up — `sort` / `order` on Admin API list handlers (contracts 0.2.0)

- `GET /admin/stores` (`sort`: code | name | status | created_at, default `created_at`) and
  `GET /admin/stores/{storeId}/products` (`sort`: title | handle | status | created_at | updated_at, default
  `updated_at`) accept `order` (asc | desc, default desc, ignored unless `sort` is present) — the only two list
  operations window 1 owns that gained the parameters. Unknown values → 400 `validation_error` with details.
  ORDER BY columns are whitelisted per enum value.

### 2026-09-07 · task 1.9 — READMEs, CLAUDE.md, tests green (issue #9)

- READMEs for `src/http` and `src/lib`; every module folder now has `index.ts`, `README.md` (purpose, public API,
  events, permissions, how to test) and tests. CLAUDE.md lists the modules in a table with the exact run/test
  commands (incl. building workspace packages before package-local typecheck/test).
- Verified on the merged `main`: typecheck clean, lint clean, 65 tests green (55 core + window 2's hq-rbac), CI
  `unit` job runs them through `pnpm test`.

### 2026-09-06 · task 1.8 — bootstrap verifier (issue #8, re-scoped) + ts-node (#60)

- `src/bootstrap/verify.ts` + `pnpm --filter @platform/core bootstrap`: read-only readiness checks (our tables,
  organization, every store has an active channel / live publishable key / default price list, seeded keys resolve
  through the tenant layer, Medusa schema + link tables migrated); exit 1 with a fix per finding. Runs at server
  start too; `CORE_BOOTSTRAP_STRICT=1` aborts the boot when not ready. No Medusa-side rows (deferred to Phase 2).
- `ts-node` devDependency and a build-tolerant `medusa-config.ts` (loads the root `.env`, loud placeholders instead
  of throwing) so `pnpm --filter @platform/core build` works on a clean checkout (#60).

### 2026-09-05 · fold-back onto `core/phase1` (tasks 1.2–1.7 in one PR)

- Static imports of `@platform/db` / `@platform/events` (the `default` export condition landed on main, #40);
  the dynamic `import()` shims in `src/lib/db.ts`, `src/outbox/with-events.ts` and `scripts/db-medusa-migrate.ts`
  are gone.
- Dev tokens are an explicit opt-in: `CORE_DEV_TOKENS=1`, and never in production (`NODE_ENV=production` refuses
  before the flag is consulted).
- `requirePermission(relation, objectFactory)` is now a route middleware with the `@platform/auth-sdk` signature;
  `can(principal, relation, object)` / `assertPermission` back it. Admin routes chain `permission(op)` → `body(op)`.
- `@platform/auth-sdk` and `@platform/db` are workspace dependencies (#48); contracts 0.2.0 (additive sort/order
  params, implemented in a follow-up task).

### 2026-09-05 · task 1.7 — Admin API routes with x-permission checks (issue #7)

- `src/http/admin-routes.ts` (`adminRouter`, mounted ahead of Medusa): `/admin/me`, stores (list/create/get/patch),
  domains, sales channels, api keys, warehouses, legal entities, categories, products (list/create/get/patch/
  archive/publish), variants (create/patch). Handler order: body validation → permission → scoped client → module.
- `src/http/openapi.ts`: loads the frozen `admin-api.yaml` at runtime (`yaml`, `ajv`, `ajv-formats` are runtime
  deps now) — request bodies validated against each operation's `requestBody` schema (400 `validation_error` with
  per-field `details`), `x-permission` read from the same document.
- `src/http/permissions.ts`: `requirePermission(principal, relation, object)` — Phase 1 stub over
  `role_assignment` following ADR 0002 (`@platform/auth-sdk` drops in behind the signature).
- `src/http/query.ts` shared query helpers; registry `listWarehouses` / `listLegalEntities`.
- `@platform/auth-sdk` added as a workspace dependency (issue #48).
- `test/admin-api.test.ts`: 6 cases on the seeded DB — `/admin/me` relations, finance 403 on product create,
  store-staff 403 on store create and 201 on product create, 400 details, 404/400 ids, domains/channels/keys,
  warehouses/legal entities by role, archive needs store_admin; responses validated against `admin-api.yaml`.

### 2026-09-05 · task 1.6 — Store API routes (issue #6)

- `src/http/store-routes.ts` + `mountStoreRoutes` (mounted by `mountCoreMiddleware` ahead of Medusa): `GET /store`
  (store, currencies, locales, the key's sales channel), `GET /store/categories`, `GET /store/products` (`q`,
  `category` incl. children, `tag`, `sort`, `page`, `limit`; 400 `validation_error` on bad params),
  `GET /store/products/{handle}` (404 outside the store). Prices in the store default currency
  (`StoreContext.defaultCurrency`).
- `test/helpers/openapi.ts`: Ajv 2020 validator over the frozen `store-api.yaml` components; `test/store-api.test.ts`
  replays the Phase 0 contract requests and validates every response (`yaml`, `ajv`, `ajv-formats` dev deps).

### 2026-09-05 · task 1.5 — outbox helper as a structural guarantee (issue #5)

- `src/outbox/index.ts` public API (`withEvents`, `buildEvent`, `eventActor`, `InvalidEventError`), README with the
  four guarantees; modules import the helper through the index only (guard test).
- `outbox.test.ts`: throw after the insert → no outbox row and no state change; schema-invalid envelope → clear
  `InvalidEventError`, nothing committed; every envelope validated before any insert; create → publish yields
  exactly `product.updated` then `product.published` (`store_id`, `version 1`, `published_at NULL`); headers shape.
- `eslint.config.mjs`: `no-restricted-syntax` — any `INSERT INTO outbox` in a template literal or string outside
  `src/outbox/**` is a lint error (in addition to `test/guards.test.ts`).

### 2026-09-05 · task 1.4 — catalog module (issue #4)

- `src/modules/catalog`: categories (tree), products (create/update/publish/archive), options, variants (unique
  `sku`, options validated against the product's options, prices written to the default list per currency), media;
  Admin API shapes with prices and inventory per variant. Events `product.updated` / `product.published` /
  `product.archived` through `withEvents`; `audit_log` on every mutation.
- Store read model: `listStoreProducts` (published only, lowest default-list price in the requested currency,
  category filter includes descendants, tag, ILIKE `q` stub, sort), `getStoreProduct` (variants with `price`,
  `compare_at_price`, `in_stock`, `available_quantity` over active warehouses), `listStoreCategories`.
- Tests: 9 cases on a fully seeded throwaway database (brand-a lists 200 products, 0 available → `in_stock:false`,
  create → publish event order, archive event, 409s, scope).

### 2026-09-05 · task 1.3 — tenant context middleware, RLS proven through HTTP (issue #3)

- `src/http/`: `requestIdMiddleware` (X-Request-Id in/out), `storeContextMiddleware` (`X-Publishable-Key` →
  `store_api_key` → store-scoped client on `req.tenant`; missing/unknown/revoked → 401), `staffAuthMiddleware`
  (bearer token → `staff_user` → `role_assignment` → `req.principal`; Phase 1 `DevTokenVerifier` accepts
  `dev:<keycloak_subject>` outside production only), `storeClientFor` / `organizationClientFor` /
  `visibleStoresClientFor` (403 outside scope), `coreErrorHandler` + `handle()` rendering `AppError` as the
  contract `Error`. `mountCoreMiddleware(app)` is what `src/server.ts` mounts ahead of Medusa.
- `eslint.config.mjs` + `lint` script: `no-restricted-imports` on `pg` outside `src/lib/db.ts`; `test/guards.test.ts`
  greps for `pg` imports and `INSERT INTO outbox` outside their owners.
- `test/tenant-http.test.ts`: seeded throwaway database, the real middleware chain on a bare Express app — brand-a
  key never returns brand-b rows, brand-b key gets 404 on a brand-a id, 401s, store-staff 403 on brand-b, owner 200.
- `initDb({ connectionString })` for tests; `dbModule()` exposes `SEED_IDS`; `CORE_ORGANIZATION_ID` env (default
  seeded HQ) selects the organization the key/user lookups run under.

### 2026-09-05 · task 1.2 — registry module (issue #2)

- `src/modules/registry`: stores (list/get/create/update), domains (one primary), locales/currencies (one default,
  mirrored on the store), sales channels, API keys (plain key returned once, sha256 stored) over the frozen 0003
  schema. Every mutation: one transaction with `audit_log` and, for stores, `store.created` / `store.updated`.
- `src/outbox/with-events.ts`: first cut of `withEvents(tx, events[])` (schema validation, same-transaction
  insert; hardened in task 1.5). `src/lib/audit.ts` (`writeAudit`, Phase 1 stub for the auth-sdk helper),
  `src/lib/errors.ts` (`AppError` with contract codes, pg unique/FK violation mapping).
- Tests: 9 registry cases on a throwaway database as `platform_app` (RLS), incl. rollback on an invalid event.

### 2026-09-04 · task 1.1 — Medusa 2 boots against the Phase 0 stack (issue #1)

- Medusa 2.20.1 project: `medusa-config.ts` (schema `medusa`, `DATABASE_URL_APP`, Redis cache + event bus,
  admin dashboard off), CommonJS tsconfig (`module: NodeNext`), Vitest config.
- `src/server.ts`: Express app with `/health` and the `X-Publishable-Key` → `x-publishable-api-key` alias mounted
  ahead of Medusa's loaders; graceful shutdown.
- `src/lib/db.ts`: the single pool (`platform_app`) and `tenantClient` / `organizationClient` from `@platform/db`.
- `scripts/db-medusa-migrate.ts`: role `medusa_owner` + schema `medusa` + default privileges, Medusa migrations
  as that role (in-process), catch-up grants for `platform_app`. `search_path` pinned via `databaseDriverOptions`.
- README (two schemas, module layout, how a module gets a tenant client), CLAUDE.md run/test commands.

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
