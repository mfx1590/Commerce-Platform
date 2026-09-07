# Memory 1 — Core commerce
Window: 1 · Key: `core` · Branch prefix: `core/` · Model: Fable (owner decision 2026-09-04)
Last updated: 2026-09-05 · Contracts: contracts-v0.2 (0.2.0 = additive sort/order on Admin list operations) · Branch: `core/phase1` only (folded back) · Status: 1.1 merged (#49); 1.2–1.7 in ONE PR from `core/phase1` (manager reviews 1.7 there); then 1.8 (verifier), 1.9, sort/order follow-up

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
- [x] **1.9 READMEs + CLAUDE.md + tests green (issue #9)** — 2026-09-07, commits `b31eba8` + the #79 review fix-up (module-boundary lint/guard, CLAUDE.md wording, memory cleanup), PR #79. `src/http/README.md`, `src/lib/README.md`, CLAUDE.md module table + build-first note; 65 tests green on the merged tree.
- [x] **1.8 Bootstrap verifier (issue #8, re-scoped) + ts-node (#60)** — 2026-09-06, on `core/phase1` after #61 (`e9b5970`) merged; commit `fc55006` (+ follow-up for the `.medusa` lint ignore), PR #71. Read-only readiness checks + CLI + server-start hook; no Medusa-side rows. `medusa build` verified on this tree.
- [x] **1.7 Admin API routes (issue #7)** — 2026-09-05, commit `a1c39ee` on `core/phase1` (replayed from `b719c0a`; memory follow-up `d124fa1`; originally PR #58, closed for the single-branch flow). Delivered: `src/http/{admin-routes,permissions,openapi,query}.ts`, registry `listWarehouses`/`listLegalEntities`, `@platform/auth-sdk` workspace dep (#48), `test/admin-api.test.ts` (6 cases, spec-validated). Verified live through Medusa: `/admin/me`, finance 403, store-staff 400/201/403.
- [x] **1.6 Store API routes (issue #6)** — 2026-09-05, commit `b79c38a` on `core/phase1` (replayed from `d2bc35c`; originally PR #57, closed). Delivered: `src/http/store-routes.ts` (4 contract routes, mounted ahead of Medusa by `mountCoreMiddleware`), `StoreContext.defaultCurrency`, `test/helpers/openapi.ts` (Ajv over the frozen yaml), `test/store-api.test.ts` (contract replay + schema validation, 8 cases). Verified live through Medusa: `/store/products?limit=24` with the seeded brand-a key → 24 items, total 200 (issue #8's HTTP criterion already holds).
- [x] **1.5 Outbox helper hardened (issue #5)** — 2026-09-05, commit `e732ff4` on `core/phase1` (replayed from `ca6b5d3`; originally PR #54, closed; PR #53 had carried the 1.4 subject by mistake). Delivered: `src/outbox/{index,README}`, `outbox.test.ts` (rollback after insert, invalid envelope, all-validated-before-any-insert, create→publish order, headers), ESLint `no-restricted-syntax` on `INSERT INTO outbox` outside `src/outbox`, guard test for index-only imports.
- [x] **1.4 Catalog module (issue #4)** — 2026-09-05, commit `a5326d8` on `core/phase1` (replayed from `59d54da`; originally PR #52, closed). Delivered: `src/modules/catalog/{types,service,read-model,index}.ts` + README, 9 tests on the fully seeded DB (200 products listed, availability, event order create→publish, archive, 409s, scope). Publish does not require a variant (issue #5's "create then publish yields exactly product.updated then product.published" holds literally).
- [x] **1.3 Tenant context middleware (issue #3)** — 2026-09-05, commit `524ed5a` on `core/phase1` (replayed from `47efde4`; originally PR #51, closed). Delivered: `src/http/{request-id,tenant,staff-auth,errors,types,index}.ts`, `mountCoreMiddleware` in `src/server.ts`, `DevTokenVerifier` (Phase 1, non-production), `storeClientFor`/`organizationClientFor`/`visibleStoresClientFor`, `eslint.config.mjs` pg guard + `lint` script, `test/guards.test.ts`, `test/tenant-http.test.ts` (8 HTTP cases on a seeded DB). Verified live: server boots with the chain; `/store/*` without key → 401 ours, `/admin/*` without token → 401 ours.
- [x] **1.2 Registry module (issue #2)** — 2026-09-05, commit `1185b15` on `core/phase1` (replayed from `dbeb778`; originally PR #50, closed). Delivered: `src/modules/registry` (service over 0003: stores, domains, locales, currencies, sales channels, API keys; audit_log + `store.created|updated` in one transaction), `src/outbox/with-events.ts` first cut, `src/lib/{errors,audit}.ts`, README, 9 tests (RLS scope, one-primary/one-default, key hashing, rollback on invalid event).
- [x] **1.1 Medusa 2 boots in apps/core (issue #1)** — 2026-09-04, commit `e36b80e`, PR #49 **merged** (merge commit `a0c02c9`). Delivered: Medusa 2.20.1 project, `medusa-config.ts` (schema `medusa`, `databaseDriverOptions` search_path pin, Redis cache/event bus, admin off), `src/server.ts` custom entry with `/health` + `X-Publishable-Key` alias ahead of Medusa, `src/lib/db.ts` (initDb/tenantClient/organizationClient), `scripts/db-medusa-migrate.ts` (role `medusa_owner`), README/CLAUDE/CHANGELOG, 3 unit tests. Verified locally: `GET /health` 200; public schema untouched (42 tables), 145 Medusa tables in `medusa`. Side issue filed: #40 REQUEST default export condition.

## In progress
- **Phase 1 tasks 1.1–1.9 delivered** (2026-09-07). Only the sort/order follow-up remains (implemented and green locally, tag `core-sort-order`; pushed as one PR after #79 merges). Then Phase 2 waits for Memory-main.

## Next — Phase 1
- [ ] Follow-up (manager, contracts 0.2.0): `sort` + `order` query params on Admin API list handlers — `listStores` (code|name|status|created_at), `listProducts` (title|handle|status|created_at|updated_at); validate enum → 400; default per spec; `order` ignored without `sort`; tests + spec validation

## Decisions made (with reasons)
- 2026-09-04 · Medusa's own tables go in Postgres schema `medusa` (`projectConfig.databaseSchema`): Medusa's core modules declare `product`, `store`, `sales_channel`, `cart`, `order`… — the same names as our frozen schema in `public`. Our data stays in `packages/db` tables under RLS; Medusa's built-in tables carry no contract data in Phase 1.
- 2026-09-04 · Custom server entry (`src/server.ts`) instead of bare `medusa start`: Medusa's publishable-key middleware is applied to the whole `/store` namespace by the framework `ApiLoader` (no per-route opt-out), expects header `x-publishable-api-key` plus a row in Medusa's `api_key` table, and answers 400 `{type}` instead of the contract's 401 `{code}`. Middleware mounted before Medusa's loaders runs first (Express order). Admin routes opt out of Medusa auth with `export const AUTHENTICATE = false` and use our `requirePermission` stub.
- 2026-09-05 · **Owner decision, supersedes the 2026-09-04 mirror plan:** the Medusa mirror (our stores → Medusa sales channels + publishable keys) is **deferred to the Phase 2 cart task**, where we decide whether carts use Medusa's cart module behind our contract routes or bypass Medusa's Store API entirely. Not built speculatively. Task 1.8 = idempotent fail-fast verifier only (no Medusa-side rows); the contract routes need nothing from Medusa because they answer ahead of its key gate (#57).
- 2026-09-04 · Medusa migrations run as a dedicated role `medusa_owner` (owns schema `medusa`, CREATE on the database, no rights on our tables), not as the owner role: Medusa module migrations probe `information_schema.tables` for `public.product`/`public."order"` (v1 upgrade check) and fail on ours; a role without privileges on them does not see them. Runtime stays `platform_app` (granted on `medusa.*` by default privileges).
- 2026-09-04 · `search_path` pinned via `projectConfig.databaseDriverOptions` (`searchPath` + `connection.options`): `databaseSchema` alone is not honoured by Medusa's raw-SQL migrations (24 tables leaked into `public` before this).
- 2026-09-04 · Workspace ESM packages are loaded from this CommonJS app with dynamic `import()` (`initDb()`), because their export maps lack a `default`/`require` condition → issue #40. `medusa-config.ts` stays free of `@platform/*` imports.
- 2026-09-05 · Admin API routes: `adminRouter` mounted ahead of Medusa (same reasons as the Store API). Permissions and request schemas come from `admin-api.yaml` itself at runtime (`src/http/openapi.ts`) so route code cannot drift from the contract; `requirePermission` is a Phase 1 stub over `role_assignment` per ADR 0002 (owner ⊇ all; store_staff ⊂ store_admin; org relations reach every store; `viewer` = any relation) behind the signature auth-sdk implements. Reads (`GET`) also go through the same permission check.
- 2026-09-05 · #40 landed on main (`default` export condition): the dynamic `import()` shims are replaced by static imports in the fold-back commit. `medusa-config.ts` still reads process.env only (the `medusa` CLI evaluates it on its own).
- 2026-09-05 · Dev tokens (`Bearer dev:<subject>`) require `CORE_DEV_TOKENS=1` (explicit opt-in) AND are refused unconditionally when `NODE_ENV=production`, checked before the flag (manager review of #61). `requirePermission(relation, objectFactory)` is the middleware signature from `packages/auth-sdk/CLAUDE.md`; `can(principal, relation, object)` + `assertPermission` back it; admin routes chain `permission(op)` → `body(op)` → handler.
- 2026-09-05 · Owner decision (task 1.7 go-ahead): the manager merges the stack in order — #49, #50, #51, #52, #54, #57, then 1.7 — each with a merge commit, so every PR reduces to its own task once its predecessor lands. Once the whole stack is merged: fold back onto a single `core/phase1` branch (`git merge main`) and continue with one PR per task from 1.8 (branch per task off `core/phase1`, PR base `main`). `yaml` + `ajv` are approved runtime deps of apps/core (request validation must match the frozen `admin-api.yaml` exactly). Issue #48 (auth-sdk + db as workspace dependencies) must be covered by one of the open PRs.
- 2026-09-05 · **PR flow (manager, Memory-main global gotchas; supersedes the stacked-branch idea):** one branch per window (`core/phase1`), one PR per task, merge commits; after a merge keep working on the same branch and open the next PR, which then contains only the new task. GitHub allows one open PR per branch, so wait for the merge before opening the next. Never stacked per-task branches. The stacked PRs #50–#58 were closed and their commits replayed onto `core/phase1` (local tags `core-task-1.x` keep the originals).
- 2026-09-05 · Registry services take a `ScopedClient` + `Actor` and own their transaction; the HTTP layer (1.6/1.7) only validates, resolves the client, calls, and renders `AppError` → contract `{ code, message, details }`. `withEvents` exists since 1.2 (task 1.5 adds README, guards, lint rule) so no mutation ever inserts into `outbox` directly. `writeAudit` is a local stub of the helper docs/domain.md assigns to window 2.
- 2026-09-05 · Our Store API contract routes are plain Express handlers mounted by `mountCoreMiddleware` AHEAD of Medusa (`src/http/store-routes.ts`), not Medusa file routes: Medusa registers its own `/store/products` routes and the loader's override order between project and core routes is not something to bet the contract on, and mounting first also means our tenant middleware — not Medusa's `api_key` table — is the key check for these routes. Consequence for 1.8: mirroring our keys into Medusa is no longer required for the contract routes (only for Medusa-internal needs, if any). Admin routes (1.7) can be Medusa file routes (`AUTHENTICATE = false`) or the same pattern — decide by the same test.
- 2026-09-04 · Medusa's post-migration scripts are skipped (`skipScripts: true`): they fork the `medusa` CLI, which needs ts-node; a fresh schema has nothing for them to patch.

## Blocked / waiting
- (none)

## Gotchas learned
- Medusa 2.20.1 requires Node `^20.19 || >=22.12` (it relies on `require(esm)`; our workspace packages are ESM-only). Local Node is 20.19.1: OK.
- Workspace packages export `dist/` only: build `@platform/db|events|contracts` before running core outside turbo.
- `.claude/CLAUDE.local.md` is gitignored (root .gitignore line 7); it is per-worktree and never committed.
- Seed script and RLS test already live in packages/db (Phase 0); Next items 1.3 and 1.8 are narrowed to issues #3 and #8.
- `gh pr close --delete-branch` deletes the LOCAL branch too (not only the remote): keep a tag or another ref on the commits first.
- Postgres is on **5433** (5432 belongs to another project on this machine); CI uses 5432. `vitest.config.ts` defaults to 5433, env wins.
- Medusa vs our migrations ordering: `pnpm db:migrate` (packages/db, owner) first, then `pnpm --filter @platform/core db:medusa:migrate`; they are independent schemas, but the Medusa script needs the `platform_app` role that 0001 creates.
- Medusa's link sync swallows errors (`executeWithConcurrency` → settled promises) and still logs "Created following links tables"; verify `medusa.link_module_migrations` has ~20 rows. The empty-message failure we hit was `permission denied for database` (MikroORM DDL begins with `create schema if not exists`).
- Medusa runs a "create defaults" workflow at boot (Medusa default store, sales channel, publishable key in `medusa.*`); task 1.8 must map ours onto that rather than fight it.
- `Error: Cannot find module 'ts-node'` printed once during `db:medusa:migrate` comes from the forked search-index child; harmless (the child still ran).
- Medusa's own `/admin` auth still answers `401 {"message":"Unauthorized"}` for paths we have not implemented as route files (e.g. `/admin/me` before 1.7): our middleware passed, Medusa's did not. Our route files must `export const AUTHENTICATE = false`.
- `apps/core/eslint.config.mjs` is only used by `pnpm --filter @platform/core lint`; ESLint 9 does not pick up nested flat configs from the root run, and the root config is main-window owned.
- Seed data already has one primary domain per store (`shop.<code>.local`), a `web` sales channel and one publishable key; tests that add domains/keys must count relative to that.
- Ajv: compiling an operation's `requestBody.schema` object standalone breaks its `#/components/...` refs (MissingRefError). Compile `{ $ref: '<docId>#/paths/<escaped path>/<method>/requestBody/content/application~1json/schema' }` instead (JSON-pointer escaping `~0`/`~1`).
- Never put JS with backticks inside a bash double-quoted `node -e "…"`: the shell runs the backticks as commands and silently mangles the edit. Write the script with the Write tool and run `node <file>`.
- `medusa build` leaves `apps/core/.medusa/server/**` (gitignored) which the ROOT `pnpm format:check` / `pnpm lint` still scan → REQUEST #72 (root ignore lists); until then `rm -rf apps/core/.medusa` before running the root gates. `apps/core/eslint.config.mjs` ignores it locally.
- `medusa build` evaluates `medusa-config.ts` through ts-node without a database: keep the config throw-free (loud placeholders) and enforce env in `src/server.ts`.
- Keycloak realm JSON changes (e.g. #65, conditional OTP) need `node infra/keycloak/reimport.mjs staff` + a Keycloak container restart, or `pnpm dev --reset` (wipes the shared Postgres volume — avoid while other windows run). Core Phase 1 tests do not touch Keycloak (dev tokens).
- Package-local `pnpm --filter @platform/core typecheck|test` fails with "Cannot find module @platform/auth-sdk" until the workspace packages are built (`pnpm turbo run build --filter=...`); the root turbo commands and CI build them first.
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
