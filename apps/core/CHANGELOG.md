# Changelog — @platform/core

## Unreleased — Phase 1 (window 1, contracts-v0.2)

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
