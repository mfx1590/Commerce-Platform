# @platform/core

## Purpose

Medusa 2 commerce core (modular monolith) over the tenant-scoped schema in `@platform/db`. Modules (planned):
registry, catalog, pricing, checkout, orders, inventory, fulfillment, customers, hq-rbac, hq-warehouse, payments,
tax, fraud, shipping, search, promotions. Phase 1 (window 1): registry + catalog, Store/Admin API routes for them.
Phase 2 (window 1): cart (2.1, done), checkout/placement (2.2, done), orders (2.3, done), inventory (2.4, done), returns (2.5, done),
`cart.abandoned` job + lifecycle replay (2.6, done) — **Phase 2 core complete**; only `/store/customers*` (window 13)
stays on the Prism mock behind the fallback proxy.

## Owner

window 1 (core); sub-folders under src/modules/\* belong to windows 2, 7, 8, 9, 11, 13 per docs/ownership.md.

## Run / test

- Prerequisites once per machine: `pnpm dev` at the repo root (docker stack on 5433/6381, `pnpm db:migrate`,
  `pnpm db:seed`), then `pnpm --filter @platform/core db:medusa:migrate` (Medusa's own tables, schema `medusa`).
- `pnpm --filter @platform/core bootstrap` — readiness verifier (read-only): migrations + seed present, every store
  has a channel and a live publishable key, seeded keys resolve, Medusa schema migrated. Also runs at server start
  (`CORE_BOOTSTRAP_STRICT=1` aborts the boot when not ready).
- `pnpm --filter @platform/core dev` — tsx watch on `src/server.ts`; `GET http://localhost:9000/health` → 200.
- `pnpm --filter @platform/core typecheck` — `tsc --noEmit` (CommonJS app, `module: NodeNext`).
- `pnpm --filter @platform/core test` — Vitest; DB tests create their own database via `@platform/db/testing`.
- `pnpm --filter @platform/core lint` — root rules + this app's `no-restricted-imports` guard on `pg`.
- Local Admin API calls (Integration 1): **real Keycloak staff tokens are the default** — a staff-realm JWT
  (`aud: core-api`; locally `POST http://localhost:8180/realms/staff/protocol/openid-connect/token` with
  `client_id=test-cli&grant_type=password&username=store-admin&password=store-admin`; `owner` also needs
  `otp=<TOTP>`, see infra/keycloak/README.md) verified against JWKS, `staff_user` looked up, scope and every
  `x-permission` decided by OpenFGA (`OPENFGA_STORE_ID` from `pnpm --filter @platform/auth-sdk fga:seed`; missing
  → production refuses to boot, locally real tokens answer 503 until set). Dev tokens are **opt-in**:
  `Authorization: Bearer dev:<keycloak_subject>` (seeded subjects `seed-owner`, `seed-finance`, `seed-operations`,
  `seed-store-admin`, `seed-store-staff`, `seed-support`, `seed-analyst`) only when `CORE_DEV_TOKENS=1` is set in
  `.env`, never in production (`NODE_ENV=production` refuses before the flag); they use the `role_assignment` stub
  and need no OpenFGA. Store API: `X-Publishable-Key: pk_brand-a_dev_00000000000000000000`; with
  `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` (explicit opt-in, refused in production) every Store API path the core does not
  implement is proxied to the Prism mock.
- `pnpm --filter @platform/core build` — `medusa build` → `.medusa/server`; `pnpm --filter @platform/core start`.
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core` before finishing any task. Running the
  package scripts directly (`pnpm --filter @platform/core typecheck|test`) needs the workspace packages built first
  (`pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`);
  turbo does that for the root commands. Remove `apps/core/.medusa` before the root gates until #72 lands.

## Public API

- HTTP: implements `packages/contracts/openapi/store-api.yaml` and `admin-api.yaml` exactly (registry + catalog
  routes in Phase 1; Store API 0.3.0 `currency` query and the cart operations since 2.1; shipping options, payment
  session, `POST …/complete` and `GET /store/orders/{orderId}` since 2.2 — the fallback proxy now covers only
  `/store/customers*`). Store API routes live in `src/http/store-routes.ts`, Admin API routes in `src/http/admin-routes.ts`; both are
  mounted ahead of Medusa (they win over Medusa's same-path routes, its key gate and its admin auth).
  Contract header `X-Publishable-Key`; errors `{ code, message, details }`. Response shapes are checked against the
  OpenAPI components in tests (`test/helpers/openapi.ts`).
- Every state change writes to `outbox` in the same transaction (`@platform/events` via `src/outbox/withEvents`);
  the relay (window 14, Phase 4) publishes. Never publish to the bus directly.
- Module layout: `src/modules/<name>/{index.ts,service.ts,README.md,*.test.ts}`; cross-module imports only via
  `index.ts`. See README.md "How a module gets a tenant client".
- HTTP layer (`src/http`, mounted by `mountCoreMiddleware` ahead of Medusa): request id → header alias →
  `/store` tenant context (`req.tenant`, 401) → Store API routes → optional Store API fallback proxy →
  `/admin` staff principal (`req.principal`, 401/503; `storeClientFor` 403 outside scope) → hq-rbac adapter →
  Admin API routes → `coreErrorHandler`. Route handlers are wrapped in `handle()` so `AppError` renders as the
  contract `{ code, message, details }`. `CORE_ORGANIZATION_ID` selects the organization (default: seeded HQ).
- Staff auth (`src/http/staff-auth.ts`): `KeycloakStaffTokenVerifier` (default, built by `buildStaffAuth()` in
  `src/server.ts`) = hq-rbac's `createStaffScopeMiddleware` over `@platform/auth-sdk`: JWT → `staff_user` →
  OpenFGA scope; the principal carries `scope: StaffScope` (+ the `fga` client). `composeStaffTokenVerifier`
  routes `dev:` tokens to `DevTokenVerifier` only with `CORE_DEV_TOKENS=1` outside production; everything else
  goes to Keycloak. Tests pass an explicit verifier to `mountCoreMiddleware(app, verifier, { fga, onRoleChange })`.
- Permissions: every Admin API route runs the `requirePermission(relation, objectFactory)` middleware
  (`src/http/permissions.ts`) with the `x-permission` read from `admin-api.yaml`. A principal with a `scope`
  (real token) is answered by OpenFGA through auth-sdk's `can()` (`store:*` = ListObjects; unreachable → 503 fail
  closed, 403 body carries `details: { relation, object }`); a dev-token principal uses the `role_assignment`
  stub per ADR 0002 (owner ⊇ all; `viewer` = any relation; org relations reach every store). auth-sdk's own
  `requirePermission` is a callable guard, not an Express handler — this file is the adapter. Request bodies are
  validated against the spec's `requestBody` schema (`src/http/openapi.ts`, yaml + ajv at runtime).
- hq-rbac (window 2, `src/modules/hq-rbac`, read-only for us) is mounted by `src/http/hq-rbac-adapter.ts`:
  `createHqRbac({ pool, fga, onRoleChange }).handle({ method, path, principal, scope, query, body, requestId })`
  with the principal/scope the middleware resolved (no second verification); `null` → `next()`.
- `src/bootstrap` (issue #8, verifier only): never writes. The Medusa mirror of stores/keys is **not needed**:
  carts bypass Medusa's cart module (decision 2026-09-08, `src/modules/cart/README.md`), so nothing of ours ever has
  to exist in schema `medusa`.
- Cart pricing seams (`src/modules/cart`): `setTaxCalculator()` (window 7, Stripe Tax #127) and
  `setShippingRateProvider()` (window 8, live rates #130) replace the `tax_rate` / `shipping_option` table defaults
  at boot; the module itself is never edited for that. Prices are tax-exclusive by default;
  `store.settings.tax.prices_include_tax` switches a store to contained tax (#221). Unit prices come through the
  `PriceResolver` seam (`setPriceResolver()`, #179 part 3): every line mutation re-prices the cart, and
  `completeCart` answers 409 `price_changed` (#228) instead of placing at a price the customer did not see.
- Boot-time registrations live in `src/wiring.ts` (`registerModuleSeams()`, called once by `createServer()`):
  `registerPaymentProviders()` (window 7), `registerCarrierProviders()` (window 8) and the cart's
  `priceListResolver` over window 9's `resolvePrices`, and `registerTaxProvider()` (window 7: table or Stripe Tax
  per `store.settings.tax`; identical to the built-in calculator with default settings). Plain registry writes —
  no I/O, no configuration read.
- Payment seam (`src/modules/checkout`): `setPaymentProvider()` registers window 7's `stripe` (#127) next to the
  built-in `manual` provider; `createSession` / `authorize` / `void` / `refund` exchange ids and amounts only (hosted
  fields — card data never reaches this process). Placement is one transaction; idempotency = `payment.idempotency_key`
  (stored as `<store_id>:<key>`: per store by construction).
- Order lifecycle (`src/modules/orders`): every status change goes through `transition()` (table-driven, one event
  each); windows 7 and 8 call `confirmOrder`, `markPayment*`, `markShipmentCreated`, `markShipped`, `markDelivered`,
  `markReturned`, `cancelOrder` with a scoped client + ids (idempotent on the target state). Edits before fulfilment
  recompute totals with the cart's `TaxCalculator` and leave money to window 7 (`order.metadata.edits`).
- Inventory (`src/modules/inventory`): `on_hand` changes only through `moveStock` (append-only `stock_movement` +
  one `stock.moved`); reservations are the placement stock check (`reserveForOrder` from the checkout, deterministic
  lock order variant → warehouse priority → code), released by the orders module's cancel, consumed by window 8 via
  `consumeForShipment`. A reservation is never a movement.
- Returns (`src/modules/returns`): request → receive (order returned quantities + restock of resellable goods +
  `return.received`) → refund through the `RefundRequester` seam (`setRefundRequester`; manual default calls
  `PaymentProvider.refund`, no refund row — the `refund` table and `refund.*` events are window 7's; idempotent per
  return, key `return:<id>`). Exchange = return + linked order, no money coupling.
- Shipping (`src/modules/shipping`, window 8): `registerCarrierProviders()` installs the carrier-backed
  `ShippingRateProvider` at boot (live rates, falling back to the `shipping_option` table whenever a carrier cannot
  answer — an outage never stops a cart pricing). Shipments report facts to the orders module
  (`markShipmentCreatedInTx` on plan, `markShippedInTx` on despatch, `markDeliveredInTx` on delivery) and
  consume/release reservations through the inventory module; **fulfilment is recorded on despatch, not on plan**.
  Two mountable routers: `shippingWebhookRouter()` (raw body, per-store HMAC) and `shippingAdminRouter()`
  (spec-driven permissions).
- Fulfillment (`src/modules/fulfillment`, window 8): `requestFulfillment` routes an order to a warehouse and pushes
  it to that store's provider **outside** any transaction, with a compensating cancel that releases stock if the
  push fails; `cancelFulfillment` asks the provider first (refused after picking → 409); `applyFulfillmentUpdate`
  is idempotent. `setFulfillmentProvider` registers a real 3PL next to the built-in `memory` one.
- Abandoned carts (`src/modules/cart/abandoned.ts` + `src/jobs/abandoned-carts.ts`): a Medusa scheduled job
  (`default` handler + `config.schedule` from `CORE_ABANDONED_CART_CRON`, threshold `CORE_ABANDONED_CART_AFTER_HOURS`)
  runs one organization-scoped pass under `MEDUSA_WORKER_MODE = shared | worker`; a mutation reactivates an
  abandoned cart. **Every file in `src/jobs` must export Medusa's job contract** (`config` + `default`): the loader
  validates each file and refuses to boot otherwise.
- Window 8's port shapes (#191): `setFulfillmentStatusIn` (orders), `consumeReservationsForShipment` /
  `releaseReservationsForShipment` (inventory; idempotent per shipment). Catalog media functions `addMedia` /
  `updateMedia` / `deleteMedia` (#179 part 1) for window 9's pipeline.
- `payment.authorized` is emitted by `completeCart` next to `order.placed` (#176 part 2); `src/http/index.ts`
  exports `enumParam`/`sortParams` for other modules' route files (#181 part 2).
- Other modules' Admin routers mount through `src/http/module-routers.ts` (`moduleAdminRouters()`, after
  `adminRouter()`): window 9's `merchandisingRouter` (#162) and window 17's `marketingAdminRouter` (#181) are
  mounted, and since the quiet-state batch window 9's `mediaRouter` (#168), `pricingRouter` (#137) and
  `promotionsRouter` (#138 / #189), window 8's `shippingAdminRouter` (#131) and window 7's
  `paymentsAdminRouter` (#126, refunds); add one `routers.push(...)` line per new router. Nothing is pending.
- Provider webhooks mount through `moduleWebhookRouters()` (same file): outside the `/store` and `/admin` chains,
  before any JSON body parser, each router with its own `express.raw()` — the provider's signature over the raw
  body is the authentication. Mounted: window 7's `paymentsWebhookRouter` (`POST /webhooks/stripe/:storeCode`,
  #176 part 3) and window 8's `shippingWebhookRouter` (`POST /webhooks/easypost/:storeCode`, #131).
- Modules and helpers. Modules, `outbox`, `bootstrap` and `http` expose an `index.ts` public API and have their own
  tests; `lib` is a plain helper folder (imported by path, covered through the module and HTTP tests). Every folder
  has a `README.md`:

  | Folder                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                      | Events                                                                         | README                              |
  | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------- |
  | `src/modules/registry`    | stores, domains, locales, currencies, sales channels, API keys, warehouses/legal entities (read)                                                                                                                                                                                                                                                                                                             | `store.created`, `store.updated`                                               | `src/modules/registry/README.md`    |
  | `src/modules/catalog`     | categories, products, options, variants, media; Store API read model (price + availability)                                                                                                                                                                                                                                                                                                                  | `product.updated`, `product.published`, `product.archived`                     | `src/modules/catalog/README.md`     |
  | `src/modules/cart`        | Store API cart: create/read/update, line items, promotion codes (stored), totals through the tax + shipping provider seams; abandoned-cart marking with reactivation; bypasses Medusa's cart                                                                                                                                                                                                                 | `cart.abandoned`                                                               | `src/modules/cart/README.md`        |
  | `src/modules/checkout`    | shipping options, payment session (`PaymentProvider` seam, `manual` built in), placement as one transaction (order + lines + payment + attribution + cart completed), Store API order read                                                                                                                                                                                                                   | `order.placed` (+ `attribution.recorded` via src/lib/attribution)              | `src/modules/checkout/README.md`    |
  | `src/modules/orders`      | order state machine (`transition()` over the transition tables), wrappers for windows 7/8, cancel (payment void), edits before fulfilment, Store + Admin order reads, outbox projection/replay                                                                                                                                                                                                               | `order.confirmed`, `order.updated`, `order.cancelled`, `order.completed`       | `src/modules/orders/README.md`      |
  | `src/modules/inventory`   | levels per (variant, warehouse), `moveStock` (append-only ledger + `stock.moved`), reservations at placement / release on cancel / consume on shipment, Admin `listInventoryLevels` + `createStockMovement`                                                                                                                                                                                                  | `stock.moved`                                                                  | `src/modules/inventory/README.md`   |
  | `src/modules/returns`     | return lifecycle (`transitionReturn` over `RETURN_TRANSITIONS`), receive = order returned quantities + restock + refund seam, exchange link, Admin `createReturn` / `receiveReturn`, projection                                                                                                                                                                                                              | `return.requested`, `return.received`                                          | `src/modules/returns/README.md`     |
  | `src/jobs`                | Medusa scheduled jobs: `abandoned-carts.ts` (window 1; hourly, `cart.abandoned`) — every file here must export the job contract; window 9's reindex CLI lives in `src/modules/search/cli/index-products.ts`                                                                                                                                                                                                  | `cart.abandoned`                                                               | `src/modules/cart/README.md`        |
  | `src/modules/search`      | window 9 (search) — do not edit. Algolia index per store (records from the catalog read model, full reindex + incremental outbox sync, replicas for sort orders), merchandising rules and the product media pipeline; CLI `src/modules/search/cli/index-products.ts`                                                                                                                                         | reads `product.published`, `product.updated`, `product.archived` from `outbox` | `src/modules/search/README.md`      |
  | `src/modules/promotions`  | window 9 (search) — do not edit. Price lists (`resolvePrices`: sale > override/group > default, priority, windows, groups, tiers) and the promotion/coupon engine (`evaluatePromotions`: conditions, stacking/exclusion, per-line allocation); `promotionReportData` feeds window 17's `getPromotionReport`; Admin routers `pricingRouter` / `promotionsRouter` mounted through `src/http/module-routers.ts` | — (no price or promotion topics in the events contract)                        | `src/modules/promotions/README.md`  |
  | `src/modules/shipping`    | window 8 (shipping) — do not edit. Carrier providers (`manual` + EasyPost test mode), rate shopping behind the cart's `ShippingRateProvider`, shipments and their forward-only status machine, labels, the EasyPost tracking webhook (verify → record in `webhook_event` → apply), Admin `createShipment` / `updateShipment`                                                                                 | `shipment.created`, `shipment.shipped`, `shipment.delivered`                   | `src/modules/shipping/README.md`    |
  | `src/modules/fulfillment` | window 8 (shipping) — do not edit. The 3PL boundary: per-warehouse routing (store override → store default → same country → same region → priority), `FulfillmentProvider` (`push` / `status` / `cancel`) with an in-memory 3PL, request / cancel / apply-update with no database transaction held across a provider call                                                                                    | — (pick/pack events arrive with 2.5)                                           | `src/modules/fulfillment/README.md` |
  | `src/modules/hq-rbac`     | window 2 (auth) — do not edit                                                                                                                                                                                                                                                                                                                                                                                | —                                                                              | theirs                              |
  | `src/outbox`              | `withEvents` / `buildEvent` — the only writer of `outbox` (lint-enforced)                                                                                                                                                                                                                                                                                                                                    | —                                                                              | `src/outbox/README.md`              |
  | `src/bootstrap`           | read-only readiness verifier (CLI + server start)                                                                                                                                                                                                                                                                                                                                                            | —                                                                              | `src/bootstrap/README.md`           |
  | `src/http`                | middleware chain + Store/Admin API routes, staff auth (Keycloak + OpenFGA), permissions, hq-rbac adapter, Store API fallback proxy, OpenAPI validation                                                                                                                                                                                                                                                       | —                                                                              | `src/http/README.md`                |
  | `src/lib`                 | `db.ts` (only pool), `errors.ts` (`AppError`), `audit.ts` (`writeAudit`)                                                                                                                                                                                                                                                                                                                                     | —                                                                              | `src/lib/README.md`                 |

  Admin route permissions per operation are listed in the registry and catalog READMEs and come from `admin-api.yaml`.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code (dev-only fallbacks in `medusa-config.ts` throw in production). No PII in logs.
- Every DB access through `src/lib/db.ts` (`tenantClient` / `organizationClient` from `@platform/db`). `pg` is
  imported nowhere else. Services take a `ScopedClient` and run one transaction per use case.
- Medusa's own tables live in schema `medusa` (`databaseSchema` in `medusa-config.ts`); ours in `public` come from
  `packages/db` migrations only. Never add Medusa data models for contract entities.
- Update README.md and CHANGELOG.md with every change.

## Gotchas

- Node `>= 20.19` required: this app is CommonJS (Medusa) and `require()`s the ESM `@platform/*` packages. That
  needs a `default` (or `require`) condition in each package's export map (`@platform/db` / `@platform/events`
  have it since #40); a package with only `import` fails at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED` under
  tsx/`pnpm dev` even though `tsc` and Vitest are happy.
- `test/auth-live.test.ts` skips itself unless Keycloak (:8180) and OpenFGA (:8081) answer; it seeds a
  throw-away OpenFGA store and drops it afterwards. Real tokens come from the staff realm's dev-only `test-cli`
  password grant; `owner` needs the documented dev TOTP.
- `medusa-config.ts` and `scripts/*` load the repo-root `.env` through `loadDotenv()`; there is no `apps/core/.env`.
  The config uses loud placeholders for missing `DATABASE_URL_APP` / `REDIS_URL` so `medusa build` works without a
  database; `src/server.ts` refuses to start without them.
- Medusa migrations run in-process (`scripts/db-medusa-migrate.ts`) as role `medusa_owner` (owns schema `medusa`,
  no rights on ours). The script sets `TS_NODE_TRANSPILE_ONLY=1`: Medusa's loaders register ts-node (installed since
  #60) behind tsx, and without it ts-node type-checks tsx's transpiled `medusa-config.ts` and the run reports a
  failure after the migrations succeeded (Integration 1 finding, fixed in 2.1). Two Medusa traps this script works around: raw-SQL migrations follow `search_path`, not
  `databaseSchema` (pinned via `databaseDriverOptions`); and module migrations probe `information_schema` for
  `public.product` / `public."order"` as a v1-upgrade check — a role that cannot see our tables skips it. The
  `medusa` CLI itself needs `ts-node` for a TypeScript config, which this project does not install (tsx only).
- Database roles: `platform` (owner, packages/db migrations), `platform_app` (runtime, RLS-subject, also granted on
  `medusa.*`), `medusa_owner` (Medusa migrations only; has CREATE on the database because MikroORM's link-table
  DDL begins with `create schema if not exists`). Never point Medusa at `DATABASE_URL`.
- Medusa's link sync swallows errors (`executeWithConcurrency` returns settled promises) and still prints "Created
  following links tables": after `db:medusa:migrate`, check `medusa.link_module_migrations` has rows.
- `pnpm` ignores the build scripts of `esbuild`, `@medusajs/telemetry`, `@scarf/scarf`, `msgpackr-extract`,
  `protobufjs` (pnpm 10 default). Nothing here needs them; approving builds is a root-config decision (main window).
