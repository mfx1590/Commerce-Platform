# @platform/core

## Purpose

Medusa 2 commerce core (modular monolith) over the tenant-scoped schema in `@platform/db`. Modules (planned):
registry, catalog, pricing, checkout, orders, inventory, fulfillment, customers, hq-rbac, hq-warehouse, payments,
tax, fraud, shipping, search, promotions. Phase 1 (window 1): registry + catalog, Store/Admin API routes for them.
Phase 2 (window 1): cart (2.1, done), checkout/placement (2.2, done), orders (2.3, done), inventory (2.4, done), returns (2.5),
`cart.abandoned` job (2.6); the Store API paths not yet implemented stay on the Prism mock behind the fallback proxy.

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
  at boot; the module itself is never edited for that. Prices are tax-exclusive in Phase 2.
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
- Other modules' Admin routers mount through `src/http/module-routers.ts` (`moduleAdminRouters()`, after
  `adminRouter()`): window 9's `merchandisingRouter` (#162) and window 17's `marketingAdminRouter` (#181) are
  mounted; add one `routers.push(...)` line per new router (`mediaRouter`, `pricingRouter`). `completeCart` emits
  `payment.authorized` next to `order.placed` (#176 part 2).
- Modules and helpers. Modules, `outbox`, `bootstrap` and `http` expose an `index.ts` public API and have their own
  tests; `lib` is a plain helper folder (imported by path, covered through the module and HTTP tests). Every folder
  has a `README.md`:

  | Folder                  | Purpose                                                                                                                                                                                                     | Events                                                                         | README                            |
  | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
  | `src/modules/registry`  | stores, domains, locales, currencies, sales channels, API keys, warehouses/legal entities (read)                                                                                                            | `store.created`, `store.updated`                                               | `src/modules/registry/README.md`  |
  | `src/modules/catalog`   | categories, products, options, variants, media; Store API read model (price + availability)                                                                                                                 | `product.updated`, `product.published`, `product.archived`                     | `src/modules/catalog/README.md`   |
  | `src/modules/cart`      | Store API cart: create/read/update, line items, promotion codes (stored), totals through the tax + shipping provider seams; bypasses Medusa's cart                                                          | — (`cart.abandoned` in 2.6)                                                    | `src/modules/cart/README.md`      |
  | `src/modules/checkout`  | shipping options, payment session (`PaymentProvider` seam, `manual` built in), placement as one transaction (order + lines + payment + attribution + cart completed), Store API order read                  | `order.placed` (+ `attribution.recorded` via src/lib/attribution)              | `src/modules/checkout/README.md`  |
  | `src/modules/orders`    | order state machine (`transition()` over the transition tables), wrappers for windows 7/8, cancel (payment void), edits before fulfilment, Store + Admin order reads, outbox projection/replay              | `order.confirmed`, `order.updated`, `order.cancelled`, `order.completed`       | `src/modules/orders/README.md`    |
  | `src/modules/inventory` | levels per (variant, warehouse), `moveStock` (append-only ledger + `stock.moved`), reservations at placement / release on cancel / consume on shipment, Admin `listInventoryLevels` + `createStockMovement` | `stock.moved`                                                                  | `src/modules/inventory/README.md` |
  | `src/modules/search`    | window 9 (search) — do not edit. Algolia index per store (records from the catalog read model, full reindex + incremental outbox sync, replicas for sort orders); job `src/jobs/index-products.ts`          | reads `product.published`, `product.updated`, `product.archived` from `outbox` | `src/modules/search/README.md`    |
  | `src/modules/hq-rbac`   | window 2 (auth) — do not edit                                                                                                                                                                               | —                                                                              | theirs                            |
  | `src/outbox`            | `withEvents` / `buildEvent` — the only writer of `outbox` (lint-enforced)                                                                                                                                   | —                                                                              | `src/outbox/README.md`            |
  | `src/bootstrap`         | read-only readiness verifier (CLI + server start)                                                                                                                                                           | —                                                                              | `src/bootstrap/README.md`         |
  | `src/http`              | middleware chain + Store/Admin API routes, staff auth (Keycloak + OpenFGA), permissions, hq-rbac adapter, Store API fallback proxy, OpenAPI validation                                                      | —                                                                              | `src/http/README.md`              |
  | `src/lib`               | `db.ts` (only pool), `errors.ts` (`AppError`), `audit.ts` (`writeAudit`)                                                                                                                                    | —                                                                              | `src/lib/README.md`               |

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
