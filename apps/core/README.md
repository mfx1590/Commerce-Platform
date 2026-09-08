# @platform/core

Medusa 2 commerce core (modular monolith) over the tenant-scoped schema in [`@platform/db`](../../packages/db/README.md).
Implements the Store API and Admin API of [`@platform/contracts`](../../packages/contracts/README.md) for the areas
window 1 owns (registry, catalog); everything else stays on the Prism mocks (`pnpm mock`). Owner: window 1 (core);
sub-folders under `src/modules/*` belong to windows 2, 7, 8, 9, 11, 13 per [docs/ownership.md](../../docs/ownership.md).

See [CLAUDE.md](./CLAUDE.md) for the exact run/test commands and rules.

## Quick start

```bash
pnpm dev                                        # repo root: docker stack, packages/db migrations, seed (once per machine)
pnpm --filter @platform/core db:medusa:migrate  # once: Medusa's own tables, schema `medusa` (owner role)
pnpm --filter @platform/core bootstrap          # readiness verifier: seed present, keys resolve, Medusa schema migrated
pnpm --filter @platform/core dev                # http://localhost:9000/health → 200 OK
```

Configuration comes from the repo-root `.env` (created from `.env.example` by `pnpm dev`): `DATABASE_URL_APP` for the
server, `DATABASE_URL` (owner) only to create the Medusa role and schema, `REDIS_URL`, optional `PORT` (9000),
`JWT_SECRET`, `COOKIE_SECRET`, `STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS`, `MEDUSA_DB_SCHEMA` (`medusa`),
`MEDUSA_DB_OWNER_PASSWORD` / `DATABASE_URL_MEDUSA_OWNER` (dev default `medusa_owner`; rotated from Vault elsewhere),
`KEYCLOAK_URL` / `KEYCLOAK_REALM_STAFF` and `OPENFGA_API_URL` / `OPENFGA_STORE_ID` / `OPENFGA_MODEL_ID` for the
Admin API's real staff auth (auth-sdk defaults: `http://localhost:8180`, `staff`, `http://localhost:8081`;
`OPENFGA_STORE_ID` is required in production and warns locally when missing), optional `CORE_DEV_TOKENS=1` to
also accept `Authorization: Bearer dev:<keycloak_subject>` (local only, never in production), and optional
`CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL` (explicit opt-in, refused in production) to proxy the Store API paths the core does not implement yet to
the Prism mock.

## What is real (Integration 1)

| Surface          | Real in `@platform/core`                                                                                                                                                                                       | Proxied / elsewhere                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Store API        | `GET /store`, `GET /store/categories`, `GET /store/products`, `GET /store/products/{handle}` — tenant from `X-Publishable-Key`, prices in the store currency                                                   | every other `/store/*` path → `CORE_STORE_API_FALLBACK_URL` verbatim (Prism mock, `:4010`); without the variable → Medusa |
| Admin API auth   | real Keycloak staff tokens (JWKS, `aud: core-api`) → `staff_user` → OpenFGA scope; `x-permission` decided by OpenFGA; dev tokens only with `CORE_DEV_TOKENS=1`                                                 | —                                                                                                                         |
| Admin API routes | `/admin/me`, stores, domains, sales channels, api keys, warehouses, legal entities, categories, products, variants (window 1) + `/admin/users*`, `/admin/audit-log`, `/admin/finance/ping` (hq-rbac, window 2) | every other `/admin/*` path → Medusa (clients use the Prism mock `:4011`)                                                 |

## One database, two schemas

| Schema   | Tables                                                                                     | Created by                                                                                            | Role at runtime                                                   |
| -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `public` | Ours: `store`, `product`, `outbox`, … (docs/domain.md), RLS **forced** on every table      | `pnpm db:migrate` (packages/db + packages/events migrations, owner role)                              | `platform_app` through `createTenantClient` — no context, no rows |
| `medusa` | Medusa's built-in modules (its own `product`, `store`, `api_key`, `sales_channel`, links…) | `pnpm --filter @platform/core db:medusa:migrate` as `medusa_owner`, a role that owns only this schema | `platform_app` via default privileges granted by the same script  |

Medusa never re-declares our tables: `medusa-config.ts` sets `databaseSchema: 'medusa'` **and** pins
`search_path` through `databaseDriverOptions` (Medusa's migrations are raw SQL with unqualified names; the
schema option alone let 24 Medusa tables land in `public` during task 1.1). Medusa migrates as `medusa_owner`
because several of its module migrations look for `public.product`, `public."order"`… as a Medusa-v1 upgrade
check; a role with no privileges on our tables does not see them in `information_schema`. Our data model is the
contract; Medusa's own tables carry only what Medusa itself needs to run (task 1.8 derives that, idempotently,
from the seeded rows).

