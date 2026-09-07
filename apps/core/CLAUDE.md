# @platform/core

## Purpose

Medusa 2 commerce core (modular monolith) over the tenant-scoped schema in `@platform/db`. Modules (planned):
registry, catalog, pricing, checkout, orders, inventory, fulfillment, customers, hq-rbac, hq-warehouse, payments,
tax, fraud, shipping, search, promotions. Phase 1 (window 1): registry + catalog, Store/Admin API routes for them;
everything else stays on the Prism mocks.

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
- Local Admin API calls in Phase 1: `Authorization: Bearer dev:<keycloak_subject>` (seeded subjects `seed-owner`,
  `seed-finance`, `seed-operations`, `seed-store-admin`, `seed-store-staff`, `seed-support`, `seed-analyst`);
  accepted only when `CORE_DEV_TOKENS=1` is set in `.env` (explicit opt-in), and never in production (`NODE_ENV=production` refuses before the flag). Store API: `X-Publishable-Key: pk_brand-a_dev_00000000000000000000`.
- `pnpm --filter @platform/core build` — `medusa build` → `.medusa/server`; `pnpm --filter @platform/core start`.
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core` before finishing any task. Running the
  package scripts directly (`pnpm --filter @platform/core typecheck|test`) needs the workspace packages built first
  (`pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`);
  turbo does that for the root commands. Remove `apps/core/.medusa` before the root gates until #72 lands.

## Public API

- HTTP: implements `packages/contracts/openapi/store-api.yaml` and `admin-api.yaml` exactly (registry + catalog
  routes in Phase 1). Store API routes live in `src/http/store-routes.ts`, Admin API routes in `src/http/admin-routes.ts`; both are
  mounted ahead of Medusa (they win over Medusa's same-path routes, its key gate and its admin auth).
  Contract header `X-Publishable-Key`; errors `{ code, message, details }`. Response shapes are checked against the
  OpenAPI components in tests (`test/helpers/openapi.ts`).
- Every state change writes to `outbox` in the same transaction (`@platform/events` via `src/outbox/withEvents`);
  the relay (window 14, Phase 4) publishes. Never publish to the bus directly.
- Module layout: `src/modules/<name>/{index.ts,service.ts,README.md,*.test.ts}`; cross-module imports only via
  `index.ts`. See README.md "How a module gets a tenant client".
- HTTP layer (`src/http`, mounted by `mountCoreMiddleware` ahead of Medusa): request id → header alias →
  `/store` tenant context (`req.tenant`, 401) → `/admin` staff principal (`req.principal`, 401; `storeClientFor`
  403 outside scope) → `coreErrorHandler`. Route handlers are wrapped in `handle()` so `AppError` renders as the
  contract `{ code, message, details }`. `CORE_ORGANIZATION_ID` selects the organization (default: seeded HQ).
- Permissions: every Admin API route runs the `requirePermission(relation, objectFactory)` middleware
  (`src/http/permissions.ts`, the `@platform/auth-sdk` signature; `can(principal, relation, object)` answers the
  question) with the `x-permission` read from `admin-api.yaml`; Phase 1 stub over
  `role_assignment` per ADR 0002 (owner ⊇ all; `viewer` = any relation; org relations reach every store). Request
  bodies are validated against the spec's `requestBody` schema (`src/http/openapi.ts`, yaml + ajv at runtime).
- `src/bootstrap` (issue #8, verifier only): never writes; the Medusa mirror of stores/keys is deferred to the
  Phase 2 cart task (owner decision 2026-09-05).
- Modules and helpers. Modules, `outbox`, `bootstrap` and `http` expose an `index.ts` public API and have their own
  tests; `lib` is a plain helper folder (imported by path, covered through the module and HTTP tests). Every folder
  has a `README.md`:

  | Folder                 | Purpose                                                                                          | Events                                                     | README                           |
  | ---------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------- |
  | `src/modules/registry` | stores, domains, locales, currencies, sales channels, API keys, warehouses/legal entities (read) | `store.created`, `store.updated`                           | `src/modules/registry/README.md` |
  | `src/modules/catalog`  | categories, products, options, variants, media; Store API read model (price + availability)      | `product.updated`, `product.published`, `product.archived` | `src/modules/catalog/README.md`  |
  | `src/modules/hq-rbac`  | window 2 (auth) — do not edit                                                                    | —                                                          | theirs                           |
  | `src/outbox`           | `withEvents` / `buildEvent` — the only writer of `outbox` (lint-enforced)                        | —                                                          | `src/outbox/README.md`           |
  | `src/bootstrap`        | read-only readiness verifier (CLI + server start)                                                | —                                                          | `src/bootstrap/README.md`        |
  | `src/http`             | middleware chain + Store/Admin API routes, permissions, OpenAPI validation                       | —                                                          | `src/http/README.md`             |
  | `src/lib`              | `db.ts` (only pool), `errors.ts` (`AppError`), `audit.ts` (`writeAudit`)                         | —                                                          | `src/lib/README.md`              |

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

- Node `>= 20.19` required: this app is CommonJS (Medusa) and `require()`s the ESM `@platform/*` packages.
- `medusa-config.ts` and `scripts/*` load the repo-root `.env` through `loadDotenv()`; there is no `apps/core/.env`.
  The config uses loud placeholders for missing `DATABASE_URL_APP` / `REDIS_URL` so `medusa build` works without a
  database; `src/server.ts` refuses to start without them.
- Medusa migrations run in-process (`scripts/db-medusa-migrate.ts`) as role `medusa_owner` (owns schema `medusa`,
  no rights on ours). Two Medusa traps this script works around: raw-SQL migrations follow `search_path`, not
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
