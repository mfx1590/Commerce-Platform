# Changelog — @platform/core

## Unreleased — Phase 2 (window 1, contracts-v0.3)

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
