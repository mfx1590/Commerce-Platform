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
pnpm --filter @platform/core dev                # http://localhost:9000/health → 200 OK
```

Configuration comes from the repo-root `.env` (created from `.env.example` by `pnpm dev`): `DATABASE_URL_APP` for the
server, `DATABASE_URL` (owner) only to create the Medusa role and schema, `REDIS_URL`, optional `PORT` (9000),
`JWT_SECRET`, `COOKIE_SECRET`, `STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS`, `MEDUSA_DB_SCHEMA` (`medusa`),
`MEDUSA_DB_OWNER_PASSWORD` / `DATABASE_URL_MEDUSA_OWNER` (dev default `medusa_owner`; rotated from Vault elsewhere).

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
   the store. They answer here, ahead of Medusa's routes of the same paths and of its publishable-key gate; every
   other Store API path falls through to Medusa (clients use the Prism mock for those in Phase 1).
6. `/admin` → `staffAuthMiddleware`: bearer token → `staff_user` → `role_assignment` → `req.principal`
   (`organizationRelations`, `stores[].relations`). Phase 1 verifier accepts `dev:<keycloak_subject>` outside
   production only; `@platform/auth-sdk` replaces it behind `StaffTokenVerifier`. Handlers take a client from
   `storeClientFor(principal, storeId)` (403 outside scope), `organizationClientFor` or `visibleStoresClientFor`.
7. Admin API routes window 1 owns (`src/http/admin-routes.ts`, `adminRouter`): `/admin/me`, `/admin/stores`
   (list/create/get/patch), domains, sales channels, api keys, `/admin/warehouses`, `/admin/legal-entities`,
   categories, products (list/create/get/patch/archive/publish), variants. Each handler: JSON body validated against
   the operation's `requestBody` schema **read from `admin-api.yaml` at runtime** (400 `validation_error`, per-field
   `details`) → `requirePermission(principal, relation, object)` with the operation's `x-permission` (403
   `forbidden`) → scoped client → module service → contract shape. Every other `/admin` path falls through to
   Medusa (Prism mock for clients in Phase 1).
8. `coreErrorHandler` — renders `AppError` as `{ code, message, details }`; handlers wrap in `handle()`.
9. Medusa loaders.

`mountCoreMiddleware(app)` exports exactly this chain so tests run it on a bare Express app (`test/tenant-http.test.ts`).

`pnpm build` (`medusa build`) compiles to `.medusa/server`; `pnpm start` runs the compiled entry.

## Module layout

```
src/
  server.ts                 entry (above)
  lib/db.ts                 the ONLY place that opens a database pool; exports tenantClient / organizationClient
  http/                     cross-cutting Express middleware (header alias, tenant context, errors)
  http/store-routes.ts      Store API handlers (contract routes), mounted ahead of Medusa by mountCoreMiddleware
  http/admin-routes.ts      Admin API router (contract routes): validate → requirePermission → client → service
  http/permissions.ts       requirePermission(principal, relation, object) — Phase 1 stub over role_assignment (ADR 0002)
  http/openapi.ts           runtime loader of the frozen OpenAPI docs: request-body validation, x-permission lookup
  modules/<name>/
    index.ts                public API of the module — the only file other code may import
    service.ts              use cases; every function takes a ScopedClient and runs in ONE transaction
    README.md               purpose, public API, events emitted, permissions, how to test
    *.test.ts               unit/integration tests on a throwaway database
  outbox/                   withEvents(tx, events[]) helper (task 1.5) — the only INSERT INTO outbox
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
| `pnpm --filter @platform/core build` / `start`    | `medusa build` → `.medusa/server`; run the compiled entry                                             |
| `pnpm --filter @platform/core typecheck` / `test` | `tsc --noEmit`; Vitest (needs Postgres, see `vitest.config.ts`)                                       |
