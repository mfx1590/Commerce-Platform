# Memory 1 — Core commerce
Window: 1 · Key: `core` · Branch prefix: `core/` · Model: Fable (owner decision 2026-09-04)
Last updated: 2026-09-05 · Contracts: contracts-v0.1 · Last commit: task 1.3 (branch `core/phase1-t3`, PR open) · Status: 1.1–1.3 done (PRs #49, #50, next), task 1.4 next

## Identity (does not change)
Owned paths (write):
- `apps/core/**`
- `packages/db/** (via PR only, main window approves)`
Reads:
- packages/contracts
- packages/events
- docs/domain.md
Never touches:
- apps/admin
- apps/storefront*
- cms/
- infra/

## Mission — Phase 1 (Isolated modules)
Stand up Medusa 2 in apps/core: store & channel registry, catalog module, tenant-scoped data access through packages/db with RLS enforced on every query, outbox write on every state change, seed brands loading. Implement Store API and Admin API routes for registry and catalog exactly as in packages/contracts; everything else stays on the mock server.

## Done
- [x] **1.3 Tenant context middleware (issue #3)** — 2026-09-05, branch `core/phase1-t3` (stacked on 1.2), sha: see PR (recorded at next commit). Delivered: `src/http/{request-id,tenant,staff-auth,errors,types,index}.ts`, `mountCoreMiddleware` in `src/server.ts`, `DevTokenVerifier` (Phase 1, non-production), `storeClientFor`/`organizationClientFor`/`visibleStoresClientFor`, `eslint.config.mjs` pg guard + `lint` script, `test/guards.test.ts`, `test/tenant-http.test.ts` (8 HTTP cases on a seeded DB). Verified live: server boots with the chain; `/store/*` without key → 401 ours, `/admin/*` without token → 401 ours.
- [x] **1.2 Registry module (issue #2)** — 2026-09-05, branch `core/phase1-t2` (stacked on 1.1), commit `dbeb778`, PR #50. Delivered: `src/modules/registry` (service over 0003: stores, domains, locales, currencies, sales channels, API keys; audit_log + `store.created|updated` in one transaction), `src/outbox/with-events.ts` first cut, `src/lib/{errors,audit}.ts`, README, 9 tests (RLS scope, one-primary/one-default, key hashing, rollback on invalid event).
- [x] **1.1 Medusa 2 boots in apps/core (issue #1)** — 2026-09-04, commit `e36b80e`, PR #49. Delivered: Medusa 2.20.1 project, `medusa-config.ts` (schema `medusa`, `databaseDriverOptions` search_path pin, Redis cache/event bus, admin off), `src/server.ts` custom entry with `/health` + `X-Publishable-Key` alias ahead of Medusa, `src/lib/db.ts` (initDb/tenantClient/organizationClient), `scripts/db-medusa-migrate.ts` (role `medusa_owner`), README/CLAUDE/CHANGELOG, 3 unit tests. Verified locally: `GET /health` 200; public schema untouched (42 tables), 145 Medusa tables in `medusa`. Side issue filed: #40 REQUEST default export condition.

## In progress
- (nothing — next: task 1.4)

## Next — Phase 1 (GitHub issues #3–#9 are authoritative)
- [ ] 1.4 (#4) Catalog module: category tree, product/option/variant/media, Store API read model with price + availability
- [ ] 1.5 (#5) `src/outbox/withEvents(tx, events[])`: validator, rollback test, lint/grep guard on `INSERT INTO outbox`
- [ ] 1.6 (#6) Store API routes: `GET /store`, `/store/categories`, `/store/products`, `/store/products/{handle}`; contract test against the real server
- [ ] 1.7 (#7) Admin API routes with `requirePermission(relation, object)` stub, `/admin/me`, 400 validation_error
- [ ] 1.8 (#8) Bootstrap loader: seeded stores → Medusa sales channels + publishable keys (token = our plain key) so Medusa's gate accepts the contract key; `GET /store/products?limit=24` returns brand-a with total 200
- [ ] 1.9 (#9) READMEs + CLAUDE.md per module, CHANGELOG, CI green, Gotchas filled

## Decisions made (with reasons)
- 2026-09-04 · Medusa's own tables go in Postgres schema `medusa` (`projectConfig.databaseSchema`): Medusa's core modules declare `product`, `store`, `sales_channel`, `cart`, `order`… — the same names as our frozen schema in `public`. Our data stays in `packages/db` tables under RLS; Medusa's built-in tables carry no contract data in Phase 1.
- 2026-09-04 · Custom server entry (`src/server.ts`) instead of bare `medusa start`: Medusa's publishable-key middleware is applied to the whole `/store` namespace by the framework `ApiLoader` (no per-route opt-out), expects header `x-publishable-api-key` plus a row in Medusa's `api_key` table, and answers 400 `{type}` instead of the contract's 401 `{code}`. Middleware mounted before Medusa's loaders runs first (Express order). Admin routes opt out of Medusa auth with `export const AUTHENTICATE = false` and use our `requirePermission` stub.
- 2026-09-04 · Task 1.8 will mirror seeded stores → Medusa sales channels + publishable keys (token = our plain key) so Medusa's gate accepts the same key our tenant middleware validates; no second product generator.
- 2026-09-04 · Medusa migrations run as a dedicated role `medusa_owner` (owns schema `medusa`, CREATE on the database, no rights on our tables), not as the owner role: Medusa module migrations probe `information_schema.tables` for `public.product`/`public."order"` (v1 upgrade check) and fail on ours; a role without privileges on them does not see them. Runtime stays `platform_app` (granted on `medusa.*` by default privileges).
- 2026-09-04 · `search_path` pinned via `projectConfig.databaseDriverOptions` (`searchPath` + `connection.options`): `databaseSchema` alone is not honoured by Medusa's raw-SQL migrations (24 tables leaked into `public` before this).
- 2026-09-04 · Workspace ESM packages are loaded from this CommonJS app with dynamic `import()` (`initDb()`), because their export maps lack a `default`/`require` condition → issue #40. `medusa-config.ts` stays free of `@platform/*` imports.
- 2026-09-05 · One PR per task with a single `core/phase1` line: each task after 1.1 gets a stacked branch `core/phase1-t<N>` off the previous task's branch, PR against `main`; GitHub trims the diff as earlier PRs merge. `core/phase1` itself stays at the 1.1 head until #49 merges (pushing more to it would grow PR #49). After the manager merges, `git merge main` into the open task branches.
- 2026-09-05 · Registry services take a `ScopedClient` + `Actor` and own their transaction; the HTTP layer (1.6/1.7) only validates, resolves the client, calls, and renders `AppError` → contract `{ code, message, details }`. `withEvents` exists since 1.2 (task 1.5 adds README, guards, lint rule) so no mutation ever inserts into `outbox` directly. `writeAudit` is a local stub of the helper docs/domain.md assigns to window 2.
- 2026-09-04 · Medusa's post-migration scripts are skipped (`skipScripts: true`): they fork the `medusa` CLI, which needs ts-node; a fresh schema has nothing for them to patch.

## Blocked / waiting
- (none)

## Gotchas learned
- Medusa 2.20.1 requires Node `^20.19 || >=22.12` (it relies on `require(esm)`; our workspace packages are ESM-only). Local Node is 20.19.1: OK.
- Workspace packages export `dist/` only: build `@platform/db|events|contracts` before running core outside turbo.
- `.claude/CLAUDE.local.md` is gitignored (root .gitignore line 7); it is per-worktree and never committed.
- Seed script and RLS test already live in packages/db (Phase 0); Next items 1.3 and 1.8 are narrowed to issues #3 and #8.
- Postgres is on **5433** (5432 belongs to another project on this machine); CI uses 5432. `vitest.config.ts` defaults to 5433, env wins.
- Medusa vs our migrations ordering: `pnpm db:migrate` (packages/db, owner) first, then `pnpm --filter @platform/core db:medusa:migrate`; they are independent schemas, but the Medusa script needs the `platform_app` role that 0001 creates.
- Medusa's link sync swallows errors (`executeWithConcurrency` → settled promises) and still logs "Created following links tables"; verify `medusa.link_module_migrations` has ~20 rows. The empty-message failure we hit was `permission denied for database` (MikroORM DDL begins with `create schema if not exists`).
- Medusa runs a "create defaults" workflow at boot (Medusa default store, sales channel, publishable key in `medusa.*`); task 1.8 must map ours onto that rather than fight it.
- `Error: Cannot find module 'ts-node'` printed once during `db:medusa:migrate` comes from the forked search-index child; harmless (the child still ran).
- Medusa's own `/admin` auth still answers `401 {"message":"Unauthorized"}` for paths we have not implemented as route files (e.g. `/admin/me` before 1.7): our middleware passed, Medusa's did not. Our route files must `export const AUTHENTICATE = false`.
- `apps/core/eslint.config.mjs` is only used by `pnpm --filter @platform/core lint`; ESLint 9 does not pick up nested flat configs from the root run, and the root config is main-window owned.
- `tsx watch` keeps running after a boot crash; stop it before starting another `pnpm dev` (port 9000).
- pnpm installed two peer-variants of most `@medusajs/*` packages under `node_modules/.pnpm` (`…_9c4…` and `…_62c…`); Medusa resolves one; watch for duplicate-module bugs.
- Tenant middleware (1.3) chicken-and-egg: `store_api_key` is under RLS, so looking up a key needs an organization context before any context is known. Phase 1–3 has exactly one organization: resolve it from `CORE_ORGANIZATION_ID` (default `SEED_IDS.organization`) and look the key up with an organization-scoped client; the request then proceeds store-scoped.
- `@platform/contracts` `ErrorCode` includes `cart_completed` (not listed in the Error schema description); `src/lib/errors.ts` maps every code to a status.
- The local `platform` DB is shared with the other windows' worktrees: never `pnpm dev --reset` while they run; remove only what you created (schema `medusa` can be dropped and rebuilt safely).

## How to run & test this package
- Once per machine: `pnpm dev` (root; docker + `db:migrate` + `db:seed`), then `pnpm --filter @platform/core db:medusa:migrate`.
- Serve: `pnpm --filter @platform/core dev` → `curl -i http://localhost:9000/health` (200). Stop with Ctrl-C (tsx watch).
- Gates before every commit: `pnpm lint && pnpm format:check && pnpm --filter @platform/core typecheck && pnpm --filter @platform/core test` (root `pnpm typecheck`/`pnpm test` via turbo also build the workspace packages first).
- Formatting: `pnpm prettier --write "apps/core/**/*.{ts,md,json}"` (docs/** is excluded from prettier).

## Later phases (do not start until Memory-main says so)
### Phase 2 — Commerce complete, brand 1 live
Full order lifecycle (place, edit, cancel, split shipment, return, exchange), stock locations with reservations and backorders, as Medusa modules/workflows with compensation on failure, every transition emitting its event through the outbox.
- [ ] Cart module against contracts
- [ ] Order state machine + workflows with compensation
- [ ] Inventory levels per warehouse, reservations, backorders
- [ ] Returns and exchanges
- [ ] Events for every transition; replay test

### Phase 3 — Multi-store & HQ
Multi-store at scale: N stores with separate domains/settings, and the brand onboarding workflow (store, domain, CMS space, PSP account, search index, theme repo, default roles).
- [ ] Store settings per domain/locale/currency matrix
- [ ] Onboarding workflow module (idempotent steps)
- [ ] Cross-store customer identity link table