## Server entry (`src/server.ts`)

`pnpm dev` runs `src/server.ts` with tsx instead of bare `medusa start`. It builds the Express app, mounts our
middleware first, then hands the app to Medusa's standard loaders (config, modules, `src/api` file routes,
workflows, subscribers, jobs). Express keeps registration order, so anything mounted before the loaders runs
ahead of Medusa's own `/store` publishable-key gate and `/admin` authentication:

1. `requestIdMiddleware` — `X-Request-Id` in (or generated) and out; lands in `audit_log.request_id`.
2. `GET /health` — liveness, no session, no database.
3. `aliasPublishableKeyHeader` — copies the contract header `X-Publishable-Key` to the header Medusa reads
   (`x-publishable-api-key`).
4. `/store` → `storeContextMiddleware`: `X-Publishable-Key` → sha256 → `store_api_key` (looked up under
   `CORE_ORGANIZATION_ID`, default the seeded HQ) → `req.tenant` with a store-scoped client and the store default
   currency. Missing, unknown or revoked key → `401 { code: "unauthorized" }`.
5. Store API routes window 1 owns (`src/http/store-routes.ts`, `mountStoreRoutes`): `GET /store`,
   `GET /store/categories`, `GET /store/products`, `GET /store/products/{handle}` — exactly the contract shapes,
   prices in the store default currency, query params validated (400 `validation_error`), 404 for a handle outside
   the store. They answer here, ahead of Medusa's routes of the same paths and of its publishable-key gate.
6. Store API fallback (`src/http/store-fallback.ts`, only with `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL`, refused unconditionally in
   production): every other `/store/*` request is proxied verbatim — method, path + query, headers
   (`X-Publishable-Key`, `Authorization`, `Idempotency-Key`, `Content-Type`, …), body — to that base URL with
   Node's `fetch`, and the upstream status, headers and body come back unchanged; one log line per request (method
   - path only). Unreachable upstream → 502 `internal`. Without the variable those paths fall through to Medusa.
7. `/admin` → `staffAuthMiddleware(verifier)`: bearer token → `req.principal` (`user`, `subject`,
   `organizationRelations`, `stores[]`, and for real tokens `scope: StaffScope` + the OpenFGA client). The default
   verifier (`buildStaffAuth()`): `composeStaffTokenVerifier(new KeycloakStaffTokenVerifier())` — a real
   staff-realm JWT goes through hq-rbac's `createStaffScopeMiddleware` (`@platform/auth-sdk`: JWKS of the staff
   realm, issuer + `aud: core-api`, `sub → staff_user`, OpenFGA `ListObjects(store, viewer)` +
   `ListRelations(organization:hq)`, cached ≤ 30 s and invalidated on role changes); unknown/disabled user or bad
   token → 401, OpenFGA unreachable → 503 (fail closed). `dev:<keycloak_subject>` reaches the Phase 1
   `DevTokenVerifier` **only when `CORE_DEV_TOKENS=1` is set and never in production**; any other bearer — a
   `dev:` token without the opt-in included — goes to Keycloak. Handlers take a client from
   `storeClientFor(principal, storeId)` (403 outside scope), `organizationClientFor` or `visibleStoresClientFor`.
8. hq-rbac adapter (`src/http/hq-rbac-adapter.ts`, window 2's module): `/admin/users`,
   `/admin/users/{userId}/roles`, `/admin/audit-log`, `/admin/finance/ping` — `createHqRbac(...).handle()` gets
   the principal and scope resolved in step 7 (no second token verification) and re-checks its permissions
   against OpenFGA itself; `null` means "not mine" and the request continues.
9. Admin API routes window 1 owns (`src/http/admin-routes.ts`, `adminRouter`): `/admin/me`, `/admin/stores`
   (list/create/get/patch), domains, sales channels, api keys, `/admin/warehouses`, `/admin/legal-entities`,
   categories, products (list/create/get/patch/archive/publish), variants. Each handler: JSON body validated against
   the operation's `requestBody` schema **read from `admin-api.yaml` at runtime** (400 `validation_error`, per-field
   `details`) → `requirePermission(relation, objectFactory)` middleware with the operation's `x-permission` —
   OpenFGA through auth-sdk's `can()` for real tokens (403 `forbidden` with `details: { relation, object }`, 503
   when OpenFGA is down), the `role_assignment` stub for dev tokens → scoped client → module service → contract
   shape. Every other `/admin` path falls through to Medusa (Prism mock for clients).
10. `coreErrorHandler` — renders `AppError` as `{ code, message, details }`; handlers wrap in `handle()`.
11. Medusa loaders.

`mountCoreMiddleware(app, verifier?, { fga?, onRoleChange?, storeApiFallbackUrl? })` exports exactly this chain
so tests run it on a bare Express app (`test/tenant-http.test.ts` with dev tokens, `test/auth-live.test.ts` with
real Keycloak tokens and a throw-away OpenFGA store).

`pnpm build` (`medusa build`) compiles to `.medusa/server` and works on a clean checkout (`ts-node` dev dependency,
#60; `medusa-config.ts` tolerates missing connection settings at build time); `pnpm start` runs the compiled entry.

## Module layout

```
src/
  server.ts                 entry (above)
  lib/db.ts                 the ONLY place that opens a database pool; exports tenantClient / organizationClient
  http/                     cross-cutting Express middleware (header alias, tenant context, errors)
  http/store-routes.ts      Store API handlers (contract routes), mounted ahead of Medusa by mountCoreMiddleware
  http/store-fallback.ts    opt-in (CORE_STORE_API_FALLBACK=1) proxy of unimplemented /store/* paths to CORE_STORE_API_FALLBACK_URL; never in production
  http/staff-auth.ts        KeycloakStaffTokenVerifier (auth-sdk + hq-rbac scope), DevTokenVerifier (opt-in), composition
  http/hq-rbac-adapter.ts   Express adapter of window 2's hq-rbac routes (principal + scope handed over, no re-verification)
  http/admin-routes.ts      Admin API router (contract routes): validate → requirePermission → client → service
  http/permissions.ts       requirePermission(relation, objectFactory) middleware + can() — OpenFGA for real tokens, role_assignment stub for dev tokens
  http/openapi.ts           runtime loader of the frozen OpenAPI docs: request-body validation, x-permission lookup
  modules/<name>/
    index.ts                public API of the module — the only file other code may import
    service.ts              use cases; every function takes a ScopedClient and runs in ONE transaction
    README.md               purpose, public API, events emitted, permissions, how to test
    *.test.ts               unit/integration tests on a throwaway database
  outbox/                   withEvents(tx, events[]) helper (task 1.5) — the only INSERT INTO outbox
  bootstrap/                verifyBootstrap(): read-only readiness checks (issue #8), run by the CLI and at server start
```

Cross-module imports go through `index.ts` only; other workspace packages only through `@platform/<name>`.

## How a module gets a tenant client

1. A request arrives. The tenant middleware resolves a `TenantContext` — `X-Publishable-Key` →
   `store_api_key` for the Store API; staff JWT → `staff_user` → `role_assignment` for the Admin API — and
   attaches `req.tenant`, a `ScopedClient` from `tenantClient(ctx)` (store scope) or `organizationClient(ctx)`
   (HQ scope, only after an organization-level permission check). No resolvable context → `401 { code: "unauthorized" }`.
2. The route handler passes that client to a module service: `registry.createStore(req.tenant, input)`.
3. The service does all its work inside `client.transaction(async (tx) => { ... })`: the state change, the
   `audit_log` row and the `outbox` rows (via `withEvents`) commit or roll back together. RLS is applied by
   Postgres because the client set `app.organization_id` / `app.store_ids` transaction-locally.
4. Nothing else opens a connection. `import pg` is allowed in `src/lib/db.ts` only; jobs and scripts build a
   client the same way with an explicit context.

In tests: `const db = await createTestDatabase()` from `@platform/db/testing`, then
`createTenantClient(db.app, { organizationId, storeIds: [storeA] })` — the `app` pool is the RLS-subject role.

## Scripts

| Command                                           | What it does                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm --filter @platform/core dev`                | tsx watch on `src/server.ts`, port 9000                                                               |
| `pnpm --filter @platform/core db:medusa:migrate`  | create schema `medusa` + default privileges, run Medusa migrations as `medusa_owner`, catch-up grants |
| `pnpm --filter @platform/core db:medusa:grants`   | only the grants (after a manual Medusa migration)                                                     |
| `pnpm --filter @platform/core bootstrap`          | readiness verifier (exit 1 with fixes when the database cannot serve the contract)                    |
| `pnpm --filter @platform/core build` / `start`    | `medusa build` → `.medusa/server`; run the compiled entry                                             |
| `pnpm --filter @platform/core typecheck` / `test` | `tsc --noEmit`; Vitest (needs Postgres, see `vitest.config.ts`)                                       |
